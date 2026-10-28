const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
try { dns.setDefaultResultOrder('ipv4first'); } catch { /* node < 17 */ }

const API_ORIGIN = 'https://ed.weeeg.com';
const SECRET_PATH = path.join(__dirname, '.yidian-secret');
const DEFAULTS = {
  shopId: '',
  trialGoodsId: '',
  formalGoodsIds: [],
};
const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const OUTAGE_ALERT_AFTER_MS = 15 * 60 * 1000;

let cachedLogin = { token: '', at: 0 };
const alertedKeys = new Set();
const sendFailCounts = new Map();
const manualInFlight = new Set();
let pollFailStartedAt = 0;
let yidianDispatcher;
try {
  const { Agent } = require('undici');
  yidianDispatcher = new Agent({
    connectTimeout: 20000,
    headersTimeout: 25000,
    bodyTimeout: 30000,
    keepAliveTimeout: 10000,
    connect: { timeout: 20000, family: 4 },
  });
} catch {
  yidianDispatcher = null;
}

function secret() {
  if (!fs.existsSync(SECRET_PATH)) {
    fs.writeFileSync(SECRET_PATH, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 });
  }
  return fs.readFileSync(SECRET_PATH);
}
function encrypt(value) {
  if (!value) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secret(), iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((x) => x.toString('base64url')).join('.');
}
function decrypt(value) {
  if (!value) return '';
  const [a, b, c] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', secret(), Buffer.from(a, 'base64url'));
  decipher.setAuthTag(Buffer.from(b, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(c, 'base64url')), decipher.final()]).toString('utf8');
}
function parseFormalIds(raw) {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
function accountConfig(db) {
  const row = db.prepare('SELECT * FROM yidian_config WHERE id=1').get();
  return {
    account: row.account || '',
    hasPassword: Boolean(row.encrypted_password),
    lastPollAt: row.last_poll_at || '',
    lastError: row.last_error || '',
  };
}
function stockOfShop(db, shopRowId) {
  return {
    trial: db.prepare("SELECT count(*) AS n FROM license_keys WHERE license_type='trial' AND status='active' AND IFNULL(xianyu_order_id,'')='' AND IFNULL(activated_at,'')='' AND yidian_shop_id=?").get(shopRowId).n,
    formal: db.prepare("SELECT count(*) AS n FROM license_keys WHERE license_type='formal' AND status='active' AND IFNULL(xianyu_order_id,'')='' AND IFNULL(activated_at,'')='' AND yidian_shop_id=?").get(shopRowId).n,
  };
}
function stockOf(db) {
  return {
    trial: db.prepare("SELECT count(*) AS n FROM license_keys WHERE license_type='trial' AND status='active' AND IFNULL(xianyu_order_id,'')='' AND IFNULL(activated_at,'')=''").get().n,
    formal: db.prepare("SELECT count(*) AS n FROM license_keys WHERE license_type='formal' AND status='active' AND IFNULL(xianyu_order_id,'')='' AND IFNULL(activated_at,'')=''").get().n,
  };
}
function shopPublic(db, row) {
  const stock = stockOfShop(db, row.id);
  return {
    id: row.id,
    name: row.name || row.shop_id,
    shopId: row.shop_id,
    trialGoodsId: row.trial_goods_id || '',
    formalGoodsIds: parseFormalIds(row.formal_goods_ids),
    enabled: Boolean(row.enabled),
    ignoreBefore: row.ignore_before || '',
    defaultNickname: row.default_nickname || '',
    defaultAgentId: row.default_agent_id ?? null,
    maxDevices: row.max_devices || 3,
    note: row.note || '',
    trialStock: stock.trial,
    formalStock: stock.formal,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function listShops(db) {
  return db.prepare('SELECT * FROM yidian_shops ORDER BY id DESC').all().map((row) => shopPublic(db, row));
}
function getShopRow(db, id) {
  return db.prepare('SELECT * FROM yidian_shops WHERE id=?').get(id);
}
function findShopByMember(db, shopId) {
  return db.prepare('SELECT * FROM yidian_shops WHERE shop_id=?').get(String(shopId || ''));
}
function coerceFormalIds(value, fallback) {
  if (typeof value === 'string') return value.split(/[\s,，]+/).map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return fallback;
}
function validateShopInput(input, current = {}) {
  const name = String(input.name ?? current.name ?? '').trim();
  const shopId = String(input.shopId ?? current.shop_id ?? '').trim();
  const trialGoodsId = String(input.trialGoodsId ?? current.trial_goods_id ?? '').trim();
  const formalGoodsIds = coerceFormalIds(input.formalGoodsIds, parseFormalIds(current.formal_goods_ids || '[]'));
  if (!name) throw Error('请填写店铺名称');
  if (!/^[\w-]+$/.test(shopId)) throw Error('店铺会员名无效');
  if (!/^\d+$/.test(trialGoodsId)) throw Error('试用商品 ID 无效');
  if (!Array.isArray(formalGoodsIds) || formalGoodsIds.length === 0 ||
      formalGoodsIds.some((v) => !/^\d+$/.test(String(v))) ||
      formalGoodsIds.map(String).includes(trialGoodsId)) throw Error('正式商品 ID 无效');
  const maxDevices = Math.max(1, parseInt(input.maxDevices ?? current.max_devices ?? 3, 10) || 3);
  const defaultAgentId = input.defaultAgentId == null || input.defaultAgentId === ''
    ? (current.default_agent_id ?? null)
    : parseInt(input.defaultAgentId, 10);
  return {
    name, shopId, trialGoodsId,
    formalGoodsIds: formalGoodsIds.map(String),
    defaultNickname: String(input.defaultNickname ?? current.default_nickname ?? '').trim(),
    defaultAgentId: Number.isFinite(defaultAgentId) ? defaultAgentId : null,
    maxDevices,
    note: String(input.note ?? current.note ?? '').trim(),
  };
}
function createShop(db, input) {
  const v = validateShopInput(input);
  const exists = db.prepare('SELECT id FROM yidian_shops WHERE shop_id=?').get(v.shopId);
  if (exists) throw Error('该店铺会员名已存在');
  const info = db.prepare(
    `INSERT INTO yidian_shops (name, shop_id, trial_goods_id, formal_goods_ids, enabled, ignore_before, default_nickname, default_agent_id, max_devices, note)
     VALUES (?, ?, ?, ?, 0, datetime('now','localtime'), ?, ?, ?, ?)`
  ).run(v.name, v.shopId, v.trialGoodsId, JSON.stringify(v.formalGoodsIds), v.defaultNickname, v.defaultAgentId, v.maxDevices, v.note);
  return shopPublic(db, getShopRow(db, info.lastInsertRowid));
}
function updateShop(db, id, input) {
  const row = getShopRow(db, id);
  if (!row) throw Error('店铺不存在');
  const v = validateShopInput(input, row);
  const clash = db.prepare('SELECT id FROM yidian_shops WHERE shop_id=? AND id!=?').get(v.shopId, id);
  if (clash) throw Error('该店铺会员名已存在');
  db.prepare(
    `UPDATE yidian_shops SET name=?, shop_id=?, trial_goods_id=?, formal_goods_ids=?, default_nickname=?, default_agent_id=?, max_devices=?, note=?, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(v.name, v.shopId, v.trialGoodsId, JSON.stringify(v.formalGoodsIds), v.defaultNickname, v.defaultAgentId, v.maxDevices, v.note, id);
  return shopPublic(db, getShopRow(db, id));
}
function setShopEnabled(db, id, enabled) {
  const row = getShopRow(db, id);
  if (!row) throw Error('店铺不存在');
  const on = enabled ? 1 : 0;
  db.prepare(
    `UPDATE yidian_shops SET enabled=?, ignore_before=CASE WHEN ?=1 AND IFNULL(ignore_before,'')='' THEN datetime('now','localtime') ELSE ignore_before END, updated_at=datetime('now','localtime') WHERE id=?`
  ).run(on, on, id);
  return shopPublic(db, getShopRow(db, id));
}
function deleteShop(db, id) {
  const row = getShopRow(db, id);
  if (!row) throw Error('店铺不存在');
  db.prepare('UPDATE license_keys SET yidian_shop_id=NULL WHERE yidian_shop_id=?').run(id);
  db.prepare('DELETE FROM yidian_shops WHERE id=?').run(id);
  return { id };
}
function config(db) {
  const account = accountConfig(db);
  const first = db.prepare('SELECT * FROM yidian_shops ORDER BY id ASC LIMIT 1').get();
  return {
    enabled: false,
    shopId: first ? first.shop_id : DEFAULTS.shopId,
    trialGoodsId: first ? first.trial_goods_id : DEFAULTS.trialGoodsId,
    formalGoodsIds: first ? parseFormalIds(first.formal_goods_ids) : DEFAULTS.formalGoodsIds,
    ignoreBefore: first ? first.ignore_before : '',
    ...account,
  };
}
function saveAccount(db, input) {
  const current = accountConfig(db);
  const password = typeof input.password === 'string' && input.password ? encrypt(input.password) : null;
  db.prepare(`UPDATE yidian_config SET enabled=0, account=?, encrypted_password=COALESCE(?, encrypted_password), updated_at=datetime('now','localtime') WHERE id=1`)
    .run(String(input.account ?? current.account).trim(), password);
  clearSession(db);
  return accountConfig(db);
}
function saveConfig(db, input) {
  saveAccount(db, input);
  return config(db);
}
function eligibleTrial(trial, now = Date.now()) {
  if (!trial || trial.status !== 'active' || trial.license_type !== 'trial') return false;
  if (!trial.activated_at) return true;
  const started = new Date(String(trial.activated_at).replace(' ', 'T')).getTime();
  return Number.isFinite(started) && now >= started && now < started + 86400000;
}
function formalExpiryFromTrial(trial) {
  if (!trial.activated_at) return '';
  const started = new Date(String(trial.activated_at).replace(' ', 'T')).getTime();
  if (!Number.isFinite(started)) throw Error('试用密钥激活时间无效');
  const end = new Date(started + 30 * 86400000);
  const p = (n) => String(n).padStart(2, '0');
  return `${end.getFullYear()}-${p(end.getMonth() + 1)}-${p(end.getDate())} ${p(end.getHours())}:${p(end.getMinutes())}:${p(end.getSeconds())}`;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function networkErrorMessage(err) {
  if (err && err.name === 'AbortError') return '易店助手请求超时';
  const code = err && err.cause && (err.cause.code || err.cause.errno);
  if (err && err.message === 'fetch failed') {
    return code ? `易店助手网络中断：${code}` : '易店助手网络中断';
  }
  return (err && err.message) || '易店助手请求失败';
}
function isRetryableNetwork(err) {
  const msg = String((err && err.message) || '');
  const name = (err && err.name) || '';
  const code = String((err && err.cause && (err.cause.code || err.cause.errno)) || '');
  return name === 'AbortError' || msg === 'fetch failed' || msg.includes('易店助手网络') || msg.includes('请求超时')
    || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR|ECONNREFUSED/.test(`${code} ${msg}`);
}
function isAuthError(err) {
  const msg = String((err && err.message) || '');
  return /HTTP 401|HTTP 403|请先登录|登录过期|登录失效|请重新登录|token.*(过期|无效|失效)|未授权|没有权限/.test(msg);
}
async function requestOnce(endpoint, { method = 'GET', token, body, params } = {}) {
  const url = new URL('/adminapi' + endpoint, API_ORIGIN);
  if (params) for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 20000);
  try {
    let response;
    try {
      response = await fetch(url, {
        method, signal: ctrl.signal,
        ...(yidianDispatcher ? { dispatcher: yidianDispatcher } : {}),
        headers: { 'Content-Type': 'application/json', ...(token ? { 'Authori-zation': `Bearer ${token}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw Error(networkErrorMessage(err));
    }
    if (!response.ok) throw Error(`易店助手 HTTP ${response.status}`);
    const data = await response.json();
    if (data.status !== 200) throw Error(data.msg || `易店助手业务状态 ${String(data.status || 'unknown')}`);
    return data.data;
  } finally { clearTimeout(timeout); }
}
async function request(endpoint, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase();
  const tries = opts.retries == null ? (method === 'GET' ? 3 : 1) : opts.retries;
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await requestOnce(endpoint, opts);
    } catch (err) {
      last = err;
      if (!isRetryableNetwork(err) || i === tries - 1) throw err;
      await sleep(1200 * (i + 1));
    }
  }
  throw last;
}
function loadSession(db) {
  if (cachedLogin.token && Date.now() - cachedLogin.at < SESSION_MAX_MS) return cachedLogin.token;
  let row;
  try {
    row = db.prepare('SELECT session_token, session_at FROM yidian_config WHERE id=1').get();
  } catch {
    return '';
  }
  if (!row || !row.session_token) return '';
  try {
    const token = decrypt(row.session_token);
    if (!token) return '';
    const at = row.session_at ? new Date(String(row.session_at).replace(' ', 'T')).getTime() : 0;
    if (!Number.isFinite(at) || Date.now() - at >= SESSION_MAX_MS) return '';
    cachedLogin = { token, at };
    return token;
  } catch {
    return '';
  }
}
function saveSession(db, token) {
  cachedLogin = { token, at: Date.now() };
  db.prepare(
    `UPDATE yidian_config SET session_token=?, session_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=1`
  ).run(encrypt(token));
}
function clearSession(db) {
  cachedLogin = { token: '', at: 0 };
  try {
    db.prepare(
      `UPDATE yidian_config SET session_token='', session_at='', updated_at=datetime('now','localtime') WHERE id=1`
    ).run();
  } catch { /* columns may not exist yet */ }
}
async function solveCaptcha() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let cap;
  try {
    const r = await fetch(API_ORIGIN + '/adminapi/captcha_pro', {
      signal: ctrl.signal, ...(yidianDispatcher ? { dispatcher: yidianDispatcher } : {}),
    });
    cap = await r.json();
  } finally { clearTimeout(timer); }
  if (!cap?.image || !cap?.key) throw Error('易店助手验证码获取失败');
  const b64 = String(cap.image).split(',').pop();
  const { execFileSync } = require('child_process');
  const out = JSON.parse(execFileSync('python3', [path.join(__dirname, 'yidian_auto_login.py'), b64], { timeout: 30000 }).toString());
  if (!out?.success || !out.code) throw Error('易店助手验证码识别失败');
  return { captcha: String(out.code).trim(), captchaKey: cap.key };
}
async function login(db) {
  const row = db.prepare('SELECT account, encrypted_password FROM yidian_config WHERE id=1').get();
  if (!row.account || !row.encrypted_password) throw Error('请先在后台填写易店助手账号和密码');
  let lastErr;
  for (let i = 0; i < 5; i += 1) {
    try {
      const { captcha, captchaKey } = await solveCaptcha();
      const result = await request('/yudian', { method: 'POST', retries: 2, body: {
        account: row.account, pwd: decrypt(row.encrypted_password), key: '', captchaVerification: '',
        smscode: '', smstoken: '', xyphone: '', xypwd: '', status: '', pcstatus: '', captcha, captchaKey,
      } });
      if (!result?.token) throw Error('易店助手未返回登录令牌，可能需要短信验证');
      saveSession(db, result.token);
      return result.token;
    } catch (err) {
      lastErr = err;
      if (!/验证码/.test(String(err?.message || ''))) throw err;
      await sleep(800);
    }
  }
  throw lastErr;
}
async function loginCached(db, force = false) {
  if (!force) {
    const token = loadSession(db);
    if (token) return token;
  }
  return login(db);
}
async function withSession(db, fn) {
  const token = await loginCached(db, false);
  try {
    return await fn(token);
  } catch (err) {
    if (!isAuthError(err)) throw err;
    clearSession(db);
    const fresh = await login(db);
    return fn(fresh);
  }
}
function normalizeOrder(row) {
  return {
    orderId: String(row.order_id || ''),
    buyerId: String(row.buyerId || ''),
    shopId: String(row.nick_id || ''),
    goodsId: String(row.goods_id || ''),
    pay: String(row.pay || row.money || ''),
    status: Number(row.order_status),
    payTime: String(row.pay_time || row.createTime || ''),
    createTime: String(row.createTime || ''),
    title: String(row.name || ''),
  };
}
async function listPending(token) {
  const data = await request('/home/xianyu_list', { token, params: {
    page: 1, limit: 50, status: 1, dianpuType: '', data: '', real_name: '', nick_id: '', field_key: '', type: '',
  } });
  const lists = Array.isArray(data?.lists) ? data.lists : [];
  return { count: Number(data?.count || lists.length), lists: lists.map(normalizeOrder) };
}

function productImageUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (/^https?:\/\//i.test(url)) return url;
  try { return new URL(url, API_ORIGIN).toString(); } catch { return ''; }
}

async function scanProducts(db) {
  return withSession(db, async (token) => {
    let shopAccounts = [];
    try {
      const rows = await request('/home/getdianpu', { token });
      shopAccounts = Array.isArray(rows) ? rows : [];
    } catch { /* order rows still contain the shop member name */ }
    const shopNames = new Map(shopAccounts.map((row) => [
      String(row.zhanghu || ''),
      String(row.name || row.display || row.zhanghu || ''),
    ]));
    const products = new Map();
    const limit = 100;
    let total = 0;
    let fetched = 0;
    for (let page = 1; page <= 20; page += 1) {
      const data = await request('/home/xianyu_list', { token, params: {
        page, limit, status: '', dianpuType: '', data: '', real_name: '',
        nick_id: '', field_key: '', type: '',
      } });
      const rows = Array.isArray(data?.lists) ? data.lists : [];
      total = Number(data?.count || total || rows.length);
      fetched += rows.length;
      for (const row of rows) {
        const goodsId = String(row.goods_id || '').trim();
        const shopId = String(row.nick_id || '').trim();
        if (!goodsId || !shopId) continue;
        const key = `${shopId}:${goodsId}`;
        const seenAt = String(row.pay_time || row.createTime || '');
        const current = products.get(key);
        if (current) {
          current.orderCount += 1;
          if (seenAt > current.lastSeenAt) current.lastSeenAt = seenAt;
          if (!current.image) current.image = productImageUrl(row.auctionPictUrl);
          if (!current.name) current.name = String(row.name || '').trim();
          continue;
        }
        products.set(key, {
          key, goodsId, shopId,
          shopName: shopNames.get(shopId) || shopId,
          name: String(row.name || '').trim() || `商品 ${goodsId}`,
          image: productImageUrl(row.auctionPictUrl),
          lastSeenAt: seenAt,
          orderCount: 1,
        });
      }
      if (!rows.length || fetched >= total) break;
    }
    const configuredShops = db.prepare('SELECT * FROM yidian_shops').all();
    const byMember = new Map(configuredShops.map((shop) => [shop.shop_id, shop]));
    const data = [...products.values()].map((product) => {
      const shop = byMember.get(product.shopId);
      const formalIds = shop ? parseFormalIds(shop.formal_goods_ids) : [];
      const configuredAs = !shop ? ''
        : (product.goodsId === shop.trial_goods_id ? 'trial'
          : (formalIds.includes(product.goodsId) ? 'formal' : ''));
      return {
        ...product,
        configuredAs,
        configured: Boolean(configuredAs),
        shopConfigured: Boolean(shop),
        shopRowId: shop?.id || null,
      };
    }).sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)));
    return { products: data, orderCount: total, shopAccounts };
  });
}

