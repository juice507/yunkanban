// 密钥分发后台 API
// - /api/admin/*  管理端接口(Ant Design Pro 前端调用)
// - /api/client/*  客户端/插件调用的密钥校验接口
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const zlib = require("zlib");
const db = require("./db");
const telemetry = require('./deviceTelemetry');
telemetry.install(db);
const activity = require("./activity")(db);
const dingtalk = require("./dingtalk")((k) => getSetting(k));
let report;
report = require("./report")({ db, activity, getSetting: (k) => getSetting(k), dingtalk, UPLOAD_DIR: path.join(__dirname, "uploads"), pageUrl: (d) => reportPageUrl(d) });

// 日报网页版签名链接：不用登录就能看，有效期 3 天
function reportSign(day) {
  const key = getSetting("report_page_key") || (() => {
    const k = crypto.randomBytes(16).toString("hex");
    db.prepare("INSERT INTO settings (key,value) VALUES ('report_page_key',?) ON CONFLICT(key) DO UPDATE SET value=?").run(k, k);
    return k;
  })();
  return crypto.createHmac("sha256", key).update(String(day)).digest("hex").slice(0, 24);
}
function reportPageUrl(day) {
  return `https://sync-api.xircle.autos/report/${day}.html?k=${reportSign(day)}`;
}
// 通知：优先钉钉，没配钉钉时退回飞书
async function notifyAdmin(text) {
  if (dingtalk.config().enabled) {
    await dingtalk.markdown("工作台提醒", text);
    return;
  }
  await postFeishu({ msg_type: "text", content: { text } });
}
const { genKey } = require("./utils");
const yidian = require("./yidian");
const { sanitizeClsB64 } = require("./clsSanitize");

