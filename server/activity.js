// 活动日志 + 在线状态。老插件(1.1.x)没有心跳，按 IP+浏览器估算；新插件(>=1.2.0)心跳精确。
const ONLINE_MS = 15 * 60 * 1000;
const RETAIN_DAYS = 90;
const SYNC_LOG_GAP_MS = 10 * 60 * 1000; // 同一设备「打开页面」日志最短间隔

const fmt = (ms) => new Date(ms + 8 * 3600000).toISOString().slice(0, 19).replace("T", " ");
const parse = (s) => (s ? Date.parse(String(s).replace(" ", "T") + "+08:00") : NaN);
const clip = (v, n = 300) => String(v == null ? "" : v).replace(/[\x00-\x1f]/g, " ").slice(0, n);

// 平台识别：Orion(苹果)扩展环境常伪装成 macOS Firefox，客户插件又只有苹果端是 xpi，所以归为苹果
function platformOf(ua = "", hint = "") {
  const h = String(hint || "").toLowerCase();
  if (["pc", "android", "ios"].includes(h)) return h;
  const u = String(ua);
  if (/Android/i.test(u)) return "android";
  if (/iPhone|iPad|iPod/i.test(u)) return "ios";
  if (/Macintosh.*(Firefox|FxiOS)\//i.test(u)) return "ios";
  if (/Windows|Macintosh|Linux|CrOS/i.test(u)) return "pc";
  return "other";
}
function versionOf(ua = "", body = {}) {
  return clip(body.appVersion || body.version || body.extVersion || "", 20);
}

const CATS = { usage: "使用", state: "状态", problem: "问题", system: "系统" };
const EVENTS = {
  activate: ["usage", "首次激活"], verify_ok: ["usage", "验证授权"], bind: ["usage", "绑定新设备"],
  page_sync: ["usage", "打开页面/同步登录态"], heartbeat: ["usage", "心跳"],
  online: ["state", "上线"], offline: ["state", "下线"], kicked_idle: ["state", "名额满被挤下线"],
  kicked_admin: ["state", "后台踢下线"], device_deleted: ["state", "后台删除设备"],
  rejected_notfound: ["problem", "订阅码不存在"], rejected_disabled: ["problem", "订阅码已禁用"],
  rejected_expired: ["problem", "订阅码已过期"], rejected_limit: ["problem", "设备名额已满"],
  sync_fail: ["problem", "同步登录态失败"], relogin_detected: ["problem", "页面掉登录"],
  client_error: ["problem", "插件报错"], verify_fail: ["problem", "验证失败"],
  token_refreshed: ["system", "上游登录态已更换"], guard_check: ["system", "登录态检查"],
  guard_fail: ["system", "登录态拉取失败"], guard_breaker: ["system", "熔断暂停拉取"], guard_alert: ["system", "告警"],
};

module.exports = function createActivity(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_log(
      id INTEGER PRIMARY KEY, created_at TEXT NOT NULL, category TEXT NOT NULL, event TEXT NOT NULL,
      key_id INTEGER, device_row_id INTEGER, device_id TEXT DEFAULT '', platform TEXT DEFAULT '',
      version TEXT DEFAULT '', ip TEXT DEFAULT '', ok INTEGER DEFAULT 1, estimated INTEGER DEFAULT 0,
      detail TEXT DEFAULT '');
    CREATE INDEX IF NOT EXISTS activity_log_time ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS activity_log_key ON activity_log(key_id, created_at);
    CREATE INDEX IF NOT EXISTS activity_log_cat ON activity_log(category, created_at);
    CREATE TABLE IF NOT EXISTS device_presence(
      device_row_id INTEGER PRIMARY KEY, key_id INTEGER, last_active_at TEXT, last_ip TEXT DEFAULT '',
      ua TEXT DEFAULT '', platform TEXT DEFAULT '', version TEXT DEFAULT '', source TEXT DEFAULT '',
      online INTEGER DEFAULT 0, last_sync_log_at TEXT DEFAULT '');
    CREATE INDEX IF NOT EXISTS device_presence_ip ON device_presence(last_ip);
    CREATE TABLE IF NOT EXISTS daily_active(day TEXT NOT NULL, key_id INTEGER NOT NULL, device_row_id INTEGER NOT NULL,
      platform TEXT DEFAULT '', PRIMARY KEY(day, key_id, device_row_id));
  `);

  const insLog = db.prepare(`INSERT INTO activity_log(created_at,category,event,key_id,device_row_id,device_id,platform,version,ip,ok,estimated,detail)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
  function log(event, o = {}) {
    try {
      const meta = EVENTS[event] || [o.category || "system", event];
      const cat = o.category || meta[0];
      insLog.run(fmt(Date.now()), cat, event, o.keyId || null, o.deviceRowId || null, clip(o.deviceId, 80),
        clip(o.platform, 10), clip(o.version, 20), clip(o.ip, 60), cat === "problem" || o.ok === false ? 0 : 1,
        o.estimated ? 1 : 0, clip(o.detail, 500));
    } catch (e) {
      console.warn("[activity log]", e.message);
    }
  }

  const getPres = db.prepare("SELECT * FROM device_presence WHERE device_row_id=?");
  const upPres = db.prepare(`INSERT INTO device_presence(device_row_id,key_id,last_active_at,last_ip,ua,platform,version,source,online)
    VALUES(@id,@key,@at,@ip,@ua,@pf,@ver,@src,1)
    ON CONFLICT(device_row_id) DO UPDATE SET key_id=@key,last_active_at=@at,
      last_ip=CASE WHEN @ip!='' THEN @ip ELSE last_ip END, ua=CASE WHEN @ua!='' THEN @ua ELSE ua END,
      platform=CASE WHEN @pf!='' AND @pf!='other' THEN @pf ELSE platform END,
      version=CASE WHEN @ver!='' THEN @ver ELSE version END,
      source=CASE WHEN source='heartbeat' AND @src!='heartbeat' AND last_active_at>@recent THEN source ELSE @src END, online=1`);
  const insDaily = db.prepare("INSERT OR IGNORE INTO daily_active(day,key_id,device_row_id,platform) VALUES(?,?,?,?)");

  // 设备有活动：更新在线状态、今日活跃；离线->在线时记一条「上线」
  function touch({ deviceRowId, keyId, ip = "", ua = "", platform = "", version = "", source = "verify", estimated = false }) {
    if (!deviceRowId) return;
    const now = Date.now();
    const prev = getPres.get(deviceRowId);
    let pf = platform || platformOf(ua);
    if ((!pf || pf === "other") && prev && prev.platform) pf = prev.platform;
    upPres.run({ id: deviceRowId, key: keyId || null, at: fmt(now), ip: clip(ip, 60), ua: clip(ua, 300), pf,
      ver: clip(version, 20), src: source, recent: fmt(now - ONLINE_MS) });
    insDaily.run(fmt(now).slice(0, 10), keyId || 0, deviceRowId, pf);
    if (!prev || !prev.online) {
      log("online", { keyId, deviceRowId, platform: pf, version: version || (prev && prev.version) || "", ip, estimated,
        detail: estimated ? "按 IP 估算(老插件没有心跳)" : "" });
    }
  }

  // 老插件拉登录态的请求不带设备 ID：用 IP(+浏览器)匹配最近验证过的设备
  const byIp = db.prepare(`SELECT p.*, d.device_id FROM device_presence p JOIN devices d ON d.id=p.device_row_id
    WHERE p.last_ip=? AND d.status='active' AND p.last_active_at>? ORDER BY p.last_active_at DESC LIMIT 20`);
  const setSyncLog = db.prepare("UPDATE device_presence SET last_sync_log_at=? WHERE device_row_id=?");
  const unmatchedAt = new Map();
  function pageSync({ ip, ua, op }) {
    if (!ip) return;
    const rows = byIp.all(clip(ip, 60), fmt(Date.now() - 7 * 86400000));
    if (!rows.length) {
      const k = "ip:" + ip;
      const last = unmatchedAt.get(k) || 0;
      if (Date.now() - last < SYNC_LOG_GAP_MS) return;
      unmatchedAt.set(k, Date.now());
      if (unmatchedAt.size > 5000) unmatchedAt.clear();
      if (op === "cls2") log("page_sync", { ip, platform: platformOf(ua), estimated: true, detail: "未匹配到设备(该 IP 近 7 天没验证过)" });
      return;
    }
    const sameUa = rows.find((r) => r.ua && r.ua === ua);
    const r = sameUa || rows[0];
    touch({ deviceRowId: r.device_row_id, keyId: r.key_id, ip, ua: sameUa ? ua : "", platform: r.platform,
      source: r.source === "heartbeat" ? "heartbeat" : "estimated", estimated: true });
    if (op !== "cls2") return;
    const last = parse(r.last_sync_log_at);
    if (Number.isFinite(last) && Date.now() - last < SYNC_LOG_GAP_MS) return;
    setSyncLog.run(fmt(Date.now()), r.device_row_id);
    log("page_sync", { keyId: r.key_id, deviceRowId: r.device_row_id, deviceId: r.device_id, platform: r.platform,
      version: r.version, ip, estimated: !sameUa || rows.length > 1,
      detail: rows.length > 1 ? `同一 IP 下有 ${rows.length} 台设备，按浏览器匹配` : "" });
  }

  // 每分钟：超过 15 分钟没活动的设备记「下线」；每天清理 90 天前日志
  const stale = db.prepare("SELECT p.*, d.device_id FROM device_presence p LEFT JOIN devices d ON d.id=p.device_row_id WHERE p.online=1 AND p.last_active_at<?");
  const setOff = db.prepare("UPDATE device_presence SET online=0 WHERE device_row_id=?");
  let lastClean = 0;
  function sweep() {
    try {
      for (const r of stale.all(fmt(Date.now() - ONLINE_MS))) {
        setOff.run(r.device_row_id);
        log("offline", { keyId: r.key_id, deviceRowId: r.device_row_id, deviceId: r.device_id, platform: r.platform,
          version: r.version, ip: r.last_ip, estimated: r.source !== "heartbeat", detail: `最后活动 ${r.last_active_at}` });
      }
      if (Date.now() - lastClean > 6 * 3600000) {
        lastClean = Date.now();
        const cut = fmt(Date.now() - RETAIN_DAYS * 86400000);
        db.prepare("DELETE FROM activity_log WHERE created_at<?").run(cut);
        db.prepare("DELETE FROM daily_active WHERE day<?").run(cut.slice(0, 10));
      }
    } catch (e) {
      console.warn("[activity sweep]", e.message);
    }
  }
  setInterval(sweep, 60 * 1000);

  // 首次部署：用近 7 天的登录日志给设备补 IP，老插件的页面请求才能匹配到设备
  try {
    const seeded = db.prepare(`INSERT OR IGNORE INTO device_presence(device_row_id,key_id,last_active_at,last_ip,source,online)
      SELECT d.id, d.key_id, l.created_at, l.ip, 'seed', 0 FROM devices d
      JOIN login_logs l ON l.id = (SELECT id FROM login_logs WHERE key_id=d.key_id AND device_id=d.device_id AND result='ok' ORDER BY id DESC LIMIT 1)
      WHERE d.status='active' AND l.created_at > datetime('now','localtime','-7 days')`).run().changes;
    const today = db.prepare(`INSERT OR IGNORE INTO daily_active(day,key_id,device_row_id,platform)
      SELECT date(l.created_at), d.key_id, d.id, '' FROM login_logs l JOIN devices d ON d.key_id=l.key_id AND d.device_id=l.device_id
      WHERE l.result='ok' AND l.created_at > datetime('now','localtime','-7 days')`).run().changes;
    const fixed = db.prepare(`UPDATE device_presence SET platform = (
        SELECT CASE json_extract(m.metadata,'$.os') WHEN 'Android' THEN 'android' WHEN 'iOS' THEN 'ios'
          WHEN 'Windows' THEN 'pc' WHEN 'Linux' THEN 'pc'
          WHEN 'macOS' THEN CASE WHEN json_extract(m.metadata,'$.browser')='Firefox' THEN 'ios' ELSE 'pc' END ELSE '' END
        FROM device_metadata m WHERE m.device_row_id = device_presence.device_row_id)
      WHERE (platform IS NULL OR platform='' OR platform='other')
        AND device_row_id IN (SELECT device_row_id FROM device_metadata)`).run().changes;
    db.prepare(`UPDATE daily_active SET platform = (SELECT platform FROM device_presence p WHERE p.device_row_id = daily_active.device_row_id)
      WHERE (platform='' OR platform='other') AND device_row_id IN (SELECT device_row_id FROM device_presence WHERE platform!='')`).run();
    if (fixed) console.log(`[activity] 已按设备信息补充 ${fixed} 台设备的平台`);
    if (seeded || today) console.log(`[activity] 已用历史登录日志补充 ${seeded} 台设备 IP、${today} 条活跃记录`);
  } catch (e) {
    console.warn("[activity seed]", e.message);
  }

  return { log, touch, pageSync, platformOf, versionOf, fmt, ONLINE_MS, CATS, EVENTS };
};
module.exports.platformOf = platformOf;