async function listRecentOrders(db, input = {}) {
  return withSession(db, async (token) => {
    const page = Math.max(1, Number(input.page) || 1);
    const limit = Math.min(50, Math.max(10, Number(input.limit) || 20));
    const status = input.status == null ? '' : String(input.status);
    const shopId = String(input.shopId || '').trim();
    const keyword = String(input.keyword || '').trim();
    const data = await request('/home/xianyu_list', { token, params: {
      page, limit, status, dianpuType: '', data: keyword, real_name: '',
      nick_id: shopId, field_key: '', type: '',
    } });
    const rows = Array.isArray(data?.lists) ? data.lists : [];
    return {
      count: Number(data?.count || rows.length),
      page,
      limit,
      rows: rows.map((row) => ({
        ...normalizeOrder(row),
        name: String(row.name || ''),
        image: productImageUrl(row.auctionPictUrl),
        quantity: Number(row.total_num || 1),
        buyerName: String(row.user_fullName || ''),
        sentAt: String(row.sendTime || ''),
      })),
    };
  });
}

function applyScannedProducts(db, items) {
  if (!Array.isArray(items) || items.length === 0) throw Error('请选择要添加的商品');
  const clean = items.map((item) => ({
    shopId: String(item.shopId || '').trim(),
    goodsId: String(item.goodsId || '').trim(),
    kind: String(item.kind || 'formal'),
  }));
  if (clean.some((item) => !/^[\w-]+$/.test(item.shopId) || !/^\d+$/.test(item.goodsId)
      || !['trial', 'formal'].includes(item.kind))) throw Error('商品数据无效');
  if (clean.filter((item) => item.kind === 'trial').length > 1) {
    throw Error('一次只能设置一个试用商品');
  }
  const update = db.transaction(() => {
    let changed = 0;
    for (const item of clean) {
      const shop = findShopByMember(db, item.shopId);
      if (!shop) throw Error(`店铺 ${item.shopId} 尚未在云看板创建`);
      if (item.kind === 'trial') {
        if (shop.trial_goods_id !== item.goodsId) {
          db.prepare("UPDATE yidian_shops SET trial_goods_id=?, updated_at=datetime('now','localtime') WHERE id=?")
            .run(item.goodsId, shop.id);
          changed += 1;
        }
        continue;
      }
      const ids = parseFormalIds(shop.formal_goods_ids);
      if (item.goodsId === shop.trial_goods_id || ids.includes(item.goodsId)) continue;
      ids.push(item.goodsId);
      db.prepare("UPDATE yidian_shops SET formal_goods_ids=?, updated_at=datetime('now','localtime') WHERE id=?")
        .run(JSON.stringify(ids), shop.id);
      changed += 1;
    }
    return changed;
  });
  return { changed: update(), shops: listShops(db) };
}

