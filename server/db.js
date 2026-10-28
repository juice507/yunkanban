// 数据库初始化: sqlite 单文件, 零配置
const path = require("path");
const Database = require("better-sqlite3");

const dbPath = path.join(__dirname, "data.sqlite");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS license_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key_code      TEXT NOT NULL UNIQUE,      -- 密钥本体, 如 XXXXX-XXXXX-XXXXX-XXXXX
  name          TEXT DEFAULT '',           -- 备注名(给哪个客户/用途)
  nickname      TEXT DEFAULT '',           -- 展示昵称(该订阅码下所有设备共用)
  avatar        TEXT DEFAULT '',           -- 展示头像URL(该订阅码下所有设备共用)
  max_devices   INTEGER NOT NULL DEFAULT 3,-- 最多登录设备数
  status        TEXT NOT NULL DEFAULT 'active', -- active | disabled
  expiry_date   TEXT DEFAULT '',           -- 到期时间 ISO字符串, 空=永久
  note          TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS devices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id        INTEGER NOT NULL REFERENCES license_keys(id) ON DELETE CASCADE,
  device_id     TEXT NOT NULL,             -- 客户端生成的设备唯一标识
  nickname      TEXT DEFAULT '',           -- 该设备展示昵称
  avatar        TEXT DEFAULT '',           -- 该设备展示头像URL
  device_label  TEXT DEFAULT '',           -- 设备备注(如 "老王的电脑")
  status        TEXT NOT NULL DEFAULT 'active', -- active | kicked
  first_login_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_seen_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(key_id, device_id)
);

CREATE TABLE IF NOT EXISTS login_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id        INTEGER NOT NULL,
  device_id     TEXT NOT NULL,
  result        TEXT NOT NULL,             -- ok | rejected_limit | rejected_disabled | rejected_expired | rejected_notfound
  ip            TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