const app = express();
app.get("/report/:day.html", (req, res) => {
  const day = String(req.params.day || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(404).end();
  if (String(req.query.k || "") !== reportSign(day)) return res.status(403).send("链接无效或已过期");
  const now = Date.now();
  const ms = Date.parse(day + "T12:00:00+08:00");
  if (!Number.isFinite(ms) || ms - now > 86400000) return res.status(404).end();
  const offset = Math.max(0, Math.round((now - ms) / 86400000));
  if (offset > 3) return res.status(410).send("这份日报已过期，请查看最新的");
  const data = report.collect(offset);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(report.render(data).replace("</head>", '<meta name="viewport" content="width=device-width, initial-scale=1"><style>@media (max-width:940px){body{width:100%!important;min-width:0}}</style></head>'));
});
app.use(cors());
app.use(express.json({ limit: "8mb" }));

// ---------------------------------------------------------------------------
// 鉴权: 后台管理接口需要登录(客户端 verify、静态 uploads 公开)
//   登录密码存 settings.admin_password, 首次默认 jin10admin(登录后请改)
//   token = sha256(SECRET | 密码), 改密码即失效旧 token, 无需服务端存会话
//   登录成功后种 admin_gate Cookie 30 天, nginx 凭此跳过浏览器弹窗口令
// ---------------------------------------------------------------------------
const authSecretFile = path.join(__dirname, '.auth-secret');
const configuredAuthSecret = process.env.AUTH_SECRET || (fs.existsSync(authSecretFile) ? fs.readFileSync(authSecretFile, 'utf8').trim() : '');
if (!configuredAuthSecret) throw new Error('请配置 AUTH_SECRET 或 server/.auth-secret');
const AUTH_SECRET = "jin10-admin|" + configuredAuthSecret;
const GATE_COOKIE_NAME = "admin_gate";
const GATE_COOKIE_VALUE = crypto
  .createHmac("sha256", AUTH_SECRET)
  .update("admin-gate-v1-ykb")
  .digest("hex")
  .slice(0, 40);
const GATE_TTL_SEC = 30 * 24 * 60 * 60;
function gateCookieHeader(clear) {
  const base = `${GATE_COOKIE_NAME}=${clear ? "" : GATE_COOKIE_VALUE}; Path=/; HttpOnly; Secure; SameSite=Lax`;
  return clear ? `${base}; Max-Age=0` : `${base}; Max-Age=${GATE_TTL_SEC}`;
}
function attachGateCookie(res) {
  const cookie = gateCookieHeader(false);
  const prev = res.getHeader("Set-Cookie");
  if (!prev) res.setHeader("Set-Cookie", cookie);
  else if (Array.isArray(prev)) res.setHeader("Set-Cookie", prev.concat(cookie));
  else res.setHeader("Set-Cookie", [String(prev), cookie]);
}
function currentAdminToken() {
  const row = db.prepare("SELECT value FROM settings WHERE key='admin_password'").get();
  return crypto.createHash("sha256").update(AUTH_SECRET + "|" + (row ? row.value : "")).digest("hex");
}
function authGuard(req, res, next) {
  if (req.method === "OPTIONS") return next();
  const p = req.path;
  // 公开: 客户端校验、登录接口
  if (p.startsWith("/api/client/")) return next();
  if (p === "/api/admin/login" || p === "/api/admin/logout") return next();
  // 仅拦截管理端与上传
  if (!p.startsWith("/api/admin") && !p.startsWith("/api/upload")) return next();
  const auth = req.headers["authorization"] || "";
  const token = auth.replace(/^Bearer\s+/i, "").trim();
  if (token && token === currentAdminToken()) {
    attachGateCookie(res);
    return next();
  }
  return res.status(401).json({ success: false, needLogin: true, message: "未登录或登录已过期" });
}
app.use(authGuard);

// MoChat integration: same-host only, independent secret and expiry-only business surface.
const subscriptionBindings = new (require('better-sqlite3'))(__dirname + '/subscription-bindings.sqlite', {readonly:true});
app.use('/internal/subscription', (req,res,next) => {
  if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return res.status(403).json({error:'Local service only'});
  next();
}, require('./websiteSubscription')(db, subscriptionBindings, fs.readFileSync(__dirname+'/subscription-token','utf8').trim()));


// 管理员登录: 校验密码, 返回 bearer token, 并种 30 天门禁 Cookie(nginx 跳过弹窗)
app.post("/api/admin/login", (req, res) => {
  const { password } = req.body || {};
  const row = db.prepare("SELECT value FROM settings WHERE key='admin_password'").get();
  if (!password || String(password) !== (row ? row.value : "")) {
    return res.json({ success: false, message: "密码错误" });
  }
  attachGateCookie(res);
  res.json({ success: true, token: currentAdminToken(), expiresInDays: 30 });
});
app.post("/api/admin/logout", (_req, res) => {
  res.setHeader("Set-Cookie", gateCookieHeader(true));
  res.json({ success: true });
});

// 易店助手：共享账号 + 多店铺列表。发货由每家店自己的开关控制，总开关保持关闭不使用。
function yidianShopOr404(id, res) {
  const row = yidian.getShopRow(db, id);
  if (!row) { res.status(404).json({ success: false, message: '店铺不存在' }); return null; }
  return row;
}
function resolveDefaultAgentId(shop) {
  if (shop && shop.default_agent_id) return shop.default_agent_id;
  const a = db.prepare("SELECT id FROM agents WHERE name='程莉' LIMIT 1").get();
  return a ? a.id : null;
}
function defaultKeyAvatar() {
  const v = getSetting("default_avatar");
  if (v) return v;
  const row = db.prepare(
    "SELECT avatar FROM license_keys WHERE IFNULL(avatar,'')!='' ORDER BY id DESC LIMIT 1"
  ).get();
  return row ? row.avatar : "";
}
function shopKeyDefaults(shop) {
  const avatar = defaultKeyAvatar();
  const dc = getSetting('default_card_id');
  const cardId = dc ? parseInt(dc, 10) : null;
  return {
    nickname: (shop && shop.default_nickname) || "王子",
    avatar,
    cardId: Number.isFinite(cardId) ? cardId : null,
    agentId: resolveDefaultAgentId(shop),
    maxDevices: (shop && shop.max_devices) || 3,
  };
}
function genUniqueKeyCode() {
  for (let i = 0; i < 8; i++) {
    const code = genKey();
    if (!db.prepare('SELECT id FROM license_keys WHERE key_code = ?').get(code)) return code;
  }
  return null;
}
function insertShopStockKey(shop, kind, extra = {}) {
  const defaults = shopKeyDefaults(shop);
  const days = kind === 'trial' ? 1 : 30;
  const name = extra.name != null ? extra.name : '';
  const note = extra.note != null ? extra.note : '';
  const code = extra.keyCode || genUniqueKeyCode();
  if (!code) throw new Error('生成密钥失败,请重试');
  const info = db.prepare(
    `INSERT INTO license_keys (key_code, name, nickname, avatar, max_devices, expiry_date, valid_days, note, card_id, agent_id, license_type, yidian_shop_id)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?)`
  ).run(code, name, defaults.nickname, defaults.avatar, defaults.maxDevices, days, note, defaults.cardId, defaults.agentId, kind, shop.id);
  return info.lastInsertRowid;
}
app.get('/api/admin/yidian', (_req, res) => {
  res.json({
    success: true,
    account: yidian.accountConfig(db),
    shops: yidian.listShops(db),
    stock: yidian.stockOf(db),
    defaults: yidian.DEFAULTS,
  });
});
app.put('/api/admin/yidian', (req, res) => {
  try { res.json({ success: true, account: yidian.saveAccount(db, req.body || {}) }); }
  catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
app.post('/api/admin/yidian/shops', (req, res) => {
  try { res.json({ success: true, data: yidian.createShop(db, req.body || {}) }); }
  catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
app.put('/api/admin/yidian/shops/:id', (req, res) => {
  try { res.json({ success: true, data: yidian.updateShop(db, Number(req.params.id), req.body || {}) }); }
  catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
app.put('/api/admin/yidian/shops/:id/enabled', (req, res) => {
  try { res.json({ success: true, data: yidian.setShopEnabled(db, Number(req.params.id), Boolean(req.body?.enabled)) }); }
  catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
app.delete('/api/admin/yidian/shops/:id', (req, res) => {
  try { res.json({ success: true, data: yidian.deleteShop(db, Number(req.params.id)) }); }
  catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
app.get('/api/admin/yidian/shops/:id/keys', (req, res) => {
  const shop = yidianShopOr404(req.params.id, res);
  if (!shop) return;
  const rows = yidian.listShopKeys(db, shop.id).map((row) => ({
    id: row.id,
    keyCode: row.key_code,
    licenseType: row.license_type,
    status: row.status,
    nickname: row.nickname || '',
    maxDevices: row.max_devices,
    note: row.note || '',
    createdAt: row.created_at,
    used: Boolean(row.xianyu_order_id || row.activated_at),
    xianyuOrderId: row.xianyu_order_id || '',
    activatedAt: row.activated_at || '',
  }));
  res.json({ success: true, data: rows, shop: yidian.shopPublic(db, shop), defaults: shopKeyDefaults(shop) });
});
app.post('/api/admin/yidian/shops/:id/keys/generate', (req, res) => {
  const shop = yidianShopOr404(req.params.id, res);
  if (!shop) return;
  const trialTarget = Math.max(0, Math.min(200, parseInt(req.body?.trialCount, 10) || 0));
  const formalTarget = Math.max(0, Math.min(200, parseInt(req.body?.formalCount, 10) || 0));
  if (!trialTarget && !formalTarget) return res.status(400).json({ success: false, message: '请填写要补齐到的数量' });
  const stock = yidian.stockOfShop(db, shop.id);
  const trialNeed = Math.max(0, trialTarget - stock.trial);
  const formalNeed = Math.max(0, formalTarget - stock.formal);
  if (!trialNeed && !formalNeed) {
    return res.json({
      success: true, created: 0, trialNeed: 0, formalNeed: 0,
      shop: yidian.shopPublic(db, shop),
      message: `库存已齐，试用 ${stock.trial}、正式 ${stock.formal}`,
    });
  }
  const defaults = shopKeyDefaults(shop);
  const q = checkAgentQuota(defaults.agentId, trialNeed + formalNeed);
  if (!q.ok) return res.status(400).json({ success: false, message: q.msg });
  try {
    const created = db.transaction(() => {
      const ids = [];
      for (let i = 0; i < trialNeed; i++) ids.push(insertShopStockKey(shop, 'trial'));
      for (let i = 0; i < formalNeed; i++) ids.push(insertShopStockKey(shop, 'formal'));
      return ids;
    })();
    res.json({
      success: true, created: created.length, trialNeed, formalNeed,
      shop: yidian.shopPublic(db, shop),
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || '生成失败' });
  }
});
app.post('/api/admin/yidian/shops/:id/keys/import', (req, res) => {
  const shop = yidianShopOr404(req.params.id, res);
  if (!shop) return;
  const kind = licenseTypeOf(req.body?.licenseType);
  if (kind === 'manual') return res.status(400).json({ success: false, message: '请选择试用或正式' });
  const codes = yidian.parseImportCodes(req.body?.keys || req.body?.text || '');
  if (!codes.length) return res.status(400).json({ success: false, message: '请粘贴要导入的密钥' });
  const q = checkAgentQuota(shopKeyDefaults(shop).agentId, codes.length);
  if (!q.ok) return res.status(400).json({ success: false, message: q.msg });
  try {
    const result = db.transaction(() => {
      let imported = 0, skipped = 0;
      for (const code of codes) {
        if (db.prepare('SELECT id FROM license_keys WHERE key_code = ?').get(code)) { skipped += 1; continue; }
        insertShopStockKey(shop, kind, { keyCode: code });
        imported += 1;
      }
      return { imported, skipped };
    })();
    res.json({ success: true, ...result, shop: yidian.shopPublic(db, shop) });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message || '导入失败' });
  }
});
app.post('/api/admin/yidian/inspect', async (_req, res) => {
  try { res.json({ success: true, result: await yidian.inspectOrders(db) }); }
  catch (e) { res.status(502).json({ success: false, message: e.message }); }
});
app.post('/api/admin/yidian/dry-run', async (_req, res) => {
  try { res.json({ success: true, result: await yidian.tick(db, { ship: false, logEvents: true, onAlert: yidianAlert }) }); }
  catch (e) { res.status(502).json({ success: false, message: e.message }); }
});
app.post('/api/admin/yidian/disable-native', async (_req, res) => {
  try { res.json({ success: true, result: await yidian.disableNativeAutoShip(db) }); }
  catch (e) { res.status(502).json({ success: false, message: e.message }); }
});
app.post('/api/admin/yidian/products/scan', async (_req, res) => {
  try { res.json({ success: true, result: await yidian.scanProducts(db) }); }
  catch (e) { res.status(502).json({ success: false, message: e.message }); }
});
app.post('/api/admin/yidian/products/apply', (req, res) => {
  try { res.json({ success: true, result: yidian.applyScannedProducts(db, req.body?.items) }); }
  catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
app.get('/api/admin/yidian/orders', async (req, res) => {
  try { res.json({ success: true, result: await yidian.listRecentOrders(db, req.query || {}) }); }
  catch (e) { res.status(502).json({ success: false, message: e.message }); }
});
app.put('/api/admin/yidian/shops/:id/products', (req, res) => {
  try { res.json({ success: true, data: yidian.replaceShopProducts(db, Number(req.params.id), req.body || {}) }); }
  catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
app.get('/api/admin/yidian/replies', async (req, res) => {
  try { res.json({ success: true, result: await yidian.listAutoReplies(db, req.query || {}) }); }
  catch (e) { res.status(502).json({ success: false, message: e.message }); }
});
app.get('/api/admin/yidian/replies/:id', async (req, res) => {
  try { res.json({ success: true, result: await yidian.getAutoReply(db, req.params.id) }); }
  catch (e) { res.status(502).json({ success: false, message: e.message }); }
});
app.post('/api/admin/yidian/replies', async (req, res) => {
  try { res.json({ success: true, result: await yidian.saveAutoReply(db, req.body || {}) }); }
  catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
app.put('/api/admin/yidian/replies/:id/status', async (req, res) => {
  try { res.json({ success: true, result: await yidian.setAutoReplyStatus(db, req.params.id, Boolean(req.body?.enabled)) }); }
  catch (e) { res.status(400).json({ success: false, message: e.message }); }
});
app.delete('/api/admin/yidian/replies/:id', async (req, res) => {
  try { res.json({ success: true, result: await yidian.deleteAutoReply(db, req.params.id) }); }
  catch (e) { res.status(400).json({ success: false, message: e.message }); }
});

// ---------------------------------------------------------------------------
// 第三方 marslinker: 用卡密换取登录态 token(binding2) + 订阅信息(order)
// ---------------------------------------------------------------------------
const MARSLINKER = process.env.MARSLINKER || "https://002.myjsjsjs.cyou/marslinker";
async function marsFetch(url, ms = 45000) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return await r.json();
  } finally {
    clearTimeout(to);
  }
}

// 短缓存: 上游 cls2 很大且慢。缓存拉长, 避免插件一刷新就打穿到上游换 cookie
const RELAY_CACHE_TTL_MS = 30 * 60 * 1000;
const relayCache = new Map();
const cookiePullInFlight = new Map();
const cookiePullCooldownUntil = new Map();
const COOKIE_BG_REFRESH_MS = 8 * 60 * 60 * 1000;
const COOKIE_PULL_COOLDOWN_MS = 20 * 60 * 1000;
function relayCacheGet(key) {
  const hit = relayCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > RELAY_CACHE_TTL_MS) {
    relayCache.delete(key);
    return null;
  }
  return hit.data;
}
function relayCacheSet(key, data) {
  relayCache.set(key, { at: Date.now(), data });
  if (relayCache.size > 50) relayCache.delete(relayCache.keys().next().value);
}

// 插件数据中转：客户端只访问本站，不暴露上游地址。
app.get("/r/:op/:token", async (req, res) => {
  const op = String(req.params.op || "");
  if (!["order", "cls2", "rule2"].includes(op)) {
    return res.status(404).json({ retCode: false, retMsg: "接口不存在" });
  }
  const rawToken = String(req.params.token || "");
  const cacheKey = `${op}:${rawToken}`;
  if (rawToken !== "probe") {
    try {
      activity.pageSync({ ip: String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim(), ua: req.get("user-agent") || "", op });
    } catch (e) { /* 日志失败不影响下发 */ }
  }
  const cached = relayCacheGet(cacheKey);
  if (cached && marsMode() !== "mars") {
    res.setHeader("X-Relay-Cache", "HIT");
    return res.json(cached);
  }

  if (marsMode() === "mars") {
    const session = (await marsSession()) || {};
    const cls = session.cls || "";
    const rule = session.rule || "";
    const site = session.site || "www.jin10.com";
    let data = null;
    if (op === "cls2" && cls) data = { retCode: true, retMsg: "", data: sanitizeClsB64(cls) };
    if (op === "rule2") {
      // 只给 Chromium 内核(电脑 Chrome/Edge、安卓)加请求头规则；苹果 Orion/Firefox 对
      // modifyHeaders 支持不完整，整批规则可能被拒，保持原样下发。
      const ua = String(req.get("user-agent") || "");
      const chromium = /Chrome\/|Chromium\/|Edg\//.test(ua) && !/Firefox|iPhone|iPad|iPod/.test(ua);
      const merged = chromium ? withXtokenRule(rule) : rule;
      if (merged) data = { retCode: true, retMsg: "", data: merged };
    }
    if (op === "order") {
      data = {
        retCode: true,
        retMsg: "",
        data: {
          code: getSetting("mars_code"),
          token: rawToken,
          bdCnt: parseInt(getSetting("mars_bd"), 10) || 0,
          expiryDate: getSetting("mars_expiry") || "",
          home: site,
          site,
          product: "",
          favorites: getSetting("mars_favorites") || "[]",
          vip: readVipDisplay(),
        },
      };
    }
    if (data) {
      relayCacheSet(cacheKey, data);
      res.setHeader("X-Relay-Cache", "MARS");
      return res.json(data);
    }
  }

  // order 也优先读库: 库里 tokens 已有到期/收藏/绑定数, 直接拼返回, 避免每次激活都等上游
  // (实测上游 order 常 7~20 秒, 是激活慢的主因)。cls2 分支的后台异步刷新会顺带把这些
  // order 字段更新回库, 保持数据不太旧。
  if (op === "order") {
    const tk = db.prepare("SELECT * FROM tokens WHERE token = ? AND status='active' LIMIT 1").get(rawToken);
    if (tk && (tk.expiry_date || (tk.cls_b64 && String(tk.cls_b64).length > 20))) {
      const data = { retCode: true, retMsg: "", data: {
        code: tk.provider_code || "",
        token: tk.token,
        bdCnt: tk.bd_cnt || 0,
        expiryDate: tk.expiry_date || "",
        home: tk.site || "www.jin10.com",
        site: tk.site || "www.jin10.com",
        product: tk.product || "",
        favorites: tk.favorites || "[]",
        vip: readVipDisplay(),
      } };
      relayCacheSet(cacheKey, data);
      res.setHeader("X-Relay-Cache", "DB");
      return res.json(data);
    }
  }

  // cls2/rule2 优先读库: 上游经常 20~50 秒, 直接打会让激活/登录又慢又不稳定
  if (op === "cls2" || op === "rule2") {
    const tk = db.prepare("SELECT * FROM tokens WHERE token = ? AND status='active' LIMIT 1").get(rawToken);
    if (tk) {
      if (op === "cls2" && tk.cls_b64 && String(tk.cls_b64).length > 20) {
        const data = { retCode: true, retMsg: "", data: sanitizeClsB64(tk.cls_b64) };
        relayCacheSet(cacheKey, data);
        res.setHeader("X-Relay-Cache", "DB");
        setImmediate(() => scheduleCookieRefresh(tk));
        return res.json(data);
      }
      if (op === "rule2" && tk.rule_b64) {
        const data = { retCode: true, retMsg: "", data: tk.rule_b64 };
        relayCacheSet(cacheKey, data);
        res.setHeader("X-Relay-Cache", "DB");
        return res.json(data);
      }
    }
  }

  try {
    const token = encodeURIComponent(rawToken);
    const data = await marsFetch(
      `${MARSLINKER}/${op}/${token}?t=${Date.now()}`,
      op === "cls2" ? 45000 : 20000
    );
    if (data && data.retCode !== false) {
      if (op === "cls2" && data.data) data.data = sanitizeClsB64(data.data);
      relayCacheSet(cacheKey, data);
      if (op === "cls2" && data.data) {
        try {
          const meta = parseClsMeta(data.data);
          db.prepare(
            `UPDATE tokens SET cls_b64=?, cookie_pulled_at=datetime('now','localtime'),
               cookie_count=?, cookie_xtoken_exp=?, cookie_nick=?, cookie_vip_exp=?,
               updated_at=datetime('now','localtime') WHERE token=?`
          ).run(data.data, meta.cookieCount, meta.xtokenExp, meta.nick, meta.vipExp, rawToken);
        } catch (e) { /* ignore */ }
      }
      if (op === "rule2" && data.data) {
        try {
          db.prepare(
            "UPDATE tokens SET rule_b64=?, updated_at=datetime('now','localtime') WHERE token=?"
          ).run(data.data, rawToken);
        } catch (e) { /* ignore */ }
      }
    }
    res.setHeader("X-Relay-Cache", "MISS");
    return res.json(data);
  } catch (e) {
    if (op === "cls2" || op === "rule2") {
      const tk = db.prepare("SELECT * FROM tokens WHERE token = ? LIMIT 1").get(rawToken);
      if (op === "cls2" && tk && tk.cls_b64) {
        res.setHeader("X-Relay-Cache", "STALE");
        return res.json({ retCode: true, retMsg: "stale", data: sanitizeClsB64(tk.cls_b64) });
      }
      if (op === "rule2" && tk && tk.rule_b64) {
        res.setHeader("X-Relay-Cache", "STALE");
        return res.json({ retCode: true, retMsg: "stale", data: tk.rule_b64 });
      }
    }
    return res.status(502).json({ retCode: false, retMsg: "上游暂时不可用" });
  }
});

async function resolveProviderCode(code) {
  const b = await marsFetch(`${MARSLINKER}/binding2/${encodeURIComponent(code)}`);
  if (b.retCode !== true || !Array.isArray(b.data)) {
    throw new Error(b.retMsg || "第三方卡密无效");
  }
  const [token, site] = b.data;
  let order = {};
  try {
    const o = await marsFetch(`${MARSLINKER}/order/${token}?t=${Date.now()}`);
    if (o && o.data) order = o.data;
  } catch (e) { /* order 拉取失败不致命 */ }
  return {
    token,
    site: site || order.site || "www.jin10.com",
    product: order.product || "",
    expiryDate: order.expiryDate || "",
    bdCnt: order.bdCnt ?? 0,
    favorites: typeof order.favorites === "string" ? order.favorites : JSON.stringify(order.favorites || []),
  };
}

function inflateB64(b64) {
  if (!b64) return null;
  const raw = Buffer.from(b64, "base64");
  for (const fn of [
    () => zlib.inflateSync(raw),
    () => zlib.inflateRawSync(raw),
    () => zlib.unzipSync(raw),
  ]) {
    try { return fn().toString("utf8"); } catch (e) { /* try next */ }
  }
  return null;
}
function parseMaybe(v) {
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch (e) { return v; }
  }
  return v;
}
function fmtLocal(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function parseClsMeta(clsB64) {
  const meta = { cookieCount: 0, xtokenExp: "", nick: "", vipExp: "" };
  try {
    const txt = inflateB64(clsB64);
    if (!txt) return meta;
    const obj = JSON.parse(txt);
    const coos = parseMaybe(obj.coos) || [];
    const ls = parseMaybe(obj.ls) || {};
    if (Array.isArray(coos)) {
      meta.cookieCount = coos.length;
      const xt = coos.find((c) => c && c.name === "x-token");
      if (xt && xt.expirationDate) meta.xtokenExp = fmtLocal(xt.expirationDate * 1000);
    }
    if (ls && ls["flutter.spUser"]) {
      let spu = parseMaybe(ls["flutter.spUser"]);
      if (typeof spu === "string") spu = parseMaybe(spu);
      if (spu && typeof spu === "object") {
        meta.nick = spu.nick || "";
        meta.vipExp = spu.vip_expiration || "";
      }
    }
  } catch (e) { /* ignore */ }
  return meta;
}
function parseLocalTs(s) {
  if (!s) return NaN;
  return new Date(String(s).replace(" ", "T")).getTime();
}
function cookieIsFresh(tk) {
  if (!tk || !tk.cls_b64) return false;
  if (tk.cookie_xtoken_exp) {
    const t = parseLocalTs(tk.cookie_xtoken_exp);
    if (!Number.isNaN(t)) return t > Date.now() + 6 * 3600 * 1000;
  }
  if (tk.cookie_pulled_at) {
    const t = parseLocalTs(tk.cookie_pulled_at);
    if (!Number.isNaN(t)) return Date.now() - t < 24 * 3600 * 1000;
  }
  return true;
}
function cookieNeedsBgRefresh(tk) {
  if (!tk || !tk.cls_b64) return true;
  const cool = cookiePullCooldownUntil.get(tk.id) || 0;
  if (Date.now() < cool) return false;
  // 金十 x-token 还有效就不要去上游换 cookie: 同一账号下所有 token 共用一份登录态,
  // 拉一次会把所有客户一起踢掉。
  if (cookieIsFresh(tk)) return false;
  const pulled = parseLocalTs(tk.cookie_pulled_at);
  if (!Number.isNaN(pulled) && Date.now() - pulled < COOKIE_BG_REFRESH_MS) return false;
  return true;
}
function copySessionToToken(from, toId) {
  if (!from || !from.cls_b64 || !toId) return;
  db.prepare(
    `UPDATE tokens SET cls_b64=?, rule_b64=?, cookie_pulled_at=?, cookie_count=?,
       cookie_xtoken_exp=?, cookie_nick=?, cookie_vip_exp=?, updated_at=datetime('now','localtime')
     WHERE id=?`
  ).run(
    from.cls_b64, from.rule_b64 || "", from.cookie_pulled_at || "",
    from.cookie_count || 0, from.cookie_xtoken_exp || "", from.cookie_nick || "",
    from.cookie_vip_exp || "", toId
  );
}
function findFreshSibling(tok) {
  if (!tok || !tok.card_id) return null;
  const rows = db.prepare(
    "SELECT * FROM tokens WHERE card_id=? AND status='active' AND id!=? AND length(IFNULL(cls_b64,''))>20"
  ).all(tok.card_id, tok.id);
  return rows.find((r) => cookieIsFresh(r)) || null;
}
function replicateSessionToCard(from) {
  if (!from || !from.card_id || !from.cls_b64) return;
  const sibs = db.prepare("SELECT id FROM tokens WHERE card_id=? AND id!=? AND status='active'").all(from.card_id, from.id);
  for (const s of sibs) copySessionToToken(from, s.id);
}
function scheduleCookieRefresh(tk) {
  if (!tk || !tk.id) return;
  if (!cookieNeedsBgRefresh(tk)) return;
  if (cookiePullInFlight.has(tk.id)) return;
  const cardKey = "card:" + String(tk.card_id || tk.id);
  if (cookiePullInFlight.has(cardKey)) return;
  const job = pullSessionForToken(tk)
    .then(() => {
      cookiePullCooldownUntil.set(tk.id, Date.now() + COOKIE_PULL_COOLDOWN_MS);
      if (tk.token) {
        relayCache.delete("cls2:" + tk.token);
        relayCache.delete("rule2:" + tk.token);
        relayCache.delete("order:" + tk.token);
      }
    })
    .catch((e) => {
      cookiePullCooldownUntil.set(tk.id, Date.now() + COOKIE_PULL_COOLDOWN_MS);
      console.warn("[bg cookie refresh]", e.message);
    })
    .finally(() => {
      cookiePullInFlight.delete(tk.id);
      cookiePullInFlight.delete(cardKey);
    });
  cookiePullInFlight.set(tk.id, job);
  cookiePullInFlight.set(cardKey, job);
}
async function pullSessionForToken(tokenRow, { force = false } = {}) {
  const token = tokenRow.token;
  if (!token) throw new Error("token 为空");
  if (!force) {
    if (cookieIsFresh(tokenRow) && tokenRow.cls_b64 && String(tokenRow.cls_b64).length > 20) {
      return tokenRow;
    }
    const sibling = findFreshSibling(tokenRow);
    if (sibling) {
      copySessionToToken(sibling, tokenRow.id);
      return db.prepare("SELECT * FROM tokens WHERE id=?").get(tokenRow.id);
    }
  }
  const t = Date.now();
  const [orderRes, clsRes, ruleRes] = await Promise.all([
    marsFetch(`${MARSLINKER}/order/${token}?t=${t}`).catch(() => null),
    marsFetch(`${MARSLINKER}/cls2/${token}?t=${t}`),
    marsFetch(`${MARSLINKER}/rule2/${token}?t=${t}`).catch(() => null),
  ]);
  if (!clsRes || clsRes.retCode === false || !clsRes.data) {
    throw new Error((clsRes && clsRes.retMsg) || "第三方 cookie 拉取失败");
  }
  const clsData = sanitizeClsB64(clsRes.data);
  const meta = parseClsMeta(clsData);
  if (tokenRow.cls_b64 && String(tokenRow.cls_b64).length > 20) {
    const oldMeta = parseClsMeta(tokenRow.cls_b64);
    const weaker =
      (meta.cookieCount || 0) < Math.max(8, Math.floor((oldMeta.cookieCount || 0) * 0.6)) ||
      (oldMeta.xtokenExp && !meta.xtokenExp);
    if (weaker) {
      console.warn("[cookie pull] keep existing package", tokenRow.id, "newCount=" + meta.cookieCount);
      db.prepare("UPDATE tokens SET last_checked_at=datetime('now','localtime') WHERE id=?").run(tokenRow.id);
      return db.prepare("SELECT * FROM tokens WHERE id=?").get(tokenRow.id);
    }
  }
  const ruleB64 = (ruleRes && ruleRes.data) ? ruleRes.data : (tokenRow.rule_b64 || "");
  let favorites = tokenRow.favorites || "";
  let expiryDate = tokenRow.expiry_date || "";
  let product = tokenRow.product || "";
  let bdCnt = tokenRow.bd_cnt || 0;
  let site = tokenRow.site || "www.jin10.com";
  if (orderRes && orderRes.data) {
    const d = orderRes.data;
    expiryDate = d.expiryDate || expiryDate;
    product = d.product || product;
    bdCnt = d.bdCnt ?? bdCnt;
    site = d.site || d.home || site;
    favorites = typeof d.favorites === "string" ? d.favorites : JSON.stringify(d.favorites || []);
  }
  db.prepare(
    `UPDATE tokens SET
       cls_b64=?, rule_b64=?, cookie_pulled_at=datetime('now','localtime'),
       cookie_count=?, cookie_xtoken_exp=?, cookie_nick=?, cookie_vip_exp=?,
       expiry_date=?, product=?, bd_cnt=?, favorites=?, site=?,
       last_checked_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
     WHERE id=?`
  ).run(
    clsData, ruleB64, meta.cookieCount, meta.xtokenExp, meta.nick, meta.vipExp,
    expiryDate, product, bdCnt, favorites, site, tokenRow.id
  );
  const fresh = db.prepare("SELECT * FROM tokens WHERE id=?").get(tokenRow.id);
  replicateSessionToCard(fresh);
  return fresh;
}
const MARS_ORIGIN = "https://auths.marsead.cn";

function marsMode() {
  const v = getSetting("upstream_mode");
  return v === "legacy" ? "legacy" : "mars";
}

function marsFrame(cmd, headers, body) {
  let f = cmd + "\n";
  const h = Object.assign({}, headers);
  if (body) h["content-length"] = Buffer.byteLength(body);
  for (const [k, v] of Object.entries(h)) f += k + ":" + v + "\n";
  return f + "\n" + (body || "") + "\0";
}

function openMarsSocket(url) {
  const protocols = ["v12.stomp", "v11.stomp", "v10.stomp"];
  if (typeof WebSocket === "function") return new WebSocket(url, protocols);
  const WS = require("ws");
  return new WS(url, protocols);
}

function pullMarsPack(token) {
  const siteHint = getSetting("mars_site") || "www.jin10.com";
  return new Promise((resolve, reject) => {
    let done = false;
    const ws = openMarsSocket(MARS_ORIGIN + "/ws/marslinker?t=" + crypto.randomUUID());
    const finish = (err, val) => {
      if (done) return;
      done = true;
      try { ws.close(); } catch (e) { /* ignore */ }
      if (err) reject(err);
      else resolve(val);
    };
    const timer = setTimeout(() => finish(new Error("MarsConnect 超时")), 20000);
    ws.addEventListener("open", () => {
      ws.send(marsFrame("CONNECT", { "accept-version": "1.2,1.1,1.0", "heart-beat": "10000,10000" }));
    });
    ws.addEventListener("error", () => finish(new Error("MarsConnect 连接失败")));
    ws.addEventListener("message", (ev) => {
      const raw = (typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8")).replace(/\r/g, "");
      if (raw.startsWith("CONNECTED")) {
        ws.send(marsFrame("SUBSCRIBE", { id: "priv", destination: "/user/queue/private" }));
        ws.send(marsFrame("SEND", { destination: "/app/r", "content-type": "application/json" }, JSON.stringify([token])));
        setTimeout(() => {
          if (!done) ws.send(marsFrame("SEND", { destination: "/app/q", "content-type": "text/plain" }, token));
        }, 400);
        return;
      }
      if (!raw.startsWith("MESSAGE") || raw.indexOf("destination:/user/queue/private") < 0) return;
      const body = raw.split("\n\n").slice(1).join("\n\n").replace(/\0/g, "").trim();
      let j;
      try { j = JSON.parse(body); } catch (e) { return; }
      const data = j && j.data;
      if (j && j.retCode === false && j.retMsg === "tokenIsInvalid") {
        clearTimeout(timer);
        return finish(new Error("上游设备 token 已失效(tokenIsInvalid)，订阅码需要重新绑定"));
      }
      if (!j || j.retCode !== true || !data || !data.cls) return;
      clearTimeout(timer);
      finish(null, { cls: data.cls, rule: data.rule || "", order: data.order || {}, site: (data.order && data.order.site) || siteHint });
    });
  });
}

function saveMarsPack(pack) {
  const setKV = (k, v) =>
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?").run(k, String(v), String(v));
  const cls = sanitizeClsB64(pack.cls);
  const meta = parseClsMeta(cls);
  const order = pack.order || {};
  setKV("mars_cls_b64", cls);
  setKV("mars_rule_b64", pack.rule || "");
  setKV("mars_site", pack.site || order.site || "www.jin10.com");
  setKV("mars_expiry", order.expiryDate || "");
  setKV("mars_bd", order.bdCnt == null ? "" : String(order.bdCnt));
  setKV("mars_cookie_count", String(meta.cookieCount || 0));
  setKV("mars_xtoken_exp", meta.xtokenExp || "");
  setKV("mars_pulled_at", fmtLocal(Date.now()));
  let favorites = order.favorites;
  if (typeof favorites === "string") {
    try { favorites = JSON.parse(favorites); } catch (e) { favorites = []; }
  }
  if (!Array.isArray(favorites)) favorites = [];
  setKV("mars_favorites", JSON.stringify(favorites));
  try {
    if (typeof relayCache !== "undefined" && relayCache && relayCache.clear) relayCache.clear();
  } catch (e) { /* 没有中转缓存就跳过 */ }
}

function marsFavorites() {
  const raw = getSetting("mars_favorites");
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

function marsSessionFromStore() {
  const cls = getSetting("mars_cls_b64");
  if (!cls) return null;
  return {
    cls: sanitizeClsB64(cls),
    rule: getSetting("mars_rule_b64") || "",
    site: getSetting("mars_site") || "www.jin10.com",
    favorites: marsFavorites(),
    expiryDate: getSetting("mars_expiry") || "",
    pulledAt: getSetting("mars_pulled_at") || "",
    xtokenExp: getSetting("mars_xtoken_exp") || "",
  };
}

function marsIsFresh() {
  return cookieIsFresh({
    cls_b64: getSetting("mars_cls_b64"),
    cookie_xtoken_exp: getSetting("mars_xtoken_exp"),
    cookie_pulled_at: getSetting("mars_pulled_at"),
  });
}

async function refreshMarsPack(opts = {}) {
  // 统一走守护：单飞 + 退避 + 熔断 + 新包在金十校验通过才替换
  await marsGuard.refresh(opts);
  return marsSessionFromStore();
}

const marsGuard = require("./marsGuard")({
  getSetting: (k) => getSetting(k),
  setSetting: (k, v) =>
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?").run(k, String(v), String(v)),
  pullMarsPack: (token) => pullMarsPack(token),
  saveMarsPack: (pack) => saveMarsPack(pack),
  alert: (text) => marsAlert(text),
  log: (event, o) => activity.log(event, o),
  isMarsMode: () => marsMode() === "mars",
});

// 给旧插件下发的请求头规则：发往金十接口的请求统一使用服务器当前最新 x-token，
// 避免浏览器里残留的旧 host-only x-token 被行情指标(Flutter)读到导致掉登录。
const XTOKEN_RULE_DOMAINS = [
  "uc-api.jin10.com", "user-config-api.jin10.com", "order-book-api.jin10.com", "market-api.jin10.com",
  "vip-push-api.jin10.com", "credits-api.jin10.com", "reference-api.jin10.com", "comment-api.jin10.com",
  "subscription-api.jin10.com", "reference-open-api.jin10.com", "indicators-api.jin10.com", "favor-api.jin10.com",
  "jad-api.jin10.com", "search-open-api.jin10.com", "mp-api.jin10.com", "common-open-api.jin10.com",
  "flash-api.jin10.com", "z3c.jin10.com",
];
function withXtokenRule(ruleB64) {
  const xt = marsGuard.xtokenOf(getSetting("mars_cls_b64"));
  if (!xt) return ruleB64;
  try {
    let arr = [];
    if (ruleB64) {
      const txt = inflateB64(ruleB64);
      arr = txt ? JSON.parse(txt) : [];
      if (!Array.isArray(arr)) return ruleB64;
    }
    arr = arr.filter((r) => !(r && r.id === 201));
    arr.push({
      id: 201,
      priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [{ header: "x-token", operation: "set", value: xt }] },
      condition: { requestDomains: XTOKEN_RULE_DOMAINS, resourceTypes: ["xmlhttprequest", "other"] },
    });
    return zlib.deflateSync(Buffer.from(JSON.stringify(arr), "utf8")).toString("base64");
  } catch (e) {
    return ruleB64;
  }
}

async function ensureMarsToken(code) {
  const existing = getSetting("mars_token");
  const savedCode = getSetting("mars_code");
  if (existing && savedCode === code) return existing;
  const r = await fetch(MARS_ORIGIN + "/marslinker/binding/" + encodeURIComponent(code), {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Origin: "chrome-extension://cldemkeecebhnjipedpghophnhhhdebi",
      Accept: "application/json",
    },
  });
  const j = await r.json();
  if (!j || j.retCode !== true || !Array.isArray(j.data) || !j.data[0]) {
    throw new Error((j && j.retMsg) || "订阅失败");
  }
  const setKV = (k, v) =>
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?").run(k, String(v), String(v));
  setKV("mars_code", code);
  setKV("mars_token", j.data[0]);
  setKV("mars_site", j.data[1] || "www.jin10.com");
  return j.data[0];
}

let marsLiveCheckedAt = 0;
let marsLiveOk = false;
let marsEnsureInflight = null;
const MARS_LIVE_TTL_MS = 60 * 1000;

async function marsSession() {
  if (marsEnsureInflight) return marsEnsureInflight;
  marsEnsureInflight = (async () => {
    if (marsLiveOk && Date.now() - marsLiveCheckedAt < MARS_LIVE_TTL_MS && marsIsFresh()) {
      return marsSessionFromStore();
    }
    const alive = await marsXtokenAlive();
    if (alive === true) {
      marsLiveOk = true;
      marsLiveCheckedAt = Date.now();
      marsDead = false;
      return marsSessionFromStore();
    }
    if (alive === false) {
      try {
        await marsGuard.refresh();
        marsLiveCheckedAt = Date.now();
        marsLiveOk = true;
        marsDead = false;
        console.log("[mars] 下发前发现登录态失效，已换成新的");
      } catch (e) {
        // 退避/熔断期间直接下发旧包，不在客户请求里反复打上游
        marsLiveCheckedAt = Date.now();
        marsLiveOk = false;
        console.warn("[mars pull]", e.message);
      }
    }
    return marsSessionFromStore();
  })().finally(() => { marsEnsureInflight = null; });
  return marsEnsureInflight;
}

function scheduleMarsKeep() {
  const tick = () => {
    if (marsMode() !== "mars" || !getSetting("mars_token") || marsIsFresh()) return;
    marsGuard.refresh()
      .then(() => console.log("[mars] 登录态临近过期，已自动更换"))
      .catch((e) => console.warn("[mars keep]", e.message));
  };
  setTimeout(tick, 20000);
  setInterval(tick, 30 * 60 * 1000);
}

// 本地记录的 x-token 到期时间不可靠：上游换号或作废订阅码后旧包会立刻失效，这里直接问金十。
const MARS_CHECK_MS = 10 * 60 * 1000;
const MARS_ALERT_GAP_MS = 2 * 60 * 60 * 1000;
const MARS_SERVER_LABEL = "服务器1 103.106.189.24";
let marsAlertAt = 0;
let marsDead = false;
let marsChecking = false;

function marsStoredXtoken() {
  const cls = getSetting("mars_cls_b64");
  if (!cls) return "";
  try {
    const obj = JSON.parse(inflateB64(cls));
    const coos = parseMaybe(obj.coos) || [];
    const xt = Array.isArray(coos) ? coos.find((c) => c && c.name === "x-token") : null;
    return (xt && xt.value) || "";
  } catch (e) {
    return "";
  }
}

// 返回 true=有效, false=金十明确说要重新登录, null=查不了(网络等), 不当作失效
async function marsXtokenAlive() {
  const xt = marsStoredXtoken();
  if (!xt) return false;
  try {
    const r = await fetch("https://uc-api.jin10.com/userinfo", {
      headers: {
        "x-token": xt,
        "x-app-id": "ffvjAakTUKiVxntC",
        "x-version": "1.0.0",
        Origin: "https://www.jin10.com",
        Referer: "https://www.jin10.com/",
        "User-Agent": "Mozilla/5.0",
      },
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => null);
    if (j && (j.status === 401 || r.status === 401)) return false;
    return r.ok ? true : null;
  } catch (e) {
    return null;
  }
}

async function marsAlert(text) {
  if (!notificationEnabled("notify_mars")) return;
  if (!dingtalk.config().enabled && !readFeishuConfig().enabled) return;
  try {
    await notifyAdmin(`### 🔴 金十登录态 · ${MARS_SERVER_LABEL}\n\n${text}\n\n---\n[后台看板](https://sync-api.xircle.autos/k9m4x7q2/#/dashboard)`);
  } catch (e) {
    console.warn("[mars alert]", e.message);
  }
}

async function checkMarsHealth() {
  if (marsChecking || marsMode() !== "mars" || !getSetting("mars_token")) return;
  marsChecking = true;
  try {
    const alive = await marsXtokenAlive();
    if (alive === null) return;
    if (alive) {
      if (marsDead) {
        marsDead = false;
        console.log("[mars health] 登录态已恢复");
        await marsAlert("登录态已恢复，客户可以正常使用了");
      }
      return;
    }
    let reason = "";
    try {
      await refreshMarsPack();
      const again = await marsXtokenAlive();
      if (again !== false) {
        console.log("[mars health] 旧登录态失效，已从上游换新");
        if (marsDead) await marsAlert("登录态已从上游重新拉取，恢复正常");
        marsDead = false;
        return;
      }
      reason = "上游新拉的登录包在金十仍然是未登录，上游账号可能掉线了";
    } catch (e) {
      reason = "上游拉取失败：" + e.message;
    }
    marsDead = true;
    console.warn("[mars health]", reason);
    if (Date.now() - marsAlertAt > MARS_ALERT_GAP_MS) {
      marsAlertAt = Date.now();
      await marsAlert(`客户拿到的金十登录态已失效，插件现在用不了。${reason}。请到后台设置里换新的订阅编码并拉取上游。`);
    }
  } finally {
    marsChecking = false;
  }
}
// 旧的 10 分钟 checkMarsHealth 已由 marsGuard 接管(见 app.listen 里的 marsGuard.start())

function sessionFromToken(tk) {
  if (!tk || !tk.cls_b64) return null;
  let favorites = [];
  try { favorites = tk.favorites ? JSON.parse(tk.favorites) : []; } catch (e) { favorites = []; }
  return {
    cls: sanitizeClsB64(tk.cls_b64),
    rule: tk.rule_b64 || "",
    site: tk.site || "www.jin10.com",
    favorites,
    expiryDate: tk.expiry_date || "",
    pulledAt: tk.cookie_pulled_at || "",
    xtokenExp: tk.cookie_xtoken_exp || "",
  };
}

// 静态文件服务：头像上传后存在 uploads/ 目录，通过 /uploads/* 访问
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
app.use("/uploads", express.static(UPLOAD_DIR));

// 配置 multer：头像存储到 uploads/ 目录，文件名带时间戳避免冲突
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext);
    const timestamp = Date.now();
    cb(null, `${basename}-${timestamp}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    const allowed = /\.(jpg|jpeg|png|gif|webp|svg)$/i;
    if (allowed.test(file.originalname)) cb(null, true);
    else cb(new Error("仅支持图片格式(jpg/png/gif/webp/svg)"));
  },
});

// ---------------------------------------------------------------------------
// 插件库: 上传插件安装包, 存 downloads/ 目录, 生成公开一键下载链接
// ---------------------------------------------------------------------------
const DOWNLOAD_DIR = path.join(__dirname, "downloads");
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

// 按扩展名给下载响应设置 Content-Type; .xpi 用 application/x-xpinstall 才能让 Orion 弹一键安装
const MIME_BY_EXT = {
  ".xpi": "application/x-xpinstall",
  ".crx": "application/x-chrome-extension",
  ".zip": "application/zip",
};
function mimeForExt(ext) {
  return MIME_BY_EXT[String(ext).toLowerCase()] || "application/octet-stream";
}

const pluginStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, DOWNLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^\w.-]+/g, "_");
    cb(null, `${base}-${Date.now()}${ext}`);
  },
});
const pluginUpload = multer({
  storage: pluginStorage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB
  fileFilter: (req, file, cb) => {
    if (/\.(zip|xpi|crx)$/i.test(file.originalname)) cb(null, true);
    else cb(new Error("仅支持插件安装包(zip/xpi/crx)"));
  },
});

function pluginRowPublic(row) {
  return {
    id: row.id,
    name: row.name || "",
    slug: row.slug,
    originalName: row.original_name || "",
    ext: row.ext || "",
    mime: row.mime || "",
    size: row.size || 0,
    platform: row.platform || "other",
    downloadCount: row.download_count || 0,
    note: row.note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function isExpired(expiryDate) {
  if (!expiryDate) return false; // 空 = 尚未起算或永久
  const t = new Date(expiryDate).getTime();
  return !Number.isNaN(t) && t < Date.now();
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

// 从「现在」起算 validDays 天后的 23:59:59(本地)
function expiryFromNow(validDays) {
  const d = new Date();
  d.setDate(d.getDate() + validDays);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} 23:59:59`;
}

function expiryFromActivation(activatedAt, validDays) {
  const start = new Date(String(activatedAt).replace(" ", "T"));
  if (Number.isNaN(start.getTime())) return "";
  const d = new Date(start.getTime() + validDays * 24 * 60 * 60 * 1000);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function licenseTypeOf(value) {
  return ["manual", "trial", "formal"].includes(value) ? value : "manual";
}

// 记录首次激活时间(只写一次; 之后踢设备/删设备都不会清掉)
function markActivated(keyRow) {
  if (keyRow.activated_at) return keyRow;
  const now = db.prepare("SELECT datetime('now','localtime') t").get().t;
  const isTrial = keyRow.license_type === "trial";
  const blankName = !String(keyRow.name || "").trim();
  if (isTrial && blankName) {
    db.prepare(
      "UPDATE license_keys SET activated_at = ?, name='试用中', note=CASE WHEN IFNULL(note,'')='' THEN '试用中' ELSE note END, updated_at=datetime('now','localtime') WHERE id = ?"
    ).run(now, keyRow.id);
    keyRow.name = "试用中";
    if (!String(keyRow.note || "").trim()) keyRow.note = "试用中";
  } else {
    db.prepare("UPDATE license_keys SET activated_at = ? WHERE id = ?").run(now, keyRow.id);
  }
  keyRow.activated_at = now;
  return keyRow;
}

// 首次激活时把「激活后 N 天」写成真实到期日(只写一次)
function startValidityIfNeeded(keyRow) {
  const days = parseInt(keyRow.valid_days, 10) || 0;
  if (days <= 0) return keyRow;
  if (keyRow.expiry_date) return keyRow;
  const expiry = ["trial", "formal"].includes(keyRow.license_type)
    ? expiryFromActivation(keyRow.activated_at, days)
    : expiryFromNow(days);
  if (!expiry) return keyRow;
  db.prepare(
    "UPDATE license_keys SET expiry_date = ?, updated_at = datetime('now','localtime') WHERE id = ?"
  ).run(expiry, keyRow.id);
  keyRow.expiry_date = expiry;
  return keyRow;
}

// 剩余天数: 有到期日 -> 距今天数(不足记 0); 永久或未激活的按天算返回 null
function remainingDaysOf(row) {
  if (row.expiry_date) {
    const t = new Date(String(row.expiry_date).replace(" ", "T")).getTime();
    if (!Number.isNaN(t)) return Math.max(0, Math.ceil((t - Date.now()) / 86400000));
  }
  return null; // 永久 / 未激活(激活后 N 天, 尚未起算)
}

function keyRowPublic(row) {
  let agentName = "";
  let agentIsTest = false;
  if (row.agent_id) {
    const a = db.prepare("SELECT name, is_test FROM agents WHERE id = ?").get(row.agent_id);
    if (a) { agentName = a.name || ""; agentIsTest = !!a.is_test; }
  }
  return {
    id: row.id,
    keyCode: row.key_code,
    name: row.name,
    nickname: row.nickname || "",
    avatar: row.avatar || "",
    maxDevices: row.max_devices,
    status: row.status,
    expiryDate: row.expiry_date,
    validDays: row.valid_days || 0,
    licenseType: licenseTypeOf(row.license_type),
    xianyuBuyerId: row.xianyu_buyer_id || "",
    xianyuOrderId: row.xianyu_order_id || "",
    remainingDays: remainingDaysOf(row),
    // 首次激活时间(空 = 从没激活过); 与当前设备数无关, 踢设备/删设备都不影响
    activatedAt: row.activated_at || "",
    activated: !!row.activated_at,
    note: row.note,
    cardId: row.card_id ?? null,
    agentId: row.agent_id ?? null,
    agentName,
    agentIsTest,
    // 客户信息
    customerName: row.customer_name || "",
    phone: row.phone || "",
    wechat: row.wechat || "",
    qq: row.qq || "",
    contactType: row.contact_type || "",
    contactValue: row.contact_value || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 单个 token(卡密的子项) -> 前端结构, 含已占用名额
function tokenSubPublic(row) {
  const deviceCount = db
    .prepare("SELECT COUNT(*) c FROM devices WHERE token_id = ? AND status = 'active'")
    .get(row.id).c;
  return {
    id: row.id,
    token: row.token || "",
    site: row.site || "",
    status: row.status,
    deviceCount,
    hasCookie: !!(row.cls_b64 && String(row.cls_b64).length > 20),
    cookieCount: row.cookie_count || 0,
    cookiePulledAt: row.cookie_pulled_at || "",
    cookieXtokenExp: row.cookie_xtoken_exp || "",
    cookieNick: row.cookie_nick || "",
    cookieVipExp: row.cookie_vip_exp || "",
    createdAt: row.created_at,
  };
}

// 卡密行 -> 前端结构(含它的 token 列表、cookie 状态、被多少密钥引用)
function cardRowPublic(row) {
  const tokenRows = db.prepare("SELECT * FROM tokens WHERE card_id = ? ORDER BY id ASC").all(row.id);
  const tokens = tokenRows.map(tokenSubPublic);
  const usedDevices = tokens.reduce((s, t) => s + t.deviceCount, 0);
  const assignedCount = db.prepare("SELECT COUNT(*) c FROM license_keys WHERE card_id = ?").get(row.id).c;
  const cookieReady = tokens.filter((t) => t.hasCookie).length;
  return {
    id: row.id,
    label: row.label || "",
    providerCode: row.provider_code,
    product: row.product || "",
    site: row.site || "",
    expiryDate: row.expiry_date || "",
    status: row.status,
    lastCheckedAt: row.last_checked_at || "",
    note: row.note || "",
    tokenCount: tokens.length,
    cookieReady,
    usedDevices,
    assignedCount,
    tokens,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function deviceRowPublic(row) {
  return {
    id: row.id,
    keyId: row.key_id,
    deviceId: row.device_id,
    nickname: row.nickname,
    avatar: row.avatar,
    deviceLabel: row.device_label,
    status: row.status,
    firstLoginAt: row.first_login_at,
    lastSeenAt: row.last_seen_at,
  };
}

// ---------------------------------------------------------------------------
// 头像上传接口
// ---------------------------------------------------------------------------
app.post("/api/upload/avatar", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "未选择文件" });
  }
  // 返回相对路径, 前端拼接当前域名即可访问; verify接口下发时也是这个相对路径,
  // 客户端(扩展/工具)拿到后需要自己拼接后台域名前缀
  const url = `/uploads/${req.file.filename}`;
  res.json({ success: true, url });
});

// ---------------------------------------------------------------------------
// 插件库接口: 上传 /api/upload/plugin, 管理 /api/admin/plugins, 公开下载 /dl/:slug
// ---------------------------------------------------------------------------
function genSlug() {
  const chars = "abcdefghijkmnpqrstuvwxyz23456789"; // 去掉易混字符
  for (let tries = 0; tries < 8; tries++) {
    let s = "";
    for (let i = 0; i < 8; i++) s += chars[crypto.randomInt(chars.length)];
    if (!db.prepare("SELECT id FROM plugin_files WHERE slug = ?").get(s)) return s;
  }
  return crypto.randomBytes(6).toString("hex");
}

// 上传插件包(带 name/platform/note)-> 落库返回记录
app.post("/api/upload/plugin", (req, res) => {
  pluginUpload.single("file")(req, res, (err) => {
    if (err) return res.status(400).json({ success: false, message: err.message || "上传失败" });
    if (!req.file) return res.status(400).json({ success: false, message: "未选择文件" });
    const { name = "", platform = "other", note = "" } = req.body || {};
    const ext = path.extname(req.file.originalname).toLowerCase();
    const slug = genSlug();
    const info = db
      .prepare(
        `INSERT INTO plugin_files (name, slug, filename, original_name, ext, mime, size, platform, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        String(name).trim() || req.file.originalname,
        slug,
        req.file.filename,
        req.file.originalname,
        ext,
        mimeForExt(ext),
        req.file.size,
        ["pc", "android", "ios", "other"].includes(platform) ? platform : "other",
        note
      );
    const row = db.prepare("SELECT * FROM plugin_files WHERE id = ?").get(info.lastInsertRowid);
    res.json({ success: true, data: pluginRowPublic(row) });
  });
});

// 插件列表
app.get("/api/admin/plugins", (req, res) => {
  const rows = db.prepare("SELECT * FROM plugin_files ORDER BY id DESC").all();
  res.json({ success: true, data: rows.map(pluginRowPublic) });
});

// 编辑插件(改名/平台/备注)
app.put("/api/admin/plugins/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM plugin_files WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: "插件不存在" });
  const { name, platform, note } = req.body || {};
  db.prepare(
    `UPDATE plugin_files SET
       name = COALESCE(@name, name),
       platform = COALESCE(@platform, platform),
       note = COALESCE(@note, note),
       updated_at = datetime('now','localtime')
     WHERE id = @id`
  ).run({
    id: row.id,
    name: name ?? null,
    platform: platform ?? null,
    note: note ?? null,
  });
  const updated = db.prepare("SELECT * FROM plugin_files WHERE id = ?").get(row.id);
  res.json({ success: true, data: pluginRowPublic(updated) });
});

// 删除插件(删库 + 删磁盘文件)
app.delete("/api/admin/plugins/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM plugin_files WHERE id = ?").get(req.params.id);
  if (row) {
    try { fs.unlinkSync(path.join(DOWNLOAD_DIR, row.filename)); } catch (e) { /* 文件可能已不在 */ }
    db.prepare("DELETE FROM plugin_files WHERE id = ?").run(row.id);
  }
  res.json({ success: true });
});

function contentDisposition(dlName) {
  const name = String(dlName || "download");
  const ext = (name.match(/\.[A-Za-z0-9]+$/) || [""])[0];
  const ascii = /^[\x20-\x7E]+$/.test(name) ? name.replace(/"/g, "") : `download${ext || ".bin"}`;
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

// 公开下载: /dl/<slug> 或 /dl/<slug>/<文件名>(URL 以真实扩展名结尾, 便于 Orion 识别 .xpi)
// authGuard 只拦 /api/admin 与 /api/upload, /dl 自动放行
function handleDownload(req, res) {
  const row = db.prepare("SELECT * FROM plugin_files WHERE slug = ?").get(req.params.slug);
  if (!row) return res.status(404).send("文件不存在或已删除");
  const filePath = path.join(DOWNLOAD_DIR, row.filename);
  if (!fs.existsSync(filePath)) return res.status(404).send("文件不存在或已删除");
  db.prepare("UPDATE plugin_files SET download_count = download_count + 1 WHERE id = ?").run(row.id);
  const dlName = row.original_name || row.filename;
  res.setHeader("Content-Type", row.mime || mimeForExt(row.ext));
  // 移动端浏览器需要直接识别 .crx/.xpi；attachment 会导致只下载而不触发安装。
  if (row.ext === ".zip") {
    res.setHeader("Content-Disposition", contentDisposition(dlName));
  }
  res.setHeader("Content-Length", row.size || fs.statSync(filePath).size);
  fs.createReadStream(filePath).pipe(res);
}
require("./adminExtra")(app, {
  db, activity, getSetting: (k) => getSetting(k), DOWNLOAD_DIR,
  NOT_TEST: "(agent_id IS NULL OR agent_id NOT IN (SELECT id FROM agents WHERE is_test = 1))",
  maskCode: (c) => maskCode(c),
});
app.get("/dl/:slug", handleDownload);
app.get("/dl/:slug/:name", handleDownload);


// 版本检查 API: /api/plugin/check-update?platform=pc&current=1.1.11
app.get("/api/plugin/check-update", (req, res) => {
  try {
    const platform = String(req.query.platform || "pc").toLowerCase();
    const currentVersion = String(req.query.current || "");
    
    // 查询该平台的最新插件
    const latest = db.prepare(`
      SELECT name, slug, original_name, size, created_at 
      FROM plugin_files 
      WHERE platform = ? AND id NOT IN (SELECT plugin_id FROM plugin_releases) 
      ORDER BY created_at DESC 
      LIMIT 1
    `).get(platform);
    
    if (!latest) {
      return res.json({
        success: true,
        hasUpdate: false,
        message: "暂无可用版本"
      });
    }
    
    // 从文件名提取版本号 (如 ykb-pc-v1.1.14.zip -> 1.1.14)
    const versionMatch = latest.original_name.match(/v?(\d+\.\d+\.\d+)/);
    const latestVersion = versionMatch ? versionMatch[1] : "";
    
    // 比较版本号
    const hasUpdate = latestVersion && currentVersion && latestVersion !== currentVersion;
    
    res.json({
      success: true,
      hasUpdate,
      latestVersion,
      currentVersion,
      downloadUrl: `/dl/${latest.slug}`,
      name: latest.name,
      size: latest.size,
      releaseDate: latest.created_at
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ===========================================================================
// 管理端接口: /api/admin/keys
// ===========================================================================

// 列表(支持 Ant Design Pro ProTable 的分页/关键字参数: current, pageSize, keyCode, status)
app.get("/api/admin/keys", (req, res) => {
  const { current = 1, pageSize = 10, keyCode = "", status = "", keyState = "", name = "", agentId = "", licenseType = "" } = req.query;
  const page = Math.max(1, parseInt(current, 10) || 1);
  const size = Math.max(1, Math.min(200, parseInt(pageSize, 10) || 10));

  const where = [];
  const params = {};
  if (keyCode) {
    where.push("key_code LIKE @keyCode");
    params.keyCode = `%${keyCode}%`;
  }
  if (name) {
    where.push("(IFNULL(name,'') LIKE @name OR IFNULL(note,'') LIKE @name)");
    params.name = `%${name}%`;
  }
  if (status) {
    where.push("status = @status");
    params.status = status;
  }
  // 统一状态筛选：优先看封禁，再按到期/激活情况判断
  if (keyState === "expired") {
    where.push("status = 'active' AND IFNULL(expiry_date,'') != '' AND datetime(expiry_date) < datetime('now','localtime')");
  } else if (keyState === "normal") {
    where.push("status = 'active' AND (IFNULL(expiry_date,'') = '' OR datetime(expiry_date) >= datetime('now','localtime'))");
  } else if (keyState === "disabled") {
    where.push("status = 'disabled'");
  } else if (keyState === "unactivated") {
    where.push("IFNULL(activated_at,'') = ''");
  }
  if (licenseType) {
    const kind = licenseTypeOf(String(licenseType));
    where.push("IFNULL(license_type,'manual') = @licenseType");
    params.licenseType = kind;
  }
  // agentId=0 表示筛「未分类」
  if (agentId !== "" && agentId != null) {
    const aid = parseInt(agentId, 10);
    if (aid > 0) {
      where.push("agent_id = @agentId");
      params.agentId = aid;
    } else if (aid === 0) {
      where.push("agent_id IS NULL");
    }
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = db.prepare(`SELECT COUNT(*) AS c FROM license_keys ${whereSql}`).get(params).c;
  const rows = db
    .prepare(
      `SELECT * FROM license_keys ${whereSql} ORDER BY id DESC LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: size, offset: (page - 1) * size });

  // 附带每个密钥当前的在线设备数(方便列表直接看占用情况) + 分配的卡密标签
  const withCount = rows.map((r) => {
    const deviceCount = db
      .prepare(`SELECT COUNT(*) AS c FROM devices WHERE key_id = ? AND status = 'active'`)
      .get(r.id).c;
    let cardLabel = "";
    if (r.card_id) {
      const c = db.prepare("SELECT label, provider_code FROM cards WHERE id = ?").get(r.card_id);
      if (c) cardLabel = c.label || c.provider_code;
    }
    return { ...keyRowPublic(r), deviceCount, cardLabel };
  });

  res.json({ success: true, data: withCount, total, current: page, pageSize: size });
});

// 代理已关联密钥数
function agentUsed(agentId) {
  return db.prepare("SELECT COUNT(*) c FROM license_keys WHERE agent_id = ?").get(agentId).c;
}

// 校验代理配额: 要新增 addCount 把密钥前检查。返回 {ok, msg, agentId}
function checkAgentQuota(rawAgentId, addCount) {
  if (rawAgentId == null || rawAgentId === "") return { ok: true, agentId: null };
  const agentId = parseInt(rawAgentId, 10);
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!agent) return { ok: false, msg: "关联的代理不存在" };
  const cap = agent.capacity || 0;
  if (cap > 0) {
    const used = agentUsed(agentId);
    if (used + addCount > cap) {
      return { ok: false, msg: `代理「${agent.name}」名额不足: 已用 ${used}/${cap}, 本次需 ${addCount}` };
    }
  }
  return { ok: true, agentId };
}

// 创建密钥
app.post("/api/admin/keys", (req, res) => {
  const { name = "", nickname = "", avatar = "", maxDevices = 3, expiryDate = "", validDays = 0, note = "", cardId = null, agentId = null, licenseType = "manual",
          customerName = "", phone = "", wechat = "", qq = "", contactType = "", contactValue = "" } = req.body || {};
  const maxD = Math.max(1, parseInt(maxDevices, 10) || 3);
  const cid = cardId == null || cardId === "" ? null : parseInt(cardId, 10);
  const kind = licenseTypeOf(licenseType);
  const days = kind === "trial" ? 1 : kind === "formal" ? 30 : Math.max(0, parseInt(validDays, 10) || 0);
  // 新密钥: 到期日等首次激活再写; 兼容旧前端若只传了绝对日期则仍写入
  const expiry = days > 0 ? "" : (expiryDate || "");

  const q = checkAgentQuota(agentId, 1);
  if (!q.ok) return res.status(400).json({ success: false, message: q.msg });

  let keyCode;
  // 极小概率碰撞时重试
  for (let i = 0; i < 5; i++) {
    keyCode = genKey();
    const exists = db.prepare("SELECT id FROM license_keys WHERE key_code = ?").get(keyCode);
    if (!exists) break;
    keyCode = null;
  }
  if (!keyCode) return res.status(500).json({ success: false, message: "生成密钥失败,请重试" });

  const info = db
    .prepare(
      `INSERT INTO license_keys (key_code, name, nickname, avatar, max_devices, expiry_date, valid_days, note, card_id, agent_id, customer_name, phone, wechat, qq, contact_type, contact_value, license_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(keyCode, name, nickname, avatar, maxD, expiry, days, note, cid, q.agentId,
         String(customerName || ""), String(phone || ""), String(wechat || ""), String(qq || ""), String(contactType || ""), String(contactValue || ""), kind);

  const row = db.prepare("SELECT * FROM license_keys WHERE id = ?").get(info.lastInsertRowid);
  res.json({ success: true, data: keyRowPublic(row) });
});

// 批量创建密钥(共用: 昵称/头像/设备数/到期/卡密/代理; 不填备注名)
app.post("/api/admin/keys/batch", (req, res) => {
  const { count = 1, nickname = "", avatar = "", maxDevices = 3, expiryDate = "", validDays = 0, cardId = null, agentId = null, licenseType = "manual" } = req.body || {};
  const n = Math.max(1, Math.min(200, parseInt(count, 10) || 1));
  const maxD = Math.max(1, parseInt(maxDevices, 10) || 3);
  const cid = cardId == null || cardId === "" ? null : parseInt(cardId, 10);
  const kind = licenseTypeOf(licenseType);
  const days = kind === "trial" ? 1 : kind === "formal" ? 30 : Math.max(0, parseInt(validDays, 10) || 0);
  const expiry = days > 0 ? "" : (expiryDate || "");

  const q = checkAgentQuota(agentId, n);
  if (!q.ok) return res.status(400).json({ success: false, message: q.msg });

  const insertOne = db.prepare(
    `INSERT INTO license_keys (key_code, name, nickname, avatar, max_devices, expiry_date, valid_days, note, card_id, agent_id, license_type) VALUES (?, '', ?, ?, ?, ?, ?, '', ?, ?, ?)`
  );

  const gen = () => {
    for (let i = 0; i < 8; i++) {
      const code = genKey();
      if (!db.prepare("SELECT id FROM license_keys WHERE key_code = ?").get(code)) return code;
    }
    return null;
  };

  const createdIds = [];
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      const code = gen();
      if (!code) throw new Error("生成密钥失败,请重试");
      const info = insertOne.run(code, nickname, avatar, maxD, expiry, days, cid, q.agentId, kind);
      createdIds.push(info.lastInsertRowid);
    }
  });
  try {
    tx();
  } catch (e) {
    return res.status(500).json({ success: false, message: e.message || "批量创建失败" });
  }

  const rows = createdIds.map((id) => keyRowPublic(db.prepare("SELECT * FROM license_keys WHERE id = ?").get(id)));
  res.json({ success: true, data: rows });
});

// 更新密钥(备注/设备上限/状态/到期时间)
app.put("/api/admin/keys/:id", (req, res) => {
  const { id } = req.params;
  const row = db.prepare("SELECT * FROM license_keys WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ success: false, message: "密钥不存在" });

  const { name, nickname, avatar, maxDevices, expiryDate, validDays, note, status, licenseType,
          customerName, phone, wechat, qq, contactType, contactValue } = req.body || {};
  const requestedAgent = req.body?.agentId;
  if (requestedAgent != null && requestedAgent !== '' && Number(row.agent_id) !== parseInt(requestedAgent, 10)) {
    const quota = checkAgentQuota(parseInt(requestedAgent, 10), 1);
    if (!quota.ok) return res.status(400).json({ success: false, message: quota.msg });
  }
  const updated = db.transaction(() => {
  const prevKind = licenseTypeOf(row.license_type);
  const updatedKind = licenseType == null ? prevKind : licenseTypeOf(licenseType);
  const kindChanged = licenseType != null && updatedKind !== prevKind;

  let nextName = name ?? null;
  let nextNote = note ?? null;
  let nextExpiry = updatedKind !== "manual" && !row.activated_at ? "" : (expiryDate ?? null);
  if (kindChanged && updatedKind === "formal") {
    if (nextName === "试用中" || (nextName == null && row.name === "试用中")) nextName = "";
    if (nextNote === "试用中" || (nextNote == null && row.note === "试用中")) nextNote = "";
    if (nextNote == null && String(row.note || "").includes("试用超时停用")) {
      nextNote = String(row.note).replace(/\s*试用超时停用/g, "").trim();
    }
    if (nextNote == null && String(row.note || "").includes("已作废")) {
      nextNote = String(row.note).replace(/\s*已作废/g, "").trim();
    }
    if (row.activated_at) {
      const computed = expiryFromActivation(row.activated_at, 30);
      nextExpiry = expiryDate && expiryDate !== row.expiry_date ? expiryDate : computed;
    }
  }
  if (kindChanged && updatedKind === "trial" && row.activated_at) {
    nextExpiry = expiryFromActivation(row.activated_at, 1);
  }

  db.prepare(
    `UPDATE license_keys SET
       name = COALESCE(@name, name),
       nickname = CASE WHEN @nickname IS NULL THEN nickname ELSE @nickname END,
       avatar = CASE WHEN @avatar IS NULL THEN avatar ELSE @avatar END,
       max_devices = COALESCE(@maxDevices, max_devices),
       expiry_date = CASE WHEN @expiryDate IS NULL THEN expiry_date ELSE @expiryDate END,
       valid_days = CASE WHEN @validDays IS NULL THEN valid_days ELSE @validDays END,
       note = COALESCE(@note, note),
       status = COALESCE(@status, status),
       license_type = COALESCE(@licenseType, license_type),
       customer_name = CASE WHEN @customerName IS NULL THEN customer_name ELSE @customerName END,
       phone = CASE WHEN @phone IS NULL THEN phone ELSE @phone END,
       wechat = CASE WHEN @wechat IS NULL THEN wechat ELSE @wechat END,
       qq = CASE WHEN @qq IS NULL THEN qq ELSE @qq END,
       contact_type = CASE WHEN @contactType IS NULL THEN contact_type ELSE @contactType END,
       contact_value = CASE WHEN @contactValue IS NULL THEN contact_value ELSE @contactValue END,
       updated_at = datetime('now','localtime')
     WHERE id = @id`
  ).run({
    id,
    name: nextName,
    nickname: nickname ?? null,
    avatar: avatar ?? null,
    maxDevices: maxDevices != null ? parseInt(maxDevices, 10) : null,
    expiryDate: nextExpiry,
    validDays: updatedKind === "trial" ? 1 : updatedKind === "formal" ? 30 :
      (validDays != null ? Math.max(0, parseInt(validDays, 10) || 0) : null),
    note: nextNote,
    status: kindChanged && updatedKind === "formal" && row.status === "disabled" && status == null
      ? "active"
      : (status ?? null),
    licenseType: licenseType == null ? null : licenseTypeOf(licenseType),
    customerName: customerName ?? null,
    phone: phone ?? null,
    wechat: wechat ?? null,
    qq: qq ?? null,
    contactType: contactType ?? null,
    contactValue: contactValue ?? null,
  });

  if (licenseType === "trial" || licenseType === "formal") {
    db.prepare("UPDATE license_keys SET valid_days = ? WHERE id = ?").run(licenseType === "trial" ? 1 : 30, id);
  }

  if (status === "disabled") {
    db.prepare("UPDATE devices SET status = 'kicked' WHERE key_id = ?").run(id);
  }

  // 卡密分配单独处理(允许清空): 仅当请求体带 cardId 字段时更新
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "cardId")) {
    const cv = req.body.cardId;
    const cid = cv == null || cv === "" ? null : parseInt(cv, 10);
    db.prepare("UPDATE license_keys SET card_id = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(cid, id);
    // 换了卡密, 该密钥下所有设备的 token 占用作废(下次激活重新分配)
    db.prepare("UPDATE devices SET token_id = NULL WHERE key_id = ?").run(id);
  }

  // 关联代理(允许清空)
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "agentId")) {
    const av = req.body.agentId;
    if (av == null || av === "") {
      db.prepare("UPDATE license_keys SET agent_id = NULL, updated_at = datetime('now','localtime') WHERE id = ?").run(id);
    } else {
      const newId = parseInt(av, 10);
      db.prepare("UPDATE license_keys SET agent_id = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(newId, id);
    }
  }

  const updated = db.prepare("SELECT * FROM license_keys WHERE id = ?").get(id);
  const fields = ['name','nickname','avatar','max_devices','expiry_date','valid_days','note','status','license_type','customer_name','phone','wechat','qq','contact_type','contact_value','card_id','agent_id'];
  const changed = fields.filter(field => row[field] !== updated[field]);
  if (changed.length) telemetry.record(db, {keyId: row.id, type: 'key_edit', outcome: 'ok', metadata: {source: 'cloud-admin', changedFields: changed.join(','), beforeExpiry: row.expiry_date, afterExpiry: updated.expiry_date, beforeStatus: row.status, afterStatus: updated.status}});
  return updated;
  })();
  res.json({ success: true, data: keyRowPublic(updated) });
});

// 删除密钥(级联删除其设备)
app.delete("/api/admin/keys/:id", (req, res) => {
  db.transaction(() => {
    const row = db.prepare('SELECT id FROM license_keys WHERE id=?').get(req.params.id);
    if (row) {telemetry.record(db,{keyId:row.id,type:'key_delete',outcome:'ok',metadata:{source:'cloud-admin'}});db.prepare('DELETE FROM device_metadata WHERE device_row_id IN (SELECT id FROM devices WHERE key_id=?)').run(row.id);}
    db.prepare("DELETE FROM license_keys WHERE id = ?").run(req.params.id);
  })();
  res.json({ success: true });
});

// 批量删除
app.post("/api/admin/keys/batch-delete", (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const clean = ids.map((x) => parseInt(x, 10)).filter((n) => Number.isInteger(n) && n > 0);
  if (!clean.length) return res.status(400).json({ success: false, message: "请先选择要删除的密钥" });
  const del = db.prepare("DELETE FROM license_keys WHERE id = ?");
  const tx = db.transaction((list) => {
    for (const id of new Set(list)) {
      const row = db.prepare('SELECT id FROM license_keys WHERE id=?').get(id);
      if (row) {telemetry.record(db,{keyId:row.id,type:'key_delete',outcome:'ok',metadata:{source:'cloud-admin'}});db.prepare('DELETE FROM device_metadata WHERE device_row_id IN (SELECT id FROM devices WHERE key_id=?)').run(id);del.run(id);}
    }
  });
  tx(clean);
  res.json({ success: true, deleted: clean.length });
});

// ===========================================================================
// 代理库: /api/admin/agents
// ===========================================================================
function agentRowPublic(row) {
  const used = agentUsed(row.id);
  return {
    id: row.id,
    name: row.name || "",
    capacity: row.capacity || 0,
    used,
    isTest: !!row.is_test,
    note: row.note || "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

app.get("/api/admin/agents", (_req, res) => {
  const rows = db.prepare("SELECT * FROM agents ORDER BY id DESC").all();
  res.json({ success: true, data: rows.map(agentRowPublic) });
});

app.post("/api/admin/agents", (req, res) => {
  const { name = "", capacity = 0, note = "", isTest = false } = req.body || {};
  const n = String(name).trim();
  if (!n) return res.status(400).json({ success: false, message: "请填写分类名字" });
  const cap = Math.max(0, parseInt(capacity, 10) || 0);
  const info = db
    .prepare("INSERT INTO agents (name, capacity, note, is_test) VALUES (?, ?, ?, ?)")
    .run(n, cap, note || "", isTest ? 1 : 0);
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(info.lastInsertRowid);
  res.json({ success: true, data: agentRowPublic(row) });
});

app.put("/api/admin/agents/:id", (req, res) => {
  const { id } = req.params;
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ success: false, message: "代理不存在" });
  const { name, capacity, note, isTest } = req.body || {};
  const nextName = name != null ? String(name).trim() : row.name;
  if (!nextName) return res.status(400).json({ success: false, message: "请填写分类名字" });
  const nextCap = capacity != null ? Math.max(0, parseInt(capacity, 10) || 0) : row.capacity;
  const used = agentUsed(row.id);
  if (nextCap > 0 && used > nextCap) {
    return res.status(400).json({ success: false, message: `配额不能小于已关联密钥数 ${used}` });
  }
  const nextTest = isTest != null ? (isTest ? 1 : 0) : row.is_test;
  db.prepare(
    "UPDATE agents SET name=?, capacity=?, note=?, is_test=?, updated_at=datetime('now','localtime') WHERE id=?"
  ).run(nextName, nextCap, note != null ? note : row.note, nextTest, id);
  res.json({ success: true, data: agentRowPublic(db.prepare("SELECT * FROM agents WHERE id = ?").get(id)) });
});

app.delete("/api/admin/agents/:id", (req, res) => {
  const { id } = req.params;
  db.prepare("UPDATE license_keys SET agent_id = NULL WHERE agent_id = ?").run(id);
  db.prepare("DELETE FROM agents WHERE id = ?").run(id);
  res.json({ success: true });
});

// ===========================================================================
// 卡密池: /api/admin/cards
//   Token 下保存金十 cookie 包, 新插件直接注入; 旧插件仍用 token 走第三方
// ===========================================================================

// 列表(全部, 含每张卡的 token 明细/名额)
app.get("/api/admin/cards", (req, res) => {
  const rows = db.prepare("SELECT * FROM cards ORDER BY id DESC").all();
  res.json({ success: true, data: rows.map(cardRowPublic) });
});

// 新增卡密: 校验并铸第 1 个 token
app.post("/api/admin/cards", async (req, res) => {
  const { providerCode = "", label = "", note = "" } = req.body || {};
  const code = String(providerCode).trim();
  if (!code) return res.json({ success: false, message: "请填写第三方卡密" });
  if (db.prepare("SELECT id FROM cards WHERE provider_code = ?").get(code)) {
    return res.json({ success: false, message: "该卡密已在池中" });
  }
  try {
    const r = await resolveProviderCode(code);
    const info = db
      .prepare(
        `INSERT INTO cards (label, provider_code, product, site, expiry_date, status, last_checked_at, note)
         VALUES (?, ?, ?, ?, ?, 'active', datetime('now','localtime'), ?)`
      )
      .run(label, code, r.product, r.site, r.expiryDate, note);
    const cardId = info.lastInsertRowid;
    db.prepare(
      `INSERT INTO tokens (label, provider_code, card_id, token, site, product, expiry_date, bd_cnt, favorites, status, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now','localtime'))`
    ).run(label, code, cardId, r.token, r.site, r.product, r.expiryDate, r.bdCnt, r.favorites);
    const tok = db.prepare("SELECT * FROM tokens WHERE card_id = ? ORDER BY id DESC LIMIT 1").get(cardId);
    try { await pullSessionForToken(tok); } catch (e) { console.warn("[cookie pull on create]", e.message); }
    res.json({ success: true, data: cardRowPublic(db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId)) });
  } catch (e) {
    res.json({ success: false, message: "解析失败: " + e.message });
  }
});

// 生成一个新 token(binding2 每次都新签发), 并立刻拉一份 cookie 存库
app.post("/api/admin/cards/:id/mint", async (req, res) => {
  const card = db.prepare("SELECT * FROM cards WHERE id = ?").get(req.params.id);
  if (!card) return res.status(404).json({ success: false, message: "卡密不存在" });
  try {
    const r = await resolveProviderCode(card.provider_code);
    db.prepare(
      `INSERT INTO tokens (label, provider_code, card_id, token, site, product, expiry_date, bd_cnt, favorites, status, last_checked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', datetime('now','localtime'))`
    ).run(card.label || "", card.provider_code, card.id, r.token, r.site, r.product, r.expiryDate, r.bdCnt, r.favorites);
    const tok = db.prepare("SELECT * FROM tokens WHERE card_id = ? ORDER BY id DESC LIMIT 1").get(card.id);
    try {
      const sibling = findFreshSibling(tok);
      if (sibling) copySessionToToken(sibling, tok.id);
      else await pullSessionForToken(tok);
    } catch (e) { console.warn("[cookie pull on mint]", e.message); }
    db.prepare("UPDATE cards SET expiry_date=?, product=?, last_checked_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?")
      .run(r.expiryDate || card.expiry_date, r.product || card.product, card.id);
    res.json({ success: true, data: cardRowPublic(db.prepare("SELECT * FROM cards WHERE id = ?").get(card.id)) });
  } catch (e) {
    res.json({ success: false, message: "生成失败: " + e.message });
  }
});

// 刷新卡密元信息(到期等), 不铸新 token
app.post("/api/admin/cards/:id/refresh", async (req, res) => {
  const card = db.prepare("SELECT * FROM cards WHERE id = ?").get(req.params.id);
  if (!card) return res.status(404).json({ success: false, message: "卡密不存在" });
  const t = db.prepare("SELECT token FROM tokens WHERE card_id = ? AND status='active' ORDER BY id ASC LIMIT 1").get(card.id);
  if (!t) return res.json({ success: false, message: "该卡密下暂无 token, 请先生成" });
  try {
    const o = await (await fetch(`${MARSLINKER}/order/${t.token}?t=${Date.now()}`)).json();
    const d = (o && o.data) || {};
    db.prepare("UPDATE cards SET expiry_date=?, product=?, site=?, last_checked_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE id=?")
      .run(d.expiryDate || card.expiry_date, d.product || card.product, d.site || card.site, card.id);
    const tokens = db.prepare("SELECT * FROM tokens WHERE card_id = ? AND status='active'").all(card.id);
    if (tokens.length) {
      try { await pullSessionForToken(tokens[0]); } catch (e) { console.warn("[cookie pull on refresh]", e.message); }
    }
    res.json({ success: true, data: cardRowPublic(db.prepare("SELECT * FROM cards WHERE id = ?").get(card.id)) });
  } catch (e) {
    res.json({ success: false, message: "刷新失败: " + e.message });
  }
});

// 编辑卡密(备注/标签/启停)
app.put("/api/admin/cards/:id", (req, res) => {
  const card = db.prepare("SELECT * FROM cards WHERE id = ?").get(req.params.id);
  if (!card) return res.status(404).json({ success: false, message: "卡密不存在" });
  const { label, note, status } = req.body || {};
  db.prepare(
    `UPDATE cards SET label=COALESCE(@label,label), note=COALESCE(@note,note),
       status=COALESCE(@status,status), updated_at=datetime('now','localtime') WHERE id=@id`
  ).run({ id: card.id, label: label ?? null, note: note ?? null, status: status ?? null });
  res.json({ success: true, data: cardRowPublic(db.prepare("SELECT * FROM cards WHERE id = ?").get(card.id)) });
});

// 删除卡密(连同其 token; 引用它的密钥/设备解绑; 清默认)
app.delete("/api/admin/cards/:id", (req, res) => {
  const cid = req.params.id;
  const tokenIds = db.prepare("SELECT id FROM tokens WHERE card_id = ?").all(cid).map((r) => r.id);
  for (const tid of tokenIds) db.prepare("UPDATE devices SET token_id = NULL WHERE token_id = ?").run(tid);
  db.prepare("UPDATE license_keys SET card_id = NULL WHERE card_id = ?").run(cid);
  const dc = db.prepare("SELECT value FROM settings WHERE key='default_card_id'").get();
  if (dc && String(dc.value) === String(cid)) db.prepare("UPDATE settings SET value='' WHERE key='default_card_id'").run();
  db.prepare("DELETE FROM tokens WHERE card_id = ?").run(cid);
  db.prepare("DELETE FROM cards WHERE id = ?").run(cid);
  res.json({ success: true });
});

// 删除单个 token(把占用它的设备解绑; 卡密至少留 1 个 token 的限制由前端提示)
app.delete("/api/admin/tokens/:id", (req, res) => {
  db.prepare("UPDATE devices SET token_id = NULL WHERE token_id = ?").run(req.params.id);
  db.prepare("DELETE FROM tokens WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// 给某个 token 从第三方拉一份金十 cookie 存库
app.post("/api/admin/tokens/:id/pull-cookie", async (req, res) => {
  const tok = db.prepare("SELECT * FROM tokens WHERE id = ?").get(req.params.id);
  if (!tok) return res.status(404).json({ success: false, message: "token 不存在" });
  try {
    await pullSessionForToken(tok, { force: true });
    const fresh = db.prepare("SELECT * FROM tokens WHERE id = ?").get(tok.id);
    res.json({ success: true, data: tokenSubPublic(fresh) });
  } catch (e) {
    res.json({ success: false, message: "拉取失败: " + e.message });
  }
});

// 给一张卡密下所有 token 拉 cookie
app.post("/api/admin/cards/:id/pull-cookie", async (req, res) => {
  const card = db.prepare("SELECT * FROM cards WHERE id = ?").get(req.params.id);
  if (!card) return res.status(404).json({ success: false, message: "卡密不存在" });
  const tokens = db.prepare("SELECT * FROM tokens WHERE card_id = ? AND status='active'").all(card.id);
  if (!tokens.length) return res.json({ success: false, message: "该卡密下暂无 token" });
  try {
    await pullSessionForToken(tokens[0], { force: true });
  } catch (e) {
    return res.json({ success: false, message: "拉取失败: " + e.message });
  }
  res.json({
    success: true,
    message: "",
    data: cardRowPublic(db.prepare("SELECT * FROM cards WHERE id = ?").get(card.id)),
  });
});

app.get('/api/admin/keys/:id/telemetry',(req,res)=>{
 try{const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<1)throw {status:400};res.set('Cache-Control','no-store');res.json({success:true,devices:telemetry.listDevices(db,id).items,...telemetry.listEvents(db,id,req.query)});}catch(e){res.status(e.status||500).json({success:false,message:e.error||'Telemetry unavailable'});}
});
// 查看某密钥下的设备列表
app.get("/api/admin/keys/:id/devices", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM devices WHERE key_id = ? ORDER BY id ASC")
    .all(req.params.id);
  res.json({ success: true, data: rows.map(deviceRowPublic) });
});

// 编辑设备的展示昵称/头像/备注
app.put("/api/admin/devices/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM devices WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ success: false, message: "设备不存在" });

  const { nickname, avatar, deviceLabel } = req.body || {};
  const updated = db.transaction(() => {
  db.prepare(
    `UPDATE devices SET
       nickname = COALESCE(@nickname, nickname),
       avatar = COALESCE(@avatar, avatar),
       device_label = COALESCE(@deviceLabel, device_label)
     WHERE id = @id`
  ).run({ id: req.params.id, nickname: nickname ?? null, avatar: avatar ?? null, deviceLabel: deviceLabel ?? null });

  const updated = db.prepare("SELECT * FROM devices WHERE id = ?").get(req.params.id);
  const changed = ['nickname','avatar','device_label'].filter(field => row[field] !== updated[field]);
  if(changed.length) telemetry.record(db,{keyId:row.key_id,deviceId:row.id,type:'device_edit',outcome:'ok',metadata:{source:'cloud-admin',changedFields:changed.join(',')}});
  return updated;
  })();
  res.json({ success: true, data: deviceRowPublic(updated) });
});

// 踢设备下线(释放一个登录名额,不删记录,标记 kicked)
app.post("/api/admin/devices/:id/kick", (req, res) => {
  db.transaction(() => {
    const row=db.prepare('SELECT id,key_id,status FROM devices WHERE id=?').get(req.params.id);
    db.prepare("UPDATE devices SET status = 'kicked' WHERE id = ?").run(req.params.id);
    if(row && row.status !== 'kicked') { try { db.prepare("UPDATE device_presence SET online=0 WHERE device_row_id=?").run(row.id); activity.log("kicked_admin", { keyId: row.key_id, deviceRowId: row.id, deviceId: row.device_id }); } catch (e) { /* ignore */ } }
    if(row && row.status !== 'kicked') telemetry.record(db,{keyId:row.key_id,deviceId:row.id,type:'device_kick',outcome:'ok',metadata:{source:'cloud-admin',beforeStatus:row.status,afterStatus:'kicked'}});
  })();
  res.json({ success: true });
});

// 彻底删除设备记录
app.delete("/api/admin/devices/:id", (req, res) => {
  db.transaction(() => {
    const row=db.prepare('SELECT id,key_id FROM devices WHERE id=?').get(req.params.id);
    if(row) { try { db.prepare("DELETE FROM device_presence WHERE device_row_id=?").run(row.id); activity.log("device_deleted", { keyId: row.key_id, deviceId: row.device_id }); } catch (e) { /* ignore */ } }
    if(row) {telemetry.record(db,{keyId:row.key_id,deviceId:row.id,type:'device_delete',outcome:'ok',metadata:{source:'cloud-admin'}});db.prepare('DELETE FROM device_metadata WHERE device_row_id=?').run(row.id);}
    db.prepare("DELETE FROM devices WHERE id = ?").run(req.params.id);
  })();
  res.json({ success: true });
});

// 登录日志: 单个密钥的(密钥详情里用)
app.get("/api/admin/keys/:id/logs", (req, res) => {
  const rows = db
    .prepare("SELECT * FROM login_logs WHERE key_id = ? ORDER BY id DESC LIMIT 100")
    .all(req.params.id);
  res.json({ success: true, data: rows });
});

// 登录日志: 全局列表(独立的"登录日志"页面用,支持分页+筛选)
app.get("/api/admin/logs", (req, res) => {
  const { current = 1, pageSize = 20, keyCode = "", deviceId = "", result = "" } = req.query;
  const page = Math.max(1, parseInt(current, 10) || 1);
  const size = Math.max(1, Math.min(200, parseInt(pageSize, 10) || 20));

  const where = [];
  const params = {};
  if (keyCode) {
    where.push("k.key_code LIKE @keyCode");
    params.keyCode = `%${keyCode}%`;
  }
  if (deviceId) {
    where.push("l.device_id LIKE @deviceId");
    params.deviceId = `%${deviceId}%`;
  }
  if (result) {
    where.push("l.result = @result");
    params.result = result;
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = db
    .prepare(
      `SELECT COUNT(*) AS c FROM login_logs l LEFT JOIN license_keys k ON k.id = l.key_id ${whereSql}`
    )
    .get(params).c;

  const rows = db
    .prepare(
      `SELECT l.id, l.key_id, l.device_id, l.result, l.ip, l.created_at,
              k.key_code, k.name AS key_name
       FROM login_logs l
       LEFT JOIN license_keys k ON k.id = l.key_id
       ${whereSql}
       ORDER BY l.id DESC
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...params, limit: size, offset: (page - 1) * size });

  res.json({
    success: true,
    data: rows.map((r) => ({
      id: r.id,
      keyId: r.key_id,
      keyCode: r.key_code || "(已删除)",
      keyName: r.key_name || "",
      deviceId: r.device_id,
      result: r.result,
      ip: r.ip || "",
      createdAt: r.created_at,
    })),
    total,
    current: page,
    pageSize: size,
  });
});

// 概览统计: 激活口径 = 该密钥有没有被激活过(license_keys.activated_at), 与当前设备数无关
//   「测试分类」下的密钥不计入任何统计(agent.is_test = 1)
const NOT_TEST = "(agent_id IS NULL OR agent_id NOT IN (SELECT id FROM agents WHERE is_test = 1))";
function computeStats() {
  const totalKeys = db.prepare(`SELECT COUNT(*) c FROM license_keys WHERE ${NOT_TEST}`).get().c;
  const activatedCount = db
    .prepare(`SELECT COUNT(*) c FROM license_keys WHERE IFNULL(activated_at,'') != '' AND ${NOT_TEST}`)
    .get().c;
  const pendingCount = Math.max(0, totalKeys - activatedCount);
  const todayActivated = db
    .prepare(
      `SELECT COUNT(*) c FROM license_keys
        WHERE IFNULL(activated_at,'') != ''
          AND date(activated_at) = date('now','localtime')
          AND ${NOT_TEST}`
    )
    .get().c;
  const totalDevices = db
    .prepare(
      `SELECT COUNT(*) c FROM devices d
        WHERE d.status='active'
          AND d.key_id IN (SELECT id FROM license_keys WHERE ${NOT_TEST})`
    )
    .get().c;
  return {
    totalKeys,
    activatedCount,
    pendingCount,
    todayActivated,
    totalDevices,
    activeKeys: activatedCount,
  };
}

app.get("/api/admin/stats", (req, res) => {
  res.json({ success: true, data: computeStats() });
});

// 每日激活数量(按天): 每把密钥只算第一次激活, 范围内没有激活的日子补 0
app.get("/api/admin/stats/activations", (req, res) => {
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const MAX_DAYS = 90;

  const todayStr = db.prepare("SELECT date('now','localtime') d").get().d;
  const shiftDate = (base, delta) =>
    db.prepare("SELECT date(?, ?) d").get(base, `${delta} day`).d;

  let to = DATE_RE.test(String(req.query.to || "")) ? String(req.query.to) : todayStr;
  let from = DATE_RE.test(String(req.query.from || "")) ? String(req.query.from) : shiftDate(to, -6);
  if (from > to) [from, to] = [to, from];

  const spanDays = db.prepare("SELECT julianday(?) - julianday(?) AS n").get(to, from).n + 1;
  if (spanDays > MAX_DAYS) from = shiftDate(to, -(MAX_DAYS - 1));

  // 按「天 + 代理」分组: 每天每个代理一根柱子(数量为 0 的组合不返回)
  const rows = db
    .prepare(
      `SELECT date(k.activated_at) AS d,
              IFNULL(k.agent_id, 0)  AS agentId,
              IFNULL(a.name, '未关联') AS agentName,
              COUNT(*) AS c
         FROM license_keys k
         LEFT JOIN agents a ON a.id = k.agent_id
        WHERE IFNULL(k.activated_at,'') != ''
          AND date(k.activated_at) BETWEEN @from AND @to
          AND IFNULL(a.is_test, 0) = 0
        GROUP BY date(k.activated_at), IFNULL(k.agent_id, 0)
        ORDER BY d ASC, c DESC`
    )
    .all({ from, to });

  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.d)) byDate.set(r.d, []);
    byDate.get(r.d).push({ agentId: r.agentId, agentName: r.agentName, count: r.c });
  }

  const data = [];
  for (let cur = from; cur <= to; cur = shiftDate(cur, 1)) {
    const agents = byDate.get(cur) || [];
    data.push({
      date: cur,
      count: agents.reduce((s, a) => s + a.count, 0),
      agents,
    });
  }

  res.json({ success: true, data, from, to });
});

// 未激活密钥按代理统计(给「还没有激活的」卡片弹窗用); 0 的代理不返回
app.get("/api/admin/stats/pending", (req, res) => {
  const rows = db
    .prepare(
      `SELECT IFNULL(k.agent_id, 0)  AS agentId,
              IFNULL(a.name, '未关联') AS agentName,
              COUNT(*) AS c
         FROM license_keys k
         LEFT JOIN agents a ON a.id = k.agent_id
        WHERE IFNULL(k.activated_at,'') = ''
        GROUP BY IFNULL(k.agent_id, 0)
        HAVING c > 0
        ORDER BY c DESC`
    )
    .all();
  res.json({
    success: true,
    data: rows.map((r) => ({ agentId: r.agentId, agentName: r.agentName, count: r.c })),
    total: rows.reduce((s, r) => s + r.c, 0),
  });
});

// ---------------------------------------------------------------------------
// 全局设置: 兜底默认头像 + 默认卡密(未分配的密钥用它) + 修改管理员密码
// ---------------------------------------------------------------------------
function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : "";
}

function notificationEnabled(key) {
  const value = getSetting(key);
  return value === "" || value === "1";
}

function readSettings() {
  const dc = getSetting("default_card_id");
  return {
    defaultAvatar: getSetting("default_avatar"),
    defaultCardId: dc ? parseInt(dc, 10) : null,
    vipExpiryEnabled: getSetting("vip_expiry_enabled") === "1",
    vipExpiryDate: getSetting("vip_expiry_date"),
    // 邮箱提醒(密码不回传, 只告知是否已设置)
    mailEnabled: getSetting("mail_enabled") === "1",
    mailHost: getSetting("mail_host"),
    mailPort: parseInt(getSetting("mail_port"), 10) || 465,
    mailUser: getSetting("mail_user"),
    mailTo: getSetting("mail_to"),
    // 飞书机器人提醒
    feishuEnabled: getSetting("feishu_enabled") === "1",
    feishuWebhook: getSetting("feishu_webhook"),
    dingtalkEnabled: getSetting("dingtalk_enabled") === "1",
    dingtalkWebhook: getSetting("dingtalk_webhook"),
    dingtalkSecret: getSetting("dingtalk_secret"),
    notifyActivation: notificationEnabled("notify_activation"),
    notifyMars: notificationEnabled("notify_mars"),
    notifyYidian: notificationEnabled("notify_yidian"),
    reportEnabled: getSetting("report_enabled") === "1",
    reportTime: getSetting("report_time") || "22:00",
    mailPassSet: !!getSetting("mail_pass"),
    upstreamMode: marsMode(),
    marsCode: getSetting("mars_code"),
    marsReady: !!getSetting("mars_token"),
    marsSite: getSetting("mars_site"),
    marsExpiry: getSetting("mars_expiry"),
    marsBd: getSetting("mars_bd"),
    marsCookieCount: parseInt(getSetting("mars_cookie_count"), 10) || 0,
    marsXtokenExp: getSetting("mars_xtoken_exp"),
    marsPulledAt: getSetting("mars_pulled_at"),
  };
}

// 给客户端下发的 VIP 到期日展示配置(纯展示, 不影响真实授权)
function readVipDisplay() {
  const ve = db.prepare("SELECT value FROM settings WHERE key='vip_expiry_enabled'").get();
  const vd = db.prepare("SELECT value FROM settings WHERE key='vip_expiry_date'").get();
  return {
    enabled: ve ? ve.value === "1" : false,
    expiryDate: vd ? vd.value : "",
  };
}

app.get("/api/admin/settings", (req, res) => {
  res.json({ success: true, data: readSettings() });
});

// 6 小时内有过校验视为还在线。插件大约每小时会来一次。
const STABILITY_ONLINE_MS = 6 * 3600 * 1000;

function maskCode(code) {
  const s = String(code || "");
  if (s.length <= 12) return s;
  return s.slice(0, 8) + "…" + s.slice(-4);
}

function marsCacheLine() {
  const exp = getSetting("mars_xtoken_exp");
  const pulled = getSetting("mars_pulled_at");
  const cookies = parseInt(getSetting("mars_cookie_count"), 10) || 0;
  const fav = marsFavorites().length;
  const expMs = parseLocalTs(exp);
  const hasToken = !!getSetting("mars_token");
  const hasCls = !!getSetting("mars_cls_b64");
  const alive = hasToken && hasCls && !Number.isNaN(expMs) && expMs > Date.now();
  let detail = "还没有绑定登录源";
  if (hasToken && alive) detail = `登录态还在，${cookies} 个 cookie，${fav} 个快捷入口，到期 ${exp}，上次拉取 ${pulled}`;
  else if (hasToken) detail = `登录态已过期或缺失（到期 ${exp || "未知"}，上次拉取 ${pulled || "无"}）`;
  return { id: "mars", name: "MarsConnect 登录源", ok: alive, detail };
}

async function probeHop(id, name, url) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    const text = await r.text();
    let ret = false;
    try { ret = JSON.parse(text).retCode === true; } catch (e) { ret = false; }
    const ok = r.ok && ret;
    return { id, name, ok, ms: Date.now() - started, detail: ok ? "有响应，登录包正常" : `没有正常返回（HTTP ${r.status}）` };
  } catch (e) {
    const timeout = e && (e.name === "AbortError" || e.name === "TimeoutError");
    return { id, name, ok: false, ms: Date.now() - started, detail: timeout ? "超时，连不上" : "连不上" };
  } finally {
    clearTimeout(timer);
  }
}

function customerStability() {
  const now = Date.now();
  const keys = db.prepare("SELECT id, name, note, key_code, status, expiry_date FROM license_keys ORDER BY id DESC").all();
  return keys.map((k) => {
    const devs = db.prepare("SELECT status, last_seen_at, device_label FROM devices WHERE key_id = ?").all(k.id);
    const active = devs.filter((d) => d.status === "active");
    const recent = active.filter((d) => {
      const t = parseLocalTs(d.last_seen_at);
      return !Number.isNaN(t) && now - t <= STABILITY_ONLINE_MS;
    });
    let state = "idle";
    if (recent.length) state = "online";
    else if (active.length) state = "offline";
    else if (devs.length) state = "kicked";
    const seen = devs
      .map((d) => d.last_seen_at || "")
      .sort()
      .pop() || "";
    return {
      name: k.name || k.note || "未备注",
      code: maskCode(k.key_code),
      keyStatus: k.status,
      expiryDate: k.expiry_date || "",
      state,
      deviceCount: devs.length,
      onlineCount: recent.length,
      lastSeenAt: seen,
    };
  });
}

app.get("/api/admin/stability", async (req, res) => {
  const mars = marsCacheLine();
  if (mars.ok) mars.detail = "沿用现有登录态，检测不会重新拉取。" + mars.detail;
  const hops = await Promise.all([
    probeHop("relay", "上海主线路", "http://127.0.0.1:" + PORT + "/r/order/probe"),
    probeHop("backup", "备用线路", "https://xircle.autos:5635/r/order/probe", 3000),
    probeHop("legacy", "旧上上游", "https://002.myjsjsjs.cyou/marslinker/order/probe", 3000),
  ]);
  const customers = customerStability();
  res.json({
    success: true,
    checkedAt: fmtLocal(Date.now()),
    lines: [mars].concat(hops),
    summary: {
      online: customers.filter((c) => c.state === "online").length,
      offline: customers.filter((c) => c.state === "offline").length,
      other: customers.filter((c) => c.state !== "online" && c.state !== "offline").length,
    },
    customers,
  });
});

app.put("/api/admin/settings", async (req, res) => {
  const {
    defaultAvatar,
    defaultCardId,
    vipExpiryEnabled,
    vipExpiryDate,
    mailEnabled,
    mailHost,
    mailPort,
    mailUser,
    mailPass,
    mailTo,
    feishuEnabled,
    feishuWebhook,
    dingtalkEnabled,
    dingtalkWebhook,
    dingtalkSecret,
    notifyActivation,
    notifyMars,
    notifyYidian,
    reportEnabled,
    reportTime,
    newPassword,
    upstreamMode,
    marsCode,
  } = req.body || {};
  const setKV = (k, v) =>
    db
      .prepare("INSERT INTO settings (key, value) VALUES (@k, @v) ON CONFLICT(key) DO UPDATE SET value = @v")
      .run({ k, v: String(v) });
  if (defaultAvatar != null) setKV("default_avatar", defaultAvatar);
  if (defaultCardId !== undefined) setKV("default_card_id", defaultCardId == null ? "" : String(defaultCardId));
  if (vipExpiryEnabled !== undefined) setKV("vip_expiry_enabled", vipExpiryEnabled ? "1" : "0");
  if (vipExpiryDate !== undefined) setKV("vip_expiry_date", vipExpiryDate == null ? "" : String(vipExpiryDate));
  if (mailEnabled !== undefined) setKV("mail_enabled", mailEnabled ? "1" : "0");
  if (mailHost !== undefined) setKV("mail_host", mailHost == null ? "" : String(mailHost).trim());
  if (mailPort !== undefined) setKV("mail_port", String(parseInt(mailPort, 10) || 465));
  if (mailUser !== undefined) setKV("mail_user", mailUser == null ? "" : String(mailUser).trim());
  if (mailTo !== undefined) setKV("mail_to", mailTo == null ? "" : String(mailTo).trim());
  if (feishuEnabled !== undefined) setKV("feishu_enabled", feishuEnabled ? "1" : "0");
  if (feishuWebhook !== undefined) setKV("feishu_webhook", feishuWebhook == null ? "" : String(feishuWebhook).trim());
  if (dingtalkEnabled !== undefined) setKV("dingtalk_enabled", dingtalkEnabled ? "1" : "0");
  if (dingtalkWebhook !== undefined) setKV("dingtalk_webhook", dingtalkWebhook == null ? "" : String(dingtalkWebhook).trim());
  if (dingtalkSecret !== undefined) setKV("dingtalk_secret", dingtalkSecret == null ? "" : String(dingtalkSecret).trim());
  if (notifyActivation !== undefined) setKV("notify_activation", notifyActivation ? "1" : "0");
  if (notifyMars !== undefined) setKV("notify_mars", notifyMars ? "1" : "0");
  if (notifyYidian !== undefined) setKV("notify_yidian", notifyYidian ? "1" : "0");
  if (reportEnabled !== undefined) setKV("report_enabled", reportEnabled ? "1" : "0");
  if (reportTime !== undefined) setKV("report_time", /^\d{1,2}:\d{2}$/.test(String(reportTime)) ? String(reportTime) : "22:00");
  if (upstreamMode === "mars" || upstreamMode === "legacy") setKV("upstream_mode", upstreamMode);
  if (marsCode !== undefined) {
    const code = String(marsCode || "").trim();
    if (code && code !== getSetting("mars_code")) {
      try {
        await ensureMarsToken(code);
      } catch (e) {
        return res.json({ success: false, message: e.message || "订阅失败" });
      }
    } else if (code) {
      setKV("mars_code", code);
    }
  }
  // 密码留空 = 不修改已保存的授权码
  if (mailPass) setKV("mail_pass", String(mailPass).trim());
  let passwordChanged = false;
  if (newPassword) {
    setKV("admin_password", String(newPassword));
    passwordChanged = true;
  }
  res.json({ success: true, data: { ...readSettings(), passwordChanged } });
});

// 发一封测试邮件, 验证 SMTP 配置是否可用
app.post("/api/admin/settings/test-mail", async (req, res) => {
  try {
    await sendMail("【测试】密钥后台邮箱提醒", `<p>这是一封测试邮件，说明邮箱提醒配置正常。</p>${statsHtml(computeStats())}`);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message || "发送失败" });
  }
});

// 发一条测试飞书消息, 验证机器人 webhook 是否可用
app.post("/api/admin/settings/pull-upstream", async (req, res) => {
  try {
    if (marsIsFresh()) {
      const session = marsSessionFromStore() || {};
      return res.json({
        success: true,
        skipped: true,
        message: "登录态还有效，没有重新拉取。重新拉取会把正在用的客户踢下线。",
        data: {
          site: session.site || "",
          expiryDate: session.expiryDate || "",
          xtokenExp: session.xtokenExp || "",
          pulledAt: session.pulledAt || "",
          cookieCount: parseInt(getSetting("mars_cookie_count"), 10) || 0,
        },
      });
    }
    const session = await refreshMarsPack({ force: true });
    res.json({
      success: true,
      data: {
        site: session.site,
        expiryDate: session.expiryDate,
        xtokenExp: session.xtokenExp,
        pulledAt: session.pulledAt,
        cookieCount: parseInt(getSetting("mars_cookie_count"), 10) || 0,
      },
    });
  } catch (e) {
    res.json({ success: false, message: e.message || "拉取失败" });
  }
});

app.get("/api/admin/mars-guard", (req, res) => {
  res.json({ success: true, data: marsGuard.status() });
});
app.post("/api/admin/mars-guard/reset", async (req, res) => {
  marsGuard.reset();
  try {
    const p = await marsGuard.check(true);
    res.json({ success: true, data: { check: p, status: marsGuard.status() } });
  } catch (e) {
    res.json({ success: false, message: e.message, data: marsGuard.status() });
  }
});

app.post("/api/admin/settings/test-dingtalk", async (req, res) => {
  try {
    await dingtalk.markdown("工作台提醒", `### ✅ 钉钉提醒已连通\n\n看到这条说明配置正常。激活提醒、登录态告警、每日日报都会发到这里。`);
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message || "发送失败" });
  }
});

app.post("/api/admin/report/send", async (req, res) => {
  try {
    const g = await report.send(0);
    res.json({ success: true, data: { url: g.url, file: g.file } });
  } catch (e) {
    res.json({ success: false, message: e.message || "生成失败" });
  }
});

app.get("/api/admin/report/preview", async (req, res) => {
  try {
    const g = await report.generate(0);
    res.sendFile(g.file, { root: path.join(__dirname, "uploads") });
  } catch (e) {
    res.json({ success: false, message: e.message });
  }
});

app.post("/api/admin/settings/test-feishu", async (req, res) => {
  try {
    await postFeishu(feishuCard("测试 · 飞书提醒已连通", [["说明", "看到这条说明配置正常，有人激活时会自动推送"]], computeStats()));
    res.json({ success: true });
  } catch (e) {
    res.json({ success: false, message: e.message || "发送失败" });
  }
});

// ---------------------------------------------------------------------------
// 邮箱提醒: 有人第一次激活密钥时给管理员发一封, 附带当前激活概览
//   发送失败只写日志, 绝不影响客户端激活流程
// ---------------------------------------------------------------------------
function readMailConfig() {
  const user = getSetting("mail_user");
  return {
    enabled: getSetting("mail_enabled") === "1",
    host: getSetting("mail_host"),
    port: parseInt(getSetting("mail_port"), 10) || 465,
    user,
    pass: getSetting("mail_pass"),
    to: getSetting("mail_to") || user,
  };
}

let _transport = null;
let _transportKey = "";
function getTransport(cfg) {
  let nodemailer;
  try {
    nodemailer = require("nodemailer");
  } catch (e) {
    throw new Error("服务器还没安装 nodemailer, 请在 server 目录执行 npm install nodemailer");
  }
  const key = [cfg.host, cfg.port, cfg.user, cfg.pass].join("|");
  if (!_transport || _transportKey !== key) {
    _transport = nodemailer.createTransport({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.port === 465, // 465=SSL, 587=STARTTLS
      auth: { user: cfg.user, pass: cfg.pass },
    });
    _transportKey = key;
  }
  return _transport;
}

function statsHtml(s) {
  const row = (label, value, color) =>
    `<tr><td style="padding:6px 12px;color:#666">${label}</td>` +
    `<td style="padding:6px 12px;font-weight:700;color:${color}">${value}</td></tr>`;
  return (
    `<table style="border-collapse:collapse;margin-top:8px;font-size:14px">` +
    row("累计激活成功", `${s.activatedCount} 位`, "#3f8600") +
    row("还没有激活", `${s.pendingCount} 个`, "#d46b08") +
    row("今日激活", `${s.todayActivated} 个`, "#1677ff") +
    row("密钥总数", `${s.totalKeys} 个`, "#333") +
    row("在线设备数", `${s.totalDevices} 台`, "#333") +
    `</table>`
  );
}

// 邮件里的「该代理概览」小节(没关联代理返回空串)
function agentStatsHtml(agent) {
  if (!agent) return "";
  const row = (label, value, color) =>
    `<tr><td style="padding:6px 12px;color:#666">${label}</td>` +
    `<td style="padding:6px 12px;font-weight:700;color:${color}">${value}</td></tr>`;
  const quota = agent.capacity > 0 ? `${agent.total}/${agent.capacity}` : `${agent.total}`;
  return (
    `<h4 style="margin:16px 0 0">代理「${agent.name}」</h4>` +
    `<table style="border-collapse:collapse;margin-top:8px;font-size:14px">` +
    row("今日激活", `${agent.today} 个`, "#1677ff") +
    row("已激活", `${agent.activated} 位`, "#3f8600") +
    row("剩余未激活", `${agent.pending} 个`, "#d46b08") +
    row("持有密钥", `${quota} 个`, "#333") +
    `</table>`
  );
}

async function sendMail(subject, html) {
  const cfg = readMailConfig();
  if (!cfg.host || !cfg.user || !cfg.pass || !cfg.to) {
    throw new Error("邮箱提醒配置不完整(服务器/账号/授权码/收件人都要填)");
  }
  await getTransport(cfg).sendMail({ from: cfg.user, to: cfg.to, subject, html });
}

// ---------------------------------------------------------------------------
// 飞书提醒: 自定义机器人 webhook(HTTP POST), 发交互卡片
// ---------------------------------------------------------------------------
function readFeishuConfig() {
  return {
    enabled: getSetting("feishu_enabled") === "1",
    webhook: getSetting("feishu_webhook"),
  };
}

async function postFeishu(payload) {
  const cfg = readFeishuConfig();
  if (!cfg.webhook) throw new Error("还没填飞书机器人 Webhook 地址");
  const r = await fetch(cfg.webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  // 飞书成功时 code=0; 失败会带 code/msg
  if (data && data.code && data.code !== 0) {
    throw new Error(`飞书返回错误: ${data.msg || JSON.stringify(data)}`);
  }
  if (!r.ok) throw new Error(`飞书 HTTP ${r.status}`);
  return data;
}

// 单个代理的激活情况(用于飞书卡片里先报这个代理自己的数)
function agentStats(agentId) {
  if (!agentId) return null;
  const a = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!a) return null;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN IFNULL(activated_at,'') != '' THEN 1 ELSE 0 END) AS activated,
              SUM(CASE WHEN IFNULL(activated_at,'') != ''
                        AND date(activated_at) = date('now','localtime') THEN 1 ELSE 0 END) AS today
         FROM license_keys WHERE agent_id = ?`
    )
    .get(agentId);
  const total = row.total || 0;
  const activated = row.activated || 0;
  return {
    name: a.name || "",
    capacity: a.capacity || 0,
    total,
    activated,
    pending: Math.max(0, total - activated),
    today: row.today || 0,
  };
}

// 组装飞书卡片(激活详情 + 该代理概览 + 全站概览)
function feishuCard(title, fields, stats, agent) {
  const lines = fields.map(([k, v]) => `**${k}：**${v}`).join("\n");

  const elements = [{ tag: "div", text: { tag: "lark_md", content: lines } }, { tag: "hr" }];

  // 先报这个代理自己的数(没关联代理就跳过)
  if (agent) {
    const quota = agent.capacity > 0 ? `${agent.total}/${agent.capacity}` : `${agent.total}`;
    const agentBlock =
      `**【${agent.name}】今日激活：**<font color='blue'>${agent.today} 个</font>\n` +
      `**【${agent.name}】已激活：**<font color='green'>${agent.activated} 位</font>\n` +
      `**【${agent.name}】剩余未激活：**<font color='orange'>${agent.pending} 个</font>\n` +
      `**【${agent.name}】持有密钥：**${quota} 个`;
    elements.push({ tag: "div", text: { tag: "lark_md", content: agentBlock } });
    elements.push({ tag: "hr" });
  }

  const overview =
    `**累计激活成功：**<font color='green'>${stats.activatedCount} 位</font>\n` +
    `**还没有激活：**<font color='orange'>${stats.pendingCount} 个</font>\n` +
    `**今日激活：**<font color='blue'>${stats.todayActivated} 个</font>\n` +
    `**密钥总数：**${stats.totalKeys} 个`;
  elements.push({ tag: "div", text: { tag: "lark_md", content: overview } });

  return {
    msg_type: "interactive",
    card: {
      config: { wide_screen_mode: true },
      header: { title: { tag: "plain_text", content: title }, template: "green" },
      elements,
    },
  };
}

// 首次激活提醒: 邮件 + 飞书, 各自按开关独立发送, 失败只记日志
function notifyActivation(keyRow) {
  if (!notificationEnabled("notify_activation")) return;
  let s, who, agentName, now;
  try {
    s = computeStats();
    who = keyRow.name || keyRow.key_code;
    agentName = "";
    if (keyRow.agent_id) {
      const a = db.prepare("SELECT name FROM agents WHERE id = ?").get(keyRow.agent_id);
      if (a) agentName = a.name || "";
    }
    now = db.prepare("SELECT datetime('now','localtime') t").get().t;
  } catch (e) {
    console.error("[notify] 组装激活提醒失败:", e.message);
    return;
  }

  // ---- 邮件 ----
  if (readMailConfig().enabled) {
    try {
      const html =
        `<div style="font-family:-apple-system,'Microsoft YaHei',sans-serif">` +
        `<h3 style="margin:0 0 12px">有人激活了订阅码</h3>` +
        `<table style="border-collapse:collapse;font-size:14px">` +
        `<tr><td style="padding:6px 12px;color:#666">密钥</td><td style="padding:6px 12px;font-family:monospace">${keyRow.key_code}</td></tr>` +
        `<tr><td style="padding:6px 12px;color:#666">备注名</td><td style="padding:6px 12px">${keyRow.name || "—"}</td></tr>` +
        `<tr><td style="padding:6px 12px;color:#666">关联代理</td><td style="padding:6px 12px">${agentName || "未关联"}</td></tr>` +
        `<tr><td style="padding:6px 12px;color:#666">激活时间</td><td style="padding:6px 12px">${now}</td></tr>` +
        `<tr><td style="padding:6px 12px;color:#666">到期时间</td><td style="padding:6px 12px">${keyRow.expiry_date || "永久"}</td></tr>` +
        `</table>` +
        agentStatsHtml(agentStats(keyRow.agent_id)) +
        `<h4 style="margin:16px 0 0">当前概览</h4>` +
        statsHtml(s) +
        `</div>`;
      const subject = `【激活提醒】${who} 激活成功 · 累计 ${s.activatedCount} 位 · 今日 ${s.todayActivated} 个`;
      sendMail(subject, html).catch((e) => console.error("[mail] 激活提醒发送失败:", e.message));
    } catch (e) {
      console.error("[mail] 激活提醒失败:", e.message);
    }
  }

  // ---- 飞书 ----
  if (readFeishuConfig().enabled) {
    try {
      const card = feishuCard(
        `激活成功 · ${who}`,
        [
          ["密钥", keyRow.key_code],
          ["备注名", keyRow.name || "—"],
          ["关联代理", agentName || "未关联"],
          ["激活时间", now],
          ["到期时间", keyRow.expiry_date || "永久"],
        ],
        s,
        agentStats(keyRow.agent_id)
      );
      postFeishu(card).catch((e) => console.error("[feishu] 激活提醒发送失败:", e.message));
    } catch (e) {
      console.error("[feishu] 激活提醒失败:", e.message);
    }
  }

  // ---- 钉钉 ----
  if (dingtalk.config().enabled) {
    try {
      const exp = keyRow.expiry_date || "永久";
      const days = /^\d{4}-\d{2}-\d{2}/.test(exp)
        ? Math.ceil((Date.parse(exp.slice(0, 10) + "T23:59:59+08:00") - Date.now()) / 86400000)
        : null;
      const agent = agentStats(keyRow.agent_id);
      const text =
        `### 🎉 新客户激活\n\n` +
        `- **客户**：${who}（${keyRow.key_code.length > 10 ? keyRow.key_code.slice(0, 10) + "····" + keyRow.key_code.slice(-4) : keyRow.key_code}）\n` +
        `- **代理**：${agentName || "未关联"}\n` +
        `- **到期**：${exp.slice(0, 10)}${days != null ? `（${days} 天）` : ""}\n` +
        `- **时间**：${now}\n\n---\n\n` +
        `**今日** 激活 ${s.todayActivated} 个 ｜ **累计** 激活 ${s.activatedCount} 位 ｜ 未激活 ${s.pendingCount} 个` +
        (agent ? `\n\n**${agent.name}**：已激活 ${agent.activated} ｜ 剩余 ${agent.pending}${agent.capacity > 0 ? ` ｜ 持有 ${agent.total}/${agent.capacity}` : ""}` : "");
      dingtalk.markdown(`新客户激活 · ${who}`, text).catch((e) => console.error("[dingtalk] 激活提醒发送失败:", e.message));
    } catch (e) {
      console.error("[dingtalk] 激活提醒失败:", e.message);
    }
  }
}

// ---------------------------------------------------------------------------
// 给某设备从一张卡密里分配一个 token(名额粘性): 复用已占用的; 否则挑最空且未满的
// ---------------------------------------------------------------------------
function assignTokenForDevice(cardId, device) {
  const tokens = db
    .prepare("SELECT * FROM tokens WHERE card_id = ? AND status = 'active' ORDER BY id ASC")
    .all(cardId);
  if (!tokens.length) return null;
  if (device && device.token_id) {
    const cur = tokens.find((t) => t.id === device.token_id);
    if (cur) return cur;
  }
  const withCookie = tokens.filter((t) => t.cls_b64 && String(t.cls_b64).length > 20);
  const pool = withCookie.length ? withCookie : tokens;
  const counts = db
    .prepare("SELECT token_id AS id, COUNT(*) AS c FROM devices WHERE status='active' AND token_id IS NOT NULL GROUP BY token_id")
    .all();
  const countMap = new Map(counts.map((r) => [r.id, r.c]));
  pool.sort((a, b) => (countMap.get(a.id) || 0) - (countMap.get(b.id) || 0) || a.id - b.id);
  return pool[0];
}

// ---------------------------------------------------------------------------
// 授权票据: 用 ECDSA P-256 私钥对 {key,deviceId,exp,iat,grace} 签名下发。
//   插件内置公钥验签, 用签名里的 exp 作为唯一到期依据, 用户改本地存储无效。
// ---------------------------------------------------------------------------
let TICKET_KEY = null;
try {
  const _tp = path.join(__dirname, "ticket_key.pem");
  if (fs.existsSync(_tp)) TICKET_KEY = fs.readFileSync(_tp, "utf8");
} catch (e) { /* 没有私钥则不下发票据, 插件回退明文行为 */ }
function signTicket(obj) {
  if (!TICKET_KEY) return null;
  try {
    const buf = Buffer.from(JSON.stringify(obj));
    const sig = crypto.sign("sha256", buf, { key: TICKET_KEY, dsaEncoding: "ieee-p1363" });
    return { p: buf.toString("base64"), s: sig.toString("base64") };
  } catch (e) {
    return null;
  }
}
function ticketExpSec(expiryDate) {
  if (!expiryDate) return 0; // 0 = 永久(无硬到期)
  const t = new Date(String(expiryDate).replace(" ", "T")).getTime();
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}
// 预签发多期票据: 一次 4 张、每张 7 天窗口(nbf..exp), 都不超订阅到期。
//   插件按周依次启用 -> 我们挂 28 天用户无感; 但签不出超订阅期的票, 白嫖不了。
function signTickets(base, subExpSec) {
  const PERIOD = 7 * 86400;
  const MAX_PERIODS = 4;
  const out = [];
  for (let i = 0; i < MAX_PERIODS; i++) {
    const nbf = base.iat + i * PERIOD;
    if (subExpSec && nbf >= subExpSec) break; // 已超订阅期, 不再签
    let exp = base.iat + (i + 1) * PERIOD;
    if (subExpSec && exp > subExpSec) exp = subExpSec;
    const t = signTicket({ ...base, nbf, exp });
    if (t) out.push(t);
    if (subExpSec && exp >= subExpSec) break; // 到订阅期就够了
  }
  return out;
}

// ===========================================================================
// 客户端接口: /api/client/verify —— 插件/工具启动时调用
// 逻辑: 同一 device_id 已登录过 -> 放行并刷新 last_seen;
// 名额已满时，踢掉用得最少的那台，不按最早注册的踢。
// 同样很少用时，先踢最久没打开的。正在用的（30 分钟内打开过）先留着。
// 刚被挤掉的设备 6 小时内不能再把别人挤掉，避免两台空设备来回互踢。
function freeDeviceSlot(keyRow, incomingDeviceId) {
  const activeCount = db
    .prepare("SELECT COUNT(*) c FROM devices WHERE key_id = ? AND status = 'active'")
    .get(keyRow.id).c;
  if (activeCount < keyRow.max_devices) return true;
  const rows = db.prepare(
    `SELECT d.id, d.device_id, d.last_seen_at,
        (SELECT COUNT(*) FROM login_logs l
          WHERE l.key_id = d.key_id AND l.device_id = d.device_id AND l.result = 'ok') AS uses
      FROM devices d
      WHERE d.key_id = ? AND d.status = 'active' AND d.device_id != ?`
  ).all(keyRow.id, incomingDeviceId);
  if (!rows.length) return false;
  const seenAt = (row) => new Date(String(row.last_seen_at || "").replace(" ", "T")).getTime() || 0;
  const idleCut = Date.now() - 6 * 60 * 60 * 1000;
  const idle = rows.filter((row) => seenAt(row) < idleCut);
  let pool = idle;
  if (!pool.length) {
    const kicked = db.prepare(
      "SELECT created_at FROM login_logs WHERE key_id = ? AND device_id = ? AND result = 'kicked_idle' ORDER BY id DESC LIMIT 1"
    ).get(keyRow.id, incomingDeviceId);
    const kickedAt = kicked ? new Date(String(kicked.created_at).replace(" ", "T")).getTime() : 0;
    if (kickedAt && Date.now() - kickedAt < 6 * 60 * 60 * 1000) return false;
    const hotCut = Date.now() - 10 * 60 * 1000;
    pool = rows.filter((row) => seenAt(row) < hotCut);
    if (!pool.length) pool = rows;
  }
  pool.sort((a, b) => a.uses - b.uses || seenAt(a) - seenAt(b));
  const victim = pool[0];
  db.prepare("UPDATE devices SET status = 'kicked' WHERE id = ?").run(victim.id);
  db.prepare("INSERT INTO login_logs (key_id, device_id, result, ip) VALUES (?, ?, 'kicked_idle', '')")
    .run(keyRow.id, victim.device_id);
  try { db.prepare("UPDATE device_presence SET online=0 WHERE device_row_id=?").run(victim.id); activity.log("kicked_idle", { keyId: keyRow.id, deviceRowId: victim.id, deviceId: victim.device_id, detail: "新设备登录，名额已满，挤掉最久没用的这台" }); } catch (e) { /* ignore */ }
  return true;
}

//       新设备 -> 检查 active 设备数是否 < max_devices,不够就踢掉用得最少的那台
// ===========================================================================
app.get("/api/internal/mars-pack", async (req, res) => {
  const key = getSetting("mars_sync_key");
  if (!key || req.get("x-sync-key") !== key) return res.status(404).end();
  const session = await marsSession();
  if (!session || !session.cls) return res.json({ retCode: false, retMsg: "登录态还没准备好" });
  res.json({
    retCode: true,
    data: {
      cls: session.cls,
      rule: session.rule || "",
      site: session.site,
      favorites: session.favorites || [],
      expiryDate: session.expiryDate || "",
      pulledAt: getSetting("mars_pulled_at") || "",
      xtokenExp: getSetting("mars_xtoken_exp") || "",
    },
  });
});

app.post("/api/client/verify", async (req, res) => {
  const { key, deviceId, deviceLabel = "", appId = "", cookieMode = false, forceCookie = false } = req.body || {};
  if (!key || !deviceId) {
    return res.status(400).json({ retCode: false, retMsg: "缺少 key 或 deviceId" });
  }
  // 旧的无前缀密钥继续兼容，避免影响已安装客户。
  // 新格式密钥必须由云看板插件携带正确产品标识，其他插件不能串用。
  if (String(key).startsWith("#") && (!String(key).startsWith("#YKB-") || appId !== "YKB")) {
    return res.json({ retCode: false, retMsg: "该密钥不适用于当前插件" });
  }

  const clientIp = req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
  let keyRow = db.prepare("SELECT * FROM license_keys WHERE key_code = ?").get(key);
  const reqUa = req.get("user-agent") || "";
  const reqPlatform = activity.platformOf(reqUa, (req.body || {}).platform);
  const reqVersion = activity.versionOf(reqUa, req.body || {});
  const logResult = (result) => {
    db.prepare("INSERT INTO login_logs (key_id, device_id, result, ip) VALUES (?, ?, ?, ?)").run(keyRow ? keyRow.id : 0, deviceId, result, clientIp);
    try {
      const drow = keyRow ? db.prepare("SELECT id FROM devices WHERE key_id=? AND device_id=?").get(keyRow.id, deviceId) : null;
      if (result !== "ok") {
        activity.log(result, { keyId: keyRow ? keyRow.id : null, deviceRowId: drow ? drow.id : null, deviceId, platform: reqPlatform, version: reqVersion, ip: clientIp,
          detail: result === "rejected_notfound" ? "输入的订阅码：" + String(key).slice(0, 40) : "" });
      }
    } catch (e) { /* ignore */ }
    if(keyRow) {
      const row=db.prepare('SELECT id FROM devices WHERE key_id=? AND device_id=?').get(keyRow.id,deviceId);
      try { telemetry.record(db,{keyId:keyRow.id,deviceId:row?.id||null,type:'verify',outcome:result==='ok'?'ok':'rejected',reason:result,metadata:telemetry.identify(req.headers,req.body)}); } catch { console.warn('[telemetry] collection unavailable'); }
    }
  };

  if (!keyRow) {
    logResult("rejected_notfound");
    return res.json({ retCode: false, retMsg: "密钥不存在" });
  }
  if (keyRow.status !== "active") {
    logResult("rejected_disabled");
    return res.json({ retCode: false, retMsg: "密钥已被封禁" });
  }
  if (isExpired(keyRow.expiry_date)) {
    logResult("rejected_expired");
    return res.json({ retCode: false, retMsg: "密钥已过期" });
  }

  // 这把密钥此前从没被激活过 = 本次是它的第一次激活(用于提醒)
  const isFirstActivation = !keyRow.activated_at;

  let device = db
    .prepare("SELECT * FROM devices WHERE key_id = ? AND device_id = ?")
    .get(keyRow.id, deviceId);

  if (device) {
    // 被挤掉过的设备再来，名额满了就先腾出用得最少的那台
    if (device.status !== "active") {
      if (!freeDeviceSlot(keyRow, deviceId)) {
        logResult("rejected_limit");
        return res.json({ retCode: false, retMsg: "登录设备数已达上限" });
      }
      db.prepare("UPDATE devices SET status = 'active' WHERE id = ?").run(device.id);
    }
    db.prepare(
      "UPDATE devices SET last_seen_at = datetime('now','localtime'), device_label = COALESCE(?, device_label) WHERE id = ?"
    ).run(deviceLabel || null, device.id);
    device = db.prepare("SELECT * FROM devices WHERE id = ?").get(device.id);
  } else {
    if (!freeDeviceSlot(keyRow, deviceId)) {
      logResult("rejected_limit");
      return res.json({ retCode: false, retMsg: `登录设备数已达上限(${keyRow.max_devices}台)` });
    }
    const info = db
      .prepare(
        "INSERT INTO devices (key_id, device_id, device_label) VALUES (?, ?, ?)"
      )
      .run(keyRow.id, deviceId, deviceLabel);
    device = db.prepare("SELECT * FROM devices WHERE id = ?").get(info.lastInsertRowid);
    try { activity.log("bind", { keyId: keyRow.id, deviceRowId: device.id, deviceId, platform: reqPlatform, version: reqVersion, ip: clientIp }); } catch (e) { /* ignore */ }
    try { telemetry.record(db,{keyId:keyRow.id,deviceId:device.id,type:'device_bind',outcome:'ok',metadata:telemetry.identify(req.headers,req.body)}); } catch { console.warn('[telemetry] collection unavailable'); }
  }

  logResult("ok");
  try {
    activity.log(isFirstActivation ? "activate" : "verify_ok", { keyId: keyRow.id, deviceRowId: device.id, deviceId, platform: reqPlatform, version: reqVersion, ip: clientIp });
    activity.touch({ deviceRowId: device.id, keyId: keyRow.id, ip: clientIp, ua: reqUa, platform: reqPlatform, version: reqVersion, source: "verify" });
  } catch (e) { /* ignore */ }

  // 记下首次激活时间(激活状态以此为准, 与当前设备数无关)
  keyRow = markActivated(keyRow);

  // 首次激活: 把「激活后 N 天」落成真实到期日(只写一次, 踢设备不会重算)
  keyRow = startValidityIfNeeded(keyRow);

  // 首次激活给管理员发邮件提醒(异步, 失败不影响激活)
  if (isFirstActivation) notifyActivation(keyRow);

  // 昵称/头像跟"订阅码"走(同一订阅码下所有设备共用),不再按设备区分
  const nick = keyRow.nickname || "";
  let avatar = keyRow.avatar || "";
  // 头像兜底: 订阅码没设头像时,用全局默认头像
  if (!avatar) {
    const settingRow = db.prepare("SELECT value FROM settings WHERE key = 'default_avatar'").get();
    avatar = settingRow ? settingRow.value : "";
  }

  // 该密钥分配的卡密; 没分配则用全局默认卡密。从卡密里给本设备分一个 token(名额粘性)
  let cardId = keyRow.card_id || null;
  if (!cardId) {
    const dc = db.prepare("SELECT value FROM settings WHERE key = 'default_card_id'").get();
    if (dc && dc.value) cardId = parseInt(dc.value, 10);
  }
  let token = "";
  let site = "www.jin10.com";
  let tk = null;
  if (cardId) {
    const card = db.prepare("SELECT * FROM cards WHERE id = ?").get(cardId);
    if (card && card.status !== "disabled") {
      tk = assignTokenForDevice(cardId, device);
      if (tk) {
        token = tk.token || "";
        site = tk.site || "www.jin10.com";
        if (device.token_id !== tk.id) {
          db.prepare("UPDATE devices SET token_id = ? WHERE id = ?").run(tk.id, device.id);
        }
      }
    }
  }

  // cookieMode 只给新插件。上游选 MarsConnect 时优先下发那一份登录包，失败再退回卡密里的旧包。
  let session = null;
  if (cookieMode && marsMode() === "mars") {
    try {
      session = await marsSession(forceCookie);
      if (session && session.site) site = session.site;
    } catch (e) {
      console.warn("[mars session]", e.message);
    }
  }
  if (cookieMode && !session && tk) {
    try {
      if (forceCookie) {
        tk = await pullSessionForToken(tk, { force: true });
      } else if (!cookieIsFresh(tk)) {
        tk = await pullSessionForToken(tk);
      }
    } catch (e) {
      console.warn("[cookie pull on verify]", e.message);
    }
    session = sessionFromToken(tk);
    if (tk && tk.site) site = tk.site || site;
  }

  const payload = {
    keyName: keyRow.name,
    expiryDate: keyRow.expiry_date,
    maxDevices: keyRow.max_devices,
    display: { nick, avatar },
    vipDisplay: readVipDisplay(),
    token,
    site,
  };
  if (cookieMode) payload.session = session;
  const nowSec = Math.floor(Date.now() / 1000);
  const tickets = signTickets({ key, deviceId, iat: nowSec, grace: 10, ver: 1 }, ticketExpSec(keyRow.expiry_date));
  if (tickets.length) {
    payload.tickets = tickets;      // 多期票据
    payload.ticket = tickets[0];    // 兼容只认单票据的老插件
  }
  res.json({
    retCode: true,
    data: payload,
  });
});

// 托管前端(打包后的后台页面): node 一个进程同时提供 API 与静态页, 宝塔只需反代一个端口
const WEB_DIR = path.join(__dirname, "..", "web", "dist");
if (fs.existsSync(WEB_DIR)) {
  app.use(express.static(WEB_DIR));
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    if (req.path.startsWith("/api") || req.path.startsWith("/dl") || req.path.startsWith("/uploads")) return next();
    res.sendFile(path.join(WEB_DIR, "index.html"));
  });
}

const PORT = process.env.PORT || 3721;
async function yidianAlert(text) {
  if (!notificationEnabled("notify_yidian")) return;
  console.warn("[yidian]", text);
  if (!dingtalk.config().enabled && !readFeishuConfig().enabled) return;
  try {
    await notifyAdmin(`### 📦 易店发货\n\n${text}`);
  } catch (e) {
    console.warn("[yidian feishu]", e.message);
  }
}
function topUpYidianStock(target = 5) {
  const shops = db.prepare("SELECT * FROM yidian_shops WHERE enabled=1").all();
  for (const shop of shops) {
    const stock = yidian.stockOfShop(db, shop.id);
    const trialNeed = Math.max(0, target - stock.trial);
    const formalNeed = Math.max(0, target - stock.formal);
    if (!trialNeed && !formalNeed) continue;
    const defaults = shopKeyDefaults(shop);
    const q = checkAgentQuota(defaults.agentId, trialNeed + formalNeed);
    if (!q.ok) {
      console.warn("[yidian topup]", q.msg);
      continue;
    }
    db.transaction(() => {
      for (let i = 0; i < trialNeed; i++) insertShopStockKey(shop, "trial");
      for (let i = 0; i < formalNeed; i++) insertShopStockKey(shop, "formal");
    })();
  }
}
let yidianTicking = false;
async function yidianPoll() {
  if (yidianTicking) return;
  yidianTicking = true;
  try {
    const account = yidian.accountConfig(db);
    if (!account.account || !account.hasPassword) return;
    try { topUpYidianStock(5); } catch (e) { console.warn("[yidian topup]", e.message); }
    await yidian.tick(db, { ship: true, logEvents: false, onAlert: yidianAlert });
  } catch (e) {
    console.warn("[yidian poll]", e.message);
  } finally {
    yidianTicking = false;
  }
}
setInterval(yidianPoll, 45000);
setTimeout(yidianPoll, 8000);
try {
  const rows = db.prepare("SELECT id, cls_b64 FROM tokens WHERE length(IFNULL(cls_b64,'')) > 20").all();
  const upd = db.prepare("UPDATE tokens SET cls_b64=? WHERE id=?");
  let n = 0;
  for (const row of rows) {
    const next = sanitizeClsB64(row.cls_b64);
    if (next && next !== row.cls_b64) {
      upd.run(next, row.id);
      n += 1;
    }
  }
  if (n) console.log("[cls sanitize] rewritten", n, "tokens");
} catch (e) {
  console.warn("[cls sanitize] rewrite skip:", e.message);
}
// 只监听回环, 对外一律走 nginx 反代(隐蔽方案)
app.listen(PORT, "127.0.0.1", () => {
  console.log(`密钥分发后台 API 已启动: http://127.0.0.1:${PORT}`);
  scheduleMarsKeep();
  marsGuard.start();
  report.start();
});