function replaceShopProducts(db, id, input = {}) {
  const shop = getShopRow(db, id);
  if (!shop) throw Error('店铺不存在');
  const formalGoodsIds = coerceFormalIds(input.formalGoodsIds, []);
  const trialGoodsId = String(input.trialGoodsId ?? shop.trial_goods_id ?? '').trim();
  if (!/^\d+$/.test(trialGoodsId)) throw Error('请选择一个试用商品');
  if (formalGoodsIds.some((value) => !/^\d+$/.test(value))) throw Error('正式商品数据无效');
  const unique = [...new Set(formalGoodsIds.map(String))].filter((value) => value !== trialGoodsId);
  db.prepare("UPDATE yidian_shops SET trial_goods_id=?, formal_goods_ids=?, updated_at=datetime('now','localtime') WHERE id=?")
    .run(trialGoodsId, JSON.stringify(unique), id);
  return shopPublic(db, getShopRow(db, id));
}
function inspectOrdersFromList(shops, pending) {
  const byMember = new Map(shops.map((s) => [s.shop_id, s]));
  return {
    count: pending.count,
    fieldNames: ['order_id', 'goods_id', 'buyerId', 'nick_id', 'money', 'pay', 'order_status', 'createTime', 'pay_time'],
    productFieldNames: ['goods_id'],
    shops: shops.map((s) => ({ id: s.id, name: s.name, shopId: s.shop_id, enabled: Boolean(s.enabled), ignoreBefore: s.ignore_before })),
    samples: pending.lists.slice(0, 8).map((row) => {
      const shop = byMember.get(row.shopId);
      const formalIds = shop ? parseFormalIds(shop.formal_goods_ids) : [];
      return {
        orderIdPresent: Boolean(row.orderId),
        buyerIdPresent: Boolean(row.buyerId),
        shopId: row.shopId,
        productId: row.goodsId,
        pay: row.pay,
        status: row.status,
        payTime: row.payTime,
        matchedShop: Boolean(shop),
        shopName: shop ? shop.name : '',
        shopEnabled: Boolean(shop && shop.enabled),
        skippedAsOld: Boolean(shop && shop.ignore_before && row.payTime && row.payTime <= shop.ignore_before),
        kind: !shop ? 'other' : (row.goodsId === shop.trial_goods_id ? 'trial' : (formalIds.includes(row.goodsId) ? 'formal' : 'other')),
      };
    }),
  };
}
async function inspectOrders(db) {
  const shops = db.prepare('SELECT * FROM yidian_shops').all();
  const pending = await withSession(db, (token) => listPending(token));
  let nativeAutoShipping = null;
  try {
    nativeAutoShipping = (await withSession(db, (token) => request('/home/yudian_config/edit_basics/0', { token })))?.list?.automatic_shipping;
  } catch (e) { /* ignore */ }
  return { ...inspectOrdersFromList(shops, pending), nativeAutoShipping };
}
function findUnusedKey(db, kind, shopRowId) {
  return db.prepare(
    `SELECT * FROM license_keys WHERE license_type=? AND status='active'
       AND IFNULL(xianyu_order_id,'')='' AND IFNULL(activated_at,'')='' AND yidian_shop_id=?
     ORDER BY id ASC LIMIT 1`
  ).get(kind, shopRowId);
}
function findBuyerTrial(db, buyerId, shopRowId) {
  return db.prepare(
    `SELECT * FROM license_keys WHERE license_type='trial' AND status='active' AND xianyu_buyer_id=?
       AND (yidian_shop_id=? OR yidian_shop_id IS NULL)
     ORDER BY CASE WHEN yidian_shop_id=? THEN 0 ELSE 1 END, id DESC LIMIT 1`
  ).get(buyerId, shopRowId, shopRowId);
}
function planOrder(db, shop, order) {
  const formalGoodsIds = parseFormalIds(shop.formal_goods_ids);
  const base = {
    orderId: order.orderId, buyerId: order.buyerId, shopId: order.shopId, shopName: shop.name,
    shopRowId: shop.id, shopEnabled: Boolean(shop.enabled),
    goodsId: order.goodsId, pay: order.pay, payTime: order.payTime,
  };
  if (!order.orderId || !order.buyerId || !order.goodsId) {
    return { ...base, action: 'skip_fields', reason: '订单缺少 order_id / buyerId / goods_id' };
  }
  if (order.shopId !== shop.shop_id) {
    return { ...base, action: 'skip_shop', reason: `店铺 ${order.shopId} 不匹配` };
  }
  if (order.status !== 1) {
    return { ...base, action: 'skip_status', reason: `订单状态 ${order.status}` };
  }
  if (shop.ignore_before && order.payTime && order.payTime <= shop.ignore_before) {
    return { ...base, action: 'skip_old', reason: `早于截止时间 ${shop.ignore_before}，历史单不处理` };
  }
  const existing = db.prepare('SELECT * FROM yidian_fulfillment WHERE order_id=?').get(order.orderId);
  if (existing && existing.status === 'sent') {
    return { ...base, action: 'already_sent', reason: '已发过，幂等跳过', keyId: existing.key_id, kind: existing.kind };
  }
  if (existing && existing.status === 'reserved') {
    const key = db.prepare('SELECT * FROM license_keys WHERE id=?').get(existing.key_id);
    return {
      ...base, action: existing.kind === 'trial' ? 'retry_trial' : 'retry_formal',
      reason: '已锁定库存，待补发', keyId: existing.key_id, keyCode: key ? key.key_code : '', kind: existing.kind,
    };
  }
  if (order.goodsId === shop.trial_goods_id) {
    const key = findUnusedKey(db, 'trial', shop.id);
    if (!key) return { ...base, action: 'need_trial_stock', reason: '试用密钥库存不足', kind: 'trial' };
    return withSwitch({ ...base, action: 'ship_trial', reason: '待发试用密钥', keyId: key.id, keyCode: key.key_code, kind: 'trial' });
  }
  if (formalGoodsIds.includes(order.goodsId)) {
    const trial = findBuyerTrial(db, order.buyerId, shop.id);
    if (eligibleTrial(trial)) {
      return withSwitch({
        ...base, action: 'upgrade_trial', reason: '24 小时内升级原试用密钥',
        keyId: trial.id, keyCode: trial.key_code, kind: 'formal',
        expiryDate: trial.activated_at ? formalExpiryFromTrial(trial) : '',
      });
    }
    const key = findUnusedKey(db, 'formal', shop.id);
    if (!key) return { ...base, action: 'need_formal_stock', reason: '正式密钥库存不足', kind: 'formal' };
    return withSwitch({
      ...base, action: 'ship_formal',
      reason: trial ? '试用已过期，发新正式密钥' : '直接购买正式，发新正式密钥',
      keyId: key.id, keyCode: key.key_code, kind: 'formal',
    });
  }
  return { ...base, action: 'skip_goods', reason: `商品 ${order.goodsId} 未配置` };
}
function withSwitch(plan) {
  if (plan.shopEnabled) return plan;
  return { ...plan, blockedBySwitch: true, reason: `${plan.reason}（店铺开关关闭）` };
}
function isShippable(plan) {
  return ['ship_trial', 'ship_formal', 'upgrade_trial', 'retry_trial', 'retry_formal'].includes(plan.action);
}
function logEvent(db, plan, extra = '') {
  db.prepare(
    `INSERT INTO yidian_events (order_id, buyer_id, goods_id, action, detail)
     VALUES (?, ?, ?, ?, ?)`
  ).run(plan.orderId || '', plan.buyerId || '', plan.goodsId || '', plan.action, extra || plan.reason || '');
}
function setPollMeta(db, error) {
  db.prepare(
    `UPDATE yidian_config SET last_poll_at=datetime('now','localtime'), last_error=?, updated_at=datetime('now','localtime') WHERE id=1`
  ).run(error ? String(error).slice(0, 300) : '');
}
function touchPoll(db) {
  db.prepare(
    `UPDATE yidian_config SET last_poll_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=1`
  ).run();
}
function expireStaleTrials(db) {
  const rows = db.prepare(
    `SELECT * FROM license_keys WHERE license_type='trial' AND status='active' AND IFNULL(activated_at,'')!=''`
  ).all();
  let n = 0;
  const now = Date.now();
  for (const row of rows) {
    if (eligibleTrial(row, now)) continue;
    db.prepare(
      `UPDATE license_keys SET status='disabled', note=TRIM(note || ' 试用超时停用'), updated_at=datetime('now','localtime') WHERE id=?`
    ).run(row.id);
    n += 1;
  }
  return n;
}
function messageFor(plan) {
  return `你的密钥是：${plan.keyCode}`;
}
async function sendKey(token, shop, order, plan) {
  const text = messageFor(plan);
  await request('/home/message_Send', {
    method: 'POST', token,
    body: { orderId: order.orderId, txt: text },
  });
  await request(`/home/xy_sendOrder/${encodeURIComponent(order.orderId)}`, {
    method: 'POST', token,
    body: {
      id: order.orderId,
      disk_type: 3,
      wp_txt: '',
      cdk_txt: '',
      xm_cdkname: '',
      is_show: 1,
      goods_id: order.goodsId || '',
      wp_start_name: '',
      cdk_start_name: '',
    },
  });
}
function reserve(db, order, plan) {
  const existing = db.prepare('SELECT * FROM yidian_fulfillment WHERE order_id=?').get(order.orderId);
  if (existing) return existing;
  const now = db.prepare("SELECT datetime('now','localtime') t").get().t;
  if (plan.action === 'upgrade_trial') {
    const expiry = plan.expiryDate || '';
    db.prepare(
      `UPDATE license_keys SET license_type='formal', valid_days=30, expiry_date=CASE WHEN ?!='' THEN ? ELSE expiry_date END,
         updated_at=? WHERE id=?`
    ).run(expiry, expiry, now, plan.keyId);
  } else {
    db.prepare(
      `UPDATE license_keys SET xianyu_buyer_id=?, xianyu_order_id=?, updated_at=? WHERE id=? AND IFNULL(xianyu_order_id,'')=''`
    ).run(order.buyerId, order.orderId, now, plan.keyId);
    const bound = db.prepare('SELECT xianyu_order_id FROM license_keys WHERE id=?').get(plan.keyId);
    if (!bound || bound.xianyu_order_id !== order.orderId) throw Error('锁定库存失败，可能并发抢占');
  }
  db.prepare(
    `INSERT INTO yidian_fulfillment (shop_id, order_id, buyer_id, goods_id, key_id, kind, status)
     VALUES (?, ?, ?, ?, ?, ?, 'reserved')`
  ).run(order.shopId, order.orderId, order.buyerId, order.goodsId, plan.keyId, plan.kind);
  return db.prepare('SELECT * FROM yidian_fulfillment WHERE order_id=?').get(order.orderId);
}
function markSent(db, orderId) {
  db.prepare(
    `UPDATE yidian_fulfillment SET status='sent', error_code='', sent_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE order_id=?`
  ).run(orderId);
}
function markFailed(db, orderId, err) {
  db.prepare(
    `UPDATE yidian_fulfillment SET status='reserved', error_code=?, updated_at=datetime('now','localtime') WHERE order_id=?`
  ).run(String(err).slice(0, 180), orderId);
}
async function fireAlert(onAlert, text) {
  if (!onAlert) return;
  try { await onAlert(text); } catch (e) { console.warn('[yidian alert]', e.message); }
}
async function alertOnce(onAlert, key, text) {
  if (!onAlert || alertedKeys.has(key)) return;
  alertedKeys.add(key);
  await fireAlert(onAlert, text);
}
async function alertRecovered(onAlert, key, text) {
  if (!alertedKeys.has(key)) return;
  alertedKeys.delete(key);
  await fireAlert(onAlert, text);
}
function clearAlert(key) {
  alertedKeys.delete(key);
}
async function readNativeAutoShipping(db) {
  const token = await loginCached(db);
  const basics = await request('/home/yudian_config/edit_basics/0', { token });
  return { token, automaticShipping: basics?.list?.automatic_shipping, list: basics?.list || {} };
}
async function disableNativeAutoShip(db) {
  const { token, list } = await readNativeAutoShipping(db);
  const payload = { ...list, type: 0, automatic_shipping: 0 };
  await request('/home/config/save_basics', { method: 'POST', token, body: payload });
  const after = await request('/home/yudian_config/edit_basics/0', { token });
  return { automaticShipping: after?.list?.automatic_shipping, saved: payload };
}
function planAll(db, shops, orders) {
  const byMember = new Map(shops.map((s) => [s.shop_id, s]));
  return orders.map((order) => {
    const shop = byMember.get(order.shopId);
    if (!shop) {
      return {
        orderId: order.orderId, buyerId: order.buyerId, shopId: order.shopId,
        goodsId: order.goodsId, pay: order.pay, payTime: order.payTime,
        action: 'skip_shop', reason: `店铺 ${order.shopId || '-'} 未在后台配置`,
      };
    }
    return planOrder(db, shop, order);
  });
}
async function tick(db, { ship = false, onAlert, logEvents = false } = {}) {
  const expired = expireStaleTrials(db);
  const account = accountConfig(db);
  const shops = db.prepare('SELECT * FROM yidian_shops').all();
  const stock = stockOf(db);
  if (!account.account || !account.hasPassword) {
    setPollMeta(db, '');
    return { ok: true, skipped: 'no_credentials', expired, stock, shops: listShops(db), plans: [] };
  }
  let pending;
  try {
    pending = await withSession(db, (token) => listPending(token));
  } catch (e) {
    if (!pollFailStartedAt) pollFailStartedAt = Date.now();
    setPollMeta(db, e.message);
    const lasted = Date.now() - pollFailStartedAt;
    if (lasted >= OUTAGE_ALERT_AFTER_MS) {
      await alertOnce(onAlert, 'poll', `易店助手拉单已持续失败 ${Math.floor(lasted / 60000)} 分钟：${e.message}`);
    }
    return { ok: false, error: e.message, expired, stock, shops: listShops(db), plans: [] };
  }
  await alertRecovered(onAlert, 'poll', '易店助手已恢复，现在可以正常拉单发货了');
  pollFailStartedAt = 0;
  const plans = planAll(db, shops, pending.lists);
  if (logEvents) {
    for (const plan of plans) logEvent(db, plan, ship ? 'live' : 'dry-run');
  }
  const needStock = plans.filter((p) => p.action === 'need_trial_stock' || p.action === 'need_formal_stock');
  if (needStock.length) {
    await alertOnce(onAlert, 'out-of-stock', `有 ${needStock.length} 笔订单缺库存，补货后仍未发出`);
  } else {
    clearAlert('out-of-stock');
  }

  const shopById = new Map(shops.map((s) => [s.id, s]));
  const results = [];
  if (ship) {
    let token = await loginCached(db);
    for (const plan of plans) {
      if (!isShippable(plan) || !plan.shopEnabled) { results.push(plan); continue; }
      if (manualInFlight.has(plan.orderId)) { results.push({ ...plan, action: 'skip_manual', reason: '手动发货进行中' }); continue; }
      const order = pending.lists.find((o) => o.orderId === plan.orderId);
      const shop = shopById.get(plan.shopRowId);
      try {
        const reserved = db.transaction(() => reserve(db, order, plan))();
        try {
          await sendKey(token, shop, order, { ...plan, keyId: reserved.key_id });
        } catch (sendErr) {
          if (!isAuthError(sendErr)) throw sendErr;
          token = await loginCached(db, true);
          await sendKey(token, shop, order, { ...plan, keyId: reserved.key_id });
        }
        markSent(db, order.orderId);
        sendFailCounts.delete(order.orderId);
        clearAlert('send-' + order.orderId);
        results.push({ ...plan, action: 'sent', fulfillmentId: reserved.id });
      } catch (e) {
        try { markFailed(db, order.orderId, e.message); } catch (_) { /* ignore */ }
        const n = (sendFailCounts.get(order.orderId) || 0) + 1;
        sendFailCounts.set(order.orderId, n);
        if (n >= 3) {
          await alertOnce(onAlert, 'send-' + order.orderId, `订单 ${order.orderId} 发货多次仍失败：${e.message}`);
        }
        results.push({ ...plan, action: 'send_failed', reason: e.message });
      }
    }
    setPollMeta(db, '');
    return { ok: true, live: true, expired, stock, shops: listShops(db), count: pending.count, plans: results };
  }
  setPollMeta(db, '');
  return {
    ok: true, live: false, expired, stock, shops: listShops(db), count: pending.count,
    plans,
    wouldShip: plans.filter((p) => isShippable(p) && p.shopEnabled && !p.blockedBySwitch).length,
    wouldShipIfOn: plans.filter((p) => isShippable(p)).length,
  };
}

