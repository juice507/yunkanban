// 后台：活动看板 / 日志中心 / 插件发布推送 / 新插件心跳与更新检查
const fs = require("fs");
const path = require("path");

function cmpVer(a, b) {
  const pa = String(a || "0").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

module.exports = function mountAdminExtra(app, { db, activity, getSetting, DOWNLOAD_DIR, NOT_TEST, maskCode }) {
  // ---------- 插件发布表(不改旧 plugin_files 结构，额外一张表记录版本/推送状态) ----------
  db.exec(`CREATE TABLE IF NOT EXISTS plugin_releases(
    plugin_id INTEGER PRIMARY KEY, version TEXT DEFAULT '', changelog TEXT DEFAULT '',
    status TEXT DEFAULT 'draft', force INTEGER DEFAULT 0, pushed_at TEXT DEFAULT '', min_version TEXT DEFAULT '1.2.0');`);
  const fmt = activity.fmt;
  const ONLINE_MS = activity.ONLINE_MS;

  function releaseOf(id) {
    return db.prepare("SELECT * FROM plugin_releases WHERE plugin_id=?").get(id) || null;
  }
  function latestPushed(platform) {
    return db.prepare(`SELECT p.*, r.version, r.changelog, r.force, r.pushed_at FROM plugin_releases r
      JOIN plugin_files p ON p.id=r.plugin_id WHERE r.status='pushed' AND p.platform=? ORDER BY r.pushed_at DESC, p.id DESC LIMIT 1`).get(platform);
  }
  function dlUrl(row, origin) {
    const base = origin || "https://sync-api.xircle.autos";
    if (row.ext === ".xpi" || row.ext === ".crx") return `${base}/dl/${row.slug}/${encodeURIComponent(row.original_name || "plugin" + row.ext)}`;
    return `${base}/dl/${row.slug}`;
  }

  app.get("/api/admin/plugin-releases", (req, res) => {
    const rows = db.prepare("SELECT * FROM plugin_releases").all();
    const counts = db.prepare(`SELECT version, platform, count(*) c FROM device_presence
      WHERE version!='' AND last_active_at>? GROUP BY version, platform`).all(fmt(Date.now() - 7 * 86400000));
    res.json({ success: true, data: rows, versionUsage: counts });
  });
  app.put("/api/admin/plugin-releases/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!db.prepare("SELECT id FROM plugin_files WHERE id=?").get(id)) return res.status(404).json({ success: false, message: "插件不存在" });
    const { version, changelog, force } = req.body || {};
    if (version != null && !/^\d+\.\d+\.\d+$/.test(String(version))) return res.json({ success: false, message: "版本号格式应为 1.2.0" });
    db.prepare(`INSERT INTO plugin_releases(plugin_id,version,changelog,force) VALUES(@id,@v,@c,@f)
      ON CONFLICT(plugin_id) DO UPDATE SET version=COALESCE(@v,version), changelog=COALESCE(@c,changelog), force=COALESCE(@f,force)`)
      .run({ id, v: version ?? null, c: changelog ?? null, f: force == null ? null : force ? 1 : 0 });
    res.json({ success: true, data: releaseOf(id) });
  });
  app.post("/api/admin/plugin-releases/:id/push", (req, res) => {
    const id = Number(req.params.id);
    const p = db.prepare("SELECT * FROM plugin_files WHERE id=?").get(id);
    const r = releaseOf(id);
    if (!p || !r || !r.version) return res.json({ success: false, message: "请先填写版本号" });
    if (cmpVer(r.version, "1.2.0") < 0) return res.json({ success: false, message: "只有 1.2.0 及以上的新插件支持推送更新" });
    if (!fs.existsSync(path.join(DOWNLOAD_DIR, p.filename))) return res.json({ success: false, message: "安装包文件不存在" });
    db.prepare("UPDATE plugin_releases SET status='pushed', pushed_at=? WHERE plugin_id=?").run(fmt(Date.now()), id);
    activity.log("plugin_push", { category: "system", platform: p.platform, version: r.version, detail: `推送 ${p.name}${r.force ? "（强制更新）" : ""}` });
    res.json({ success: true, data: releaseOf(id) });
  });
  app.post("/api/admin/plugin-releases/:id/withdraw", (req, res) => {
    const id = Number(req.params.id);
    const p = db.prepare("SELECT * FROM plugin_files WHERE id=?").get(id);
    db.prepare("UPDATE plugin_releases SET status='withdrawn' WHERE plugin_id=?").run(id);
    if (p) activity.log("plugin_withdraw", { category: "system", platform: p.platform, detail: `撤回 ${p.name}` });
    res.json({ success: true, data: releaseOf(id) });
  });

  // ---------- 新插件(>=1.2.0)用：检查更新(只看已推送) ----------
  // 1.1.14 的 popup 也会请求 /api/client/latest，但它只接受 version > 自己且 url 同源；
  // 我们只返回 >=1.2.0 且已推送的版本，所以不推送时老插件看到的是「已是最新版」。
  function latestHandler(req, res) {
    const platform = activity.platformOf(req.get("user-agent") || "", req.query.platform);
    const cur = String(req.query.current || req.query.version || "");
    // 老插件(1.1.14)只带 platform、不带 current：一律回「已是最新」，不打扰老客户
    if (!cur) return res.json({ success: true, data: { version: "0.0.0", url: "", hasUpdate: false, platform } });
    const row = latestPushed(platform === "other" ? "pc" : platform);
    if (!row) return res.json({ success: true, data: { version: cur || "0.0.0", url: "", hasUpdate: false, platform } });
    const has = cmpVer(row.version, cur) > 0;
    res.json({ success: true, data: { version: row.version, url: dlUrl(row), changelog: row.changelog || "", force: !!row.force,
      hasUpdate: has, platform, pushedAt: row.pushed_at } });
  }
  app.get("/api/client/latest", latestHandler);

  // 统一下载链接：按访问设备自动跳到对应平台最新已推送安装包
  app.get("/dl/latest", (req, res) => {
    const platform = activity.platformOf(req.get("user-agent") || "", req.query.platform);
    const row = latestPushed(platform === "other" ? "pc" : platform);
    if (!row) return res.status(404).send("还没有推送任何版本");
    res.redirect(302, dlUrl(row, ""));
  });

  // 新插件心跳 / 事件上报
  app.post("/api/client/ping", (req, res) => {
    const b = req.body || {};
    const ip = String(req.headers["x-real-ip"] || req.headers["x-forwarded-for"] || "").split(",")[0].trim();
    const key = db.prepare("SELECT id FROM license_keys WHERE key_code=?").get(String(b.key || ""));
    const dev = key ? db.prepare("SELECT id, status FROM devices WHERE key_id=? AND device_id=?").get(key.id, String(b.deviceId || "")) : null;
    if (!key || !dev) return res.json({ success: false, message: "unknown device" });
    const ua = req.get("user-agent") || "";
    const platform = activity.platformOf(ua, b.platform);
    const version = String(b.version || "").slice(0, 20);
    if (dev.status === "active") activity.touch({ deviceRowId: dev.id, keyId: key.id, ip, ua, platform, version, source: "heartbeat" });
    const events = Array.isArray(b.events) ? b.events.slice(0, 20) : [];
    let syncLogged = false;
    for (const e of events) {
      const type = String((e && e.type) || "");
      if (!["page_sync", "sync_fail", "relogin_detected", "client_error"].includes(type)) continue;
      if (type === "page_sync") {
        if (syncLogged) continue;
        syncLogged = true;
        const last = db.prepare("SELECT created_at FROM activity_log WHERE device_row_id=? AND event='page_sync' ORDER BY id DESC LIMIT 1").get(dev.id);
        if (last && Date.now() - Date.parse(last.created_at.replace(" ", "T") + "+08:00") < 10 * 60 * 1000) continue;
      }
      activity.log(type, { keyId: key.id, deviceRowId: dev.id, deviceId: b.deviceId, platform, version, ip, detail: String(e.detail || "").slice(0, 400) });
    }
    res.json({ success: true, status: dev.status });
  });

  // ---------- 看板 ----------
  app.get("/api/admin/activity/overview", (req, res) => {
    const now = Date.now();
    const today = fmt(now).slice(0, 10);
    const notTest = `key_id IN (SELECT id FROM license_keys WHERE ${NOT_TEST})`;
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const onlineCut = fmt(now - ONLINE_MS);
    const online = one(`SELECT count(*) c, count(DISTINCT key_id) k, sum(source='heartbeat') exact FROM device_presence p
      WHERE last_active_at>? AND ${notTest} AND device_row_id IN (SELECT id FROM devices WHERE status='active')`, onlineCut);
    const todayAct = one(`SELECT count(DISTINCT key_id) users, count(DISTINCT device_row_id) devices FROM daily_active WHERE day=? AND ${notTest}`, today);
    const bound = one(`SELECT count(*) c FROM devices WHERE status='active' AND ${notTest}`);
    const todayNew = one(`SELECT count(*) c FROM license_keys WHERE date(activated_at)=? AND ${NOT_TEST}`, today);
    const todayProblems = one(`SELECT count(*) c FROM activity_log WHERE category='problem' AND created_at>=?`, today + " 00:00:00");
    const trend = db.prepare(`SELECT day, count(DISTINCT key_id) users, count(DISTINCT device_row_id) devices FROM daily_active
      WHERE day>=? AND ${notTest} GROUP BY day ORDER BY day`).all(fmt(now - 13 * 86400000).slice(0, 10));
    const platforms = db.prepare(`SELECT COALESCE(NULLIF(platform,''),'other') platform, count(DISTINCT device_row_id) c FROM daily_active
      WHERE day=? AND ${notTest} GROUP BY 1`).all(today);
    const versions = db.prepare(`SELECT COALESCE(NULLIF(version,''),'1.1.x') version, count(*) c FROM device_presence
      WHERE last_active_at>=? AND ${notTest} GROUP BY 1 ORDER BY 2 DESC`).all(today + " 00:00:00");
    const guard = (() => { try { return JSON.parse(getSetting("mars_guard_state") || "{}"); } catch (e) { return {}; } })();
    res.json({ success: true, data: {
      onlineDevices: online.c || 0, onlineUsers: online.k || 0, onlineExact: online.exact || 0,
      todayUsers: todayAct.users || 0, todayDevices: todayAct.devices || 0,
      boundDevices: bound.c || 0, todayActivated: todayNew.c || 0, todayProblems: todayProblems.c || 0,
      trend, platforms, versions, guard, onlineWindowMin: ONLINE_MS / 60000,
      note: "老插件(1.1.x)没有心跳，在线/活跃按 IP 估算；升级 1.2.0 后精确",
    } });
  });

  // 设备实时状态列表
  app.get("/api/admin/activity/devices", (req, res) => {
    const now = Date.now();
    const today = fmt(now).slice(0, 10);
    const q = String(req.query.q || "").trim();
    const state = String(req.query.state || "");
    const rows = db.prepare(`SELECT d.id, d.key_id, d.device_id, d.device_label, d.status, d.first_login_at, d.last_seen_at,
        k.name key_name, k.note key_note, k.key_code, k.expiry_date,
        p.last_active_at, p.last_ip, p.platform, p.version, p.source
      FROM devices d JOIN license_keys k ON k.id=d.key_id LEFT JOIN device_presence p ON p.device_row_id=d.id
      ORDER BY COALESCE(p.last_active_at, d.last_seen_at) DESC LIMIT 2000`).all();
    const out = [];
    for (const r of rows) {
      const lastAt = r.last_active_at || r.last_seen_at || "";
      const t = Date.parse(String(lastAt).replace(" ", "T") + "+08:00");
      let st = "offline";
      if (r.status !== "active") st = "kicked";
      else if (r.expiry_date && /^\d{4}-\d{2}-\d{2}/.test(r.expiry_date) && r.expiry_date.slice(0, 10) < today) st = "expired";
      else if (Number.isFinite(t) && now - t <= ONLINE_MS) st = "online";
      else if (String(lastAt).slice(0, 10) === today) st = "today";
      if (state && st !== state) continue;
      const name = r.key_name || r.key_note || "";
      if (q && !(`${name} ${r.key_code} ${r.device_label} ${r.last_ip}`.includes(q))) continue;
      out.push({ id: r.id, keyId: r.key_id, keyName: name, keyCode: maskCode(r.key_code), deviceLabel: r.device_label,
        state, lastActiveAt: lastAt, ip: r.last_ip || "", platform: r.platform || "", version: r.version || "1.1.x",
        exact: r.source === "heartbeat", firstLoginAt: r.first_login_at });
      if (out.length >= 500) break;
    }
    res.json({ success: true, data: out });
  });

  // 日志中心点击订阅码：只展示密钥资料，不回显使用/错误日志
  app.get("/api/admin/key-info/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ success: false, message: "密钥编号无效" });
    const row = db.prepare(`SELECT k.id,k.name,k.note,k.key_code,k.status,k.expiry_date,k.max_devices,k.activated_at,k.created_at,
      a.name agent_name,c.label card_label,
      (SELECT count(*) FROM devices d WHERE d.key_id=k.id AND d.status='active') active_devices,
      (SELECT count(*) FROM devices d WHERE d.key_id=k.id) total_devices
      FROM license_keys k LEFT JOIN agents a ON a.id=k.agent_id LEFT JOIN cards c ON c.id=k.card_id WHERE k.id=?`).get(id);
    if (!row) return res.status(404).json({ success: false, message: "密钥不存在" });
    res.json({ success: true, data: {
      id: row.id, name: row.name || "", note: row.note || "", code: row.key_code,
      status: row.status, expiryDate: row.expiry_date || "", maxDevices: row.max_devices,
      activeDevices: row.active_devices, totalDevices: row.total_devices,
      agentName: row.agent_name || "未关联", cardLabel: row.card_label || "默认卡密",
      activatedAt: row.activated_at || "", createdAt: row.created_at || "",
    } });
  });

  // 日志中心
  app.get("/api/admin/activity/logs", (req, res) => {
    const where = [], args = {};
    const q = req.query;
    if (q.category) { where.push("a.category=@cat"); args.cat = String(q.category); }
    if (q.event) { where.push("a.event=@ev"); args.ev = String(q.event); }
    if (q.problem === "1") where.push("a.ok=0");
    if (q.keyId) { where.push("a.key_id=@kid"); args.kid = Number(q.keyId); }
    if (q.platform) { where.push("a.platform=@pf"); args.pf = String(q.platform); }
    if (q.from) { where.push("a.created_at>=@from"); args.from = String(q.from); }
    if (q.to) { where.push("a.created_at<=@to"); args.to = String(q.to); }
    if (q.q) { where.push("(k.name LIKE @q OR k.note LIKE @q OR k.key_code LIKE @q OR a.ip LIKE @q OR a.detail LIKE @q)"); args.q = `%${String(q.q)}%`; }
    if (q.hideNoise !== "0") where.push("a.event NOT IN ('heartbeat')");
    const w = where.length ? "WHERE " + where.join(" AND ") : "";
    const size = Math.min(Math.max(parseInt(q.pageSize, 10) || 50, 1), q.export === "1" ? 20000 : 200);
    const page = Math.max(parseInt(q.page, 10) || 1, 1);
    const total = db.prepare(`SELECT count(*) c FROM activity_log a LEFT JOIN license_keys k ON k.id=a.key_id ${w}`).get(args).c;
    const rows = db.prepare(`SELECT a.*, k.name key_name, k.note key_note, k.key_code, d.device_label FROM activity_log a
      LEFT JOIN license_keys k ON k.id=a.key_id LEFT JOIN devices d ON d.id=a.device_row_id ${w}
      ORDER BY a.id DESC LIMIT @lim OFFSET @off`).all({ ...args, lim: size, off: (page - 1) * size });
    const data = rows.map((r) => ({ id: r.id, createdAt: r.created_at, category: r.category,
      categoryLabel: activity.CATS[r.category] || r.category, event: r.event,
      eventLabel: (activity.EVENTS[r.event] || [, { plugin_push: "推送新版本", plugin_withdraw: "撤回版本" }[r.event] || r.event])[1],
      keyId: r.key_id, keyName: r.key_name || r.key_note || "", keyCode: r.key_code ? maskCode(r.key_code) : "",
      deviceLabel: r.device_label || "", deviceId: r.device_id ? String(r.device_id).slice(-8) : "",
      platform: r.platform, version: r.version, ip: r.ip, ok: !!r.ok, estimated: !!r.estimated, detail: r.detail }));
    if (q.export === "1") {
      const head = "时间,分类,事件,客户,订阅码,设备,平台,版本,IP,结果,估算,详情\n";
      const esc = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
      const body = data.map((r) => [r.createdAt, r.categoryLabel, r.eventLabel, r.keyName, r.keyCode, r.deviceLabel || r.deviceId,
        r.platform, r.version, r.ip, r.ok ? "正常" : "异常", r.estimated ? "是" : "", r.detail].map(esc).join(",")).join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="activity-${fmt(Date.now()).slice(0, 10)}.csv"`);
      return res.send("\ufeff" + head + body);
    }
    const summary = db.prepare(`SELECT a.category, count(*) c FROM activity_log a WHERE a.created_at>=? GROUP BY 1`).all(fmt(Date.now()).slice(0, 10) + " 00:00:00");
    res.json({ success: true, data, total, page, pageSize: size, todaySummary: summary,
      events: Object.entries(activity.EVENTS).map(([k, v]) => ({ value: k, category: v[0], label: v[1] })) });
  });
};
module.exports.cmpVer = cmpVer;