-- Token 池: 每条是一个第三方卡密解析出来的登录态 token
CREATE TABLE IF NOT EXISTS tokens (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT DEFAULT '',           -- 备注(哪个第三方账号/来源)
  provider_code TEXT NOT NULL,             -- 第三方卡密(如 4NVap-...)
  token         TEXT DEFAULT '',           -- binding2 解析出的 token(UUID)
  site          TEXT DEFAULT 'www.jin10.com',
  product       TEXT DEFAULT '',
  expiry_date   TEXT DEFAULT '',           -- order 返回的到期串(如 20991231235959)
  bd_cnt        INTEGER DEFAULT 0,         -- 第三方绑定数
  favorites     TEXT DEFAULT '',           -- order 返回的收藏夹JSON
  status        TEXT NOT NULL DEFAULT 'active', -- active | invalid | disabled
  last_checked_at TEXT DEFAULT '',
  note          TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 代理库: 一个代理(下游分销), 有客户服务数量(配额), 密钥可关联到某个代理
CREATE TABLE IF NOT EXISTS agents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT DEFAULT '',           -- 代理名字
  capacity      INTEGER NOT NULL DEFAULT 0,-- 客户服务数量(可关联密钥数上限, 0=不限)
  note          TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 卡密池: 一张第三方卡密(订单号), 下面挂 token; token 上保存金十 cookie 包
CREATE TABLE IF NOT EXISTS cards (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  label         TEXT DEFAULT '',           -- 备注(哪个第三方账号/来源)
  provider_code TEXT NOT NULL UNIQUE,      -- 第三方卡密/订单号
  product       TEXT DEFAULT '',
  site          TEXT DEFAULT 'www.jin10.com',
  expiry_date   TEXT DEFAULT '',           -- 第三方到期串
  status        TEXT NOT NULL DEFAULT 'active', -- active | disabled
  last_checked_at TEXT DEFAULT '',
  note          TEXT DEFAULT '',
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- 插件库: 上传的插件安装包, 生成公开一键下载链接(/dl/<slug>/<文件名>)
CREATE TABLE IF NOT EXISTS plugin_files (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT DEFAULT '',           -- 展示名(客户看到的名字)
  slug           TEXT NOT NULL UNIQUE,      -- 随机短码, 下载链接用
  filename       TEXT NOT NULL,             -- 磁盘存储文件名
  original_name  TEXT DEFAULT '',           -- 上传时的原始文件名
  ext            TEXT DEFAULT '',           -- 扩展名(小写, 含点, 如 .xpi)
  mime           TEXT DEFAULT '',           -- 下载时使用的 Content-Type
  size           INTEGER DEFAULT 0,         -- 文件字节数
  platform       TEXT DEFAULT 'other',      -- pc | android | ios | other
  download_count INTEGER DEFAULT 0,
  note           TEXT DEFAULT '',
  created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// 迁移: 给老库补列(如果是从旧版本升级上来的),列已存在会报错,忽略即可
for (const sql of [
  "ALTER TABLE login_logs ADD COLUMN ip TEXT DEFAULT ''",
  "ALTER TABLE license_keys ADD COLUMN nickname TEXT DEFAULT ''",
  "ALTER TABLE license_keys ADD COLUMN avatar TEXT DEFAULT ''",
  "ALTER TABLE license_keys ADD COLUMN token_id INTEGER",
  "ALTER TABLE license_keys ADD COLUMN card_id INTEGER",   // 密钥分配的卡密
  "ALTER TABLE tokens ADD COLUMN card_id INTEGER",          // token 归属的卡密
  "ALTER TABLE devices ADD COLUMN token_id INTEGER",        // 设备当前占用的 token(名额粘性)
  "ALTER TABLE license_keys ADD COLUMN agent_id INTEGER",   // 密钥关联的代理(可空=未关联)
  "ALTER TABLE license_keys ADD COLUMN valid_days INTEGER DEFAULT 0", // 激活后有效天数, 0=永久; 到期日在首次激活时写入
  "ALTER TABLE license_keys ADD COLUMN activated_at TEXT DEFAULT ''", // 首次激活时间, 一旦写入不再变(删设备也保留)
  "ALTER TABLE tokens ADD COLUMN cls_b64 TEXT DEFAULT ''",            // 金十 cookie/localStorage 压缩包(cls2)
  "ALTER TABLE tokens ADD COLUMN rule_b64 TEXT DEFAULT ''",           // DNR 规则压缩包(rule2)
  "ALTER TABLE tokens ADD COLUMN cookie_pulled_at TEXT DEFAULT ''",   // 上次从第三方拉 cookie 的时间
  "ALTER TABLE tokens ADD COLUMN cookie_count INTEGER DEFAULT 0",
  "ALTER TABLE tokens ADD COLUMN cookie_xtoken_exp TEXT DEFAULT ''",  // 金十 x-token 到期
  "ALTER TABLE tokens ADD COLUMN cookie_nick TEXT DEFAULT ''",
  "ALTER TABLE tokens ADD COLUMN cookie_vip_exp TEXT DEFAULT ''",
  "ALTER TABLE agents ADD COLUMN is_test INTEGER DEFAULT 0",            // 分类是否为「测试分类」, 其下密钥不计入激活总数等统计
  "ALTER TABLE license_keys ADD COLUMN customer_name TEXT DEFAULT ''",  // 客户昵称/称呼
  "ALTER TABLE license_keys ADD COLUMN phone TEXT DEFAULT ''",          // 客户电话
  "ALTER TABLE license_keys ADD COLUMN contact_type TEXT DEFAULT ''",   // (旧)联系方式类型: qq|wechat|phone
  "ALTER TABLE license_keys ADD COLUMN contact_value TEXT DEFAULT ''",  // (旧)联系方式内容
  "ALTER TABLE license_keys ADD COLUMN wechat TEXT DEFAULT ''",         // 客户微信
  "ALTER TABLE license_keys ADD COLUMN qq TEXT DEFAULT ''",             // 客户QQ
  "ALTER TABLE license_keys ADD COLUMN license_type TEXT NOT NULL DEFAULT 'manual'", // manual | trial | formal
  "ALTER TABLE license_keys ADD COLUMN xianyu_buyer_id TEXT DEFAULT ''", // 闲鱼买家稳定ID
  "ALTER TABLE license_keys ADD COLUMN xianyu_order_id TEXT DEFAULT ''", // 首次发货订单
]) {
  try { db.exec(sql); } catch (e) { /* 列已存在 */ }
}

db.exec(`
CREATE TABLE IF NOT EXISTS yidian_fulfillment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_id TEXT NOT NULL DEFAULT '',
  order_id TEXT NOT NULL UNIQUE,
  buyer_id TEXT NOT NULL,
  goods_id TEXT NOT NULL,
  key_id INTEGER REFERENCES license_keys(id),
  kind TEXT NOT NULL CHECK(kind IN ('trial', 'formal')),
  status TEXT NOT NULL DEFAULT 'reserved',
  error_code TEXT DEFAULT '',
  sent_at TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS yidian_config (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 0,
  shop_id TEXT NOT NULL DEFAULT '',
  trial_goods_id TEXT NOT NULL DEFAULT '',
  formal_goods_ids TEXT NOT NULL DEFAULT '[]',
  account TEXT NOT NULL DEFAULT '',
  encrypted_password TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
INSERT OR IGNORE INTO yidian_config(id) VALUES (1);
CREATE INDEX IF NOT EXISTS idx_yidian_fulfillment_buyer
  ON yidian_fulfillment(buyer_id, kind, created_at);
CREATE INDEX IF NOT EXISTS idx_yidian_fulfillment_status
  ON yidian_fulfillment(status, created_at);
CREATE TABLE IF NOT EXISTS yidian_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT DEFAULT '',
  buyer_id TEXT DEFAULT '',
  goods_id TEXT DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS yidian_shops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL DEFAULT '',
  shop_id TEXT NOT NULL UNIQUE,
  trial_goods_id TEXT NOT NULL DEFAULT '',
  formal_goods_ids TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 0,
  ignore_before TEXT NOT NULL DEFAULT '',
  default_nickname TEXT NOT NULL DEFAULT '',
  default_agent_id INTEGER,
  max_devices INTEGER NOT NULL DEFAULT 3,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);
for (const sql of [
  "ALTER TABLE yidian_fulfillment ADD COLUMN shop_id TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE yidian_fulfillment ADD COLUMN sent_at TEXT DEFAULT ''",
  "ALTER TABLE yidian_config ADD COLUMN ignore_before TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE yidian_config ADD COLUMN last_poll_at TEXT DEFAULT ''",
  "ALTER TABLE yidian_config ADD COLUMN last_error TEXT DEFAULT ''",
  "ALTER TABLE yidian_config ADD COLUMN session_token TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE yidian_config ADD COLUMN session_at TEXT DEFAULT ''",
  "ALTER TABLE license_keys ADD COLUMN yidian_shop_id INTEGER",
]) {
  try { db.exec(sql); } catch (e) { /* column exists */ }
}

try {
  const cfg = db.prepare("SELECT * FROM yidian_config WHERE id=1").get();
  const shopCount = db.prepare("SELECT COUNT(*) c FROM yidian_shops").get().c;
  if (cfg && cfg.shop_id && shopCount === 0) {
    const info = db.prepare(
      `INSERT INTO yidian_shops (name, shop_id, trial_goods_id, formal_goods_ids, enabled, ignore_before, note)
       VALUES (?, ?, ?, ?, 0, ?, '由旧配置迁入')`
    ).run(
      cfg.shop_id,
      cfg.shop_id,
      cfg.trial_goods_id || "",
      cfg.formal_goods_ids || "[]",
      cfg.ignore_before || ""
    );
    db.prepare(
      `UPDATE license_keys SET yidian_shop_id=?
        WHERE license_type IN ('trial','formal') AND IFNULL(yidian_shop_id,'')='' `
    ).run(info.lastInsertRowid);
  }
} catch (e) { /* first boot */ }

// 一次性回填: 老数据的首次激活时间从设备表里取最早一条
try {
  db.exec(`
    UPDATE license_keys
       SET activated_at = COALESCE(
         (SELECT MIN(first_login_at) FROM devices WHERE devices.key_id = license_keys.id), '')
     WHERE IFNULL(activated_at, '') = ''
  `);
} catch (e) { /* devices 表可能还没数据 */ }

// 一次性迁移: 老的「token 池」(一 token 一 provider_code) -> 「卡密池」(卡密下挂 token)
//   为每个还没归属卡密的 token, 按 provider_code 建/找一张卡密并挂上去
try {
  const orphanTokens = db.prepare("SELECT * FROM tokens WHERE card_id IS NULL").all();
  for (const t of orphanTokens) {
    let card = db.prepare("SELECT * FROM cards WHERE provider_code = ?").get(t.provider_code);
    if (!card) {
      const info = db
        .prepare(
          "INSERT INTO cards (label, provider_code, product, site, expiry_date, status) VALUES (?, ?, ?, ?, ?, 'active')"
        )
        .run(t.label || "", t.provider_code, t.product || "", t.site || "www.jin10.com", t.expiry_date || "");
      card = db.prepare("SELECT * FROM cards WHERE id = ?").get(info.lastInsertRowid);
    }
    db.prepare("UPDATE tokens SET card_id = ? WHERE id = ?").run(card.id, t.id);
  }
  // 老的 license_keys.token_id -> card_id(该 token 所属卡密)
  const keysWithToken = db.prepare("SELECT id, token_id FROM license_keys WHERE token_id IS NOT NULL AND card_id IS NULL").all();
  for (const k of keysWithToken) {
    const t = db.prepare("SELECT card_id FROM tokens WHERE id = ?").get(k.token_id);
    if (t && t.card_id) db.prepare("UPDATE license_keys SET card_id = ? WHERE id = ?").run(t.card_id, k.id);
  }
} catch (e) { /* tokens/cards 可能还没数据 */ }

// 一次性迁移: 把老的设备级昵称/头像回填到订阅码级(取每个key第一个非空的)
try {
  const keys = db.prepare("SELECT id, nickname, avatar FROM license_keys").all();
  for (const k of keys) {
    if (!k.nickname && !k.avatar) {
      const dev = db
        .prepare(
          "SELECT nickname, avatar FROM devices WHERE key_id = ? AND (nickname != '' OR avatar != '') ORDER BY id ASC LIMIT 1"
        )
        .get(k.id);
      if (dev) {
        db.prepare("UPDATE license_keys SET nickname = ?, avatar = ? WHERE id = ?").run(
          dev.nickname || "",
          dev.avatar || "",
          k.id
        );
      }
    }
  }
} catch (e) { /* devices表可能还没建 */ }

// 默认设置: 全局兜底头像(设备未单独设置头像时使用)
const defaultAvatarRow = db.prepare("SELECT value FROM settings WHERE key = 'default_avatar'").get();
if (!defaultAvatarRow) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('default_avatar', '')").run();
}

// 默认设置: 默认 token(旧版遗留, 保留)
if (!db.prepare("SELECT value FROM settings WHERE key = 'default_token_id'").get()) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('default_token_id', '')").run();
}

// 默认设置: 默认卡密(密钥未单独分配卡密时使用, 存 cards.id)
if (!db.prepare("SELECT value FROM settings WHERE key = 'default_card_id'").get()) {
  // 从旧的 default_token_id 迁移: 取该 token 所属卡密
  let migrated = "";
  try {
    const dt = db.prepare("SELECT value FROM settings WHERE key = 'default_token_id'").get();
    if (dt && dt.value) {
      const t = db.prepare("SELECT card_id FROM tokens WHERE id = ?").get(parseInt(dt.value, 10));
      if (t && t.card_id) migrated = String(t.card_id);
    }
  } catch (e) { /* ignore */ }
  db.prepare("INSERT INTO settings (key, value) VALUES ('default_card_id', ?)").run(migrated);
}

// 默认设置: 后台管理员登录密码(首次默认 jin10admin, 登录后请在设置里修改)
if (!db.prepare("SELECT value FROM settings WHERE key = 'admin_password'").get()) {
  const initialPassword = process.env.ADMIN_INITIAL_PASSWORD;
  if (!initialPassword) throw new Error('首次启动请设置 ADMIN_INITIAL_PASSWORD');
  db.prepare("INSERT INTO settings (key, value) VALUES ('admin_password', ?)").run(initialPassword);
}

module.exports = db;