function listShopKeys(db, shopRowId) {
  return db.prepare(
    `SELECT id, key_code, license_type, status, nickname, max_devices, note, created_at, xianyu_order_id, activated_at
     FROM license_keys WHERE yidian_shop_id=? ORDER BY id DESC LIMIT 300`
  ).all(shopRowId);
}
function parseImportCodes(text) {
  return String(text || '')
    .split(/[\s,;，；]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function replyArray(value) {
  if (Array.isArray(value)) return value.map(String).map((s) => s.trim()).filter(Boolean);
  return String(value || '').split(/[\s,;，；|]+/).map((s) => s.trim()).filter(Boolean);
}

async function listAutoReplies(db, input = {}) {
  return withSession(db, async (token) => {
    const params = {
      page: Math.max(1, Number(input.page) || 1),
      limit: Math.min(100, Math.max(1, Number(input.limit) || 20)),
      key: String(input.keyword || input.key || '').trim(),
      reply_type: input.replyType === '' || input.replyType == null ? '' : String(input.replyType),
      nick_id: String(input.shopId || input.nickId || '').trim(),
    };
    const [result, shopRows] = await Promise.all([
      request('/home/Storereply/list', { token, params }),
      request('/home/getdianpu', { token }).catch(() => []),
    ]);
    const shops = (Array.isArray(shopRows) ? shopRows : []).map((row) => ({
      shopId: String(row.zhanghu || ''),
      name: String(row.name || row.display || row.zhanghu || ''),
      display: String(row.display || `${row.name || row.zhanghu || ''}(${row.zhanghu || ''})`),
    })).filter((row) => row.shopId);
    return { list: Array.isArray(result?.list) ? result.list : [], count: Number(result?.count || 0), shops };
  });
}

async function getAutoReply(db, id) {
  id = Number(id);
  if (!Number.isInteger(id) || id <= 0) throw Error('回复规则 ID 无效');
  return withSession(db, (token) => request(`/home/Replyinfo/${id}`, { token, params: { id } }));
}

async function saveAutoReply(db, input = {}) {
  const id = Number(input.id) || 0;
  const replyType = [0, 1, 2].includes(Number(input.replyType)) ? Number(input.replyType) : 0;
  const type = [1, 2, 3].includes(Number(input.type)) ? Number(input.type) : 1;
  const keyword = replyType === 1 ? '首次回复' : String(input.keyword || '').trim();
  const replyTxt = String(input.replyText || input.replyTxt || '').trim();
  if (replyType === 0 && !keyword) throw Error('请输入关键词');
  if (type === 1 && !replyTxt) throw Error('请输入回复内容');
  const scope = Number(input.scope) === 1 ? 1 : 0;
  const nickIds = scope ? replyArray(input.shopIds || input.nickIds) : [];
  const goodsIds = scope ? replyArray(input.goodsIds) : [];
  if (scope && !nickIds.length && !goodsIds.length) throw Error('指定范围时至少选择一个店铺或商品');
  const payload = {
    keyword,
    type,
    reply_txt: replyTxt,
    image: String(input.image || ''),
    first: false,
    status: input.enabled === false || Number(input.status) === 0 ? 0 : 1,
    recommend_list: goodsIds.map((goodsId) => ({ goods_id: goodsId })),
    match: [0, 1, 2].includes(Number(input.match)) ? Number(input.match) : 1,
    system_message: input.systemMessage == null ? '' : input.systemMessage,
    reply_type: replyType,
    scope,
    nick_ids: nickIds,
    exclude_goods: replyArray(input.excludeGoods),
  };
  if (id) payload.id = id;
  return withSession(db, (token) => request(`/home/Replyadd/${id || 'undefined'}`, {
    method: 'POST', token, body: payload,
  }));
}

async function setAutoReplyStatus(db, id, enabled) {
  id = Number(id);
  if (!Number.isInteger(id) || id <= 0) throw Error('回复规则 ID 无效');
  const status = enabled ? 1 : 0;
  return withSession(db, (token) => request(`/home/set_status/${id}/${status}`, { method: 'PUT', token }));
}

async function deleteAutoReply(db, id) {
  id = Number(id);
  if (!Number.isInteger(id) || id <= 0) throw Error('回复规则 ID 无效');
  return withSession(db, (token) => request(`/home/Reply/delete/${id}`, { method: 'PUT', token }));
}


async function manualShip(db, orderId, keyInput) {
  orderId = String(orderId || '').trim();
  const raw = String(keyInput || '').trim();
  if (!orderId) throw Error('缺少订单号');
  if (!raw) throw Error('请输入密钥');
  const bare = raw.replace(/^#/, '');
  const key = db.prepare(`SELECT * FROM license_keys WHERE key_code=? OR key_code=? LIMIT 1`).get(bare, '#' + bare);
  if (!key) throw Error('密钥不存在：' + raw);
  if (key.status !== 'active') throw Error(`密钥状态为 ${key.status}，不能发货`);
  if (key.xianyu_order_id && key.xianyu_order_id !== orderId) throw Error(`该密钥已发给订单 ${key.xianyu_order_id}`);
  const done = db.prepare('SELECT * FROM yidian_fulfillment WHERE order_id=?').get(orderId);
  if (done && done.status === 'sent') throw Error('该订单已经发过货');
  if (manualInFlight.has(orderId)) throw Error('该订单正在发货中');
  manualInFlight.add(orderId);
  try {
  return withSession(db, async (token) => {
    const data = await request('/home/xianyu_list', { token, params: {
      page: 1, limit: 10, status: '', dianpuType: '', data: orderId, real_name: '', nick_id: '', field_key: '', type: '',
    } });
    const row = (Array.isArray(data?.lists) ? data.lists : []).find((r) => String(r.order_id) === orderId);
    if (!row) throw Error('在易店助手里找不到该订单');
    const order = normalizeOrder(row);
    if (order.status !== 1) throw Error(`订单当前状态 ${order.status}，不是待发货`);
    const now = db.prepare("SELECT datetime('now','localtime') t").get().t;
    const kind = key.license_type === 'trial' ? 'trial' : 'formal';
    db.prepare(`UPDATE license_keys SET xianyu_buyer_id=?, xianyu_order_id=?, updated_at=? WHERE id=?`)
      .run(order.buyerId, order.orderId, now, key.id);
    if (done) {
      db.prepare(`UPDATE yidian_fulfillment SET key_id=?, kind=?, status='reserved', updated_at=? WHERE order_id=?`)
        .run(key.id, kind, now, order.orderId);
    } else {
      db.prepare(`INSERT INTO yidian_fulfillment (shop_id, order_id, buyer_id, goods_id, key_id, kind, status) VALUES (?, ?, ?, ?, ?, ?, 'reserved')`)
        .run(order.shopId, order.orderId, order.buyerId, order.goodsId, key.id, kind);
    }
    const plan = { keyId: key.id, keyCode: key.key_code, kind, action: 'manual' };
    try {
      await sendKey(token, null, order, plan);
    } catch (err) {
      markFailed(db, order.orderId, err);
      throw err;
    }
    markSent(db, order.orderId);
    return { orderId: order.orderId, keyCode: key.key_code, kind, goodsId: order.goodsId, buyerId: order.buyerId };
  });
  } finally {
    setTimeout(() => manualInFlight.delete(orderId), 120000);
  }
}

module.exports = { manualShip,
  config, saveConfig, saveAccount, accountConfig, inspectOrders, login, request,
  eligibleTrial, formalExpiryFromTrial, DEFAULTS, tick, disableNativeAutoShip,
  readNativeAutoShipping, stockOf, stockOfShop, expireStaleTrials,
  listShops, createShop, updateShop, setShopEnabled, deleteShop, getShopRow, shopPublic,
  listShopKeys, parseImportCodes, findUnusedKey, scanProducts, applyScannedProducts,
  listRecentOrders, replaceShopProducts,
  listAutoReplies, getAutoReply, saveAutoReply, setAutoReplyStatus, deleteAutoReply,
};
