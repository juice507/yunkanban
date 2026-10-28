// 日报：数据汇总 -> HTML 模板 -> Chromium 截图 -> 钉钉发图
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");

const TEMPLATE = fs.readFileSync(path.join(__dirname, "reports", "template.html"), "utf8");
const PUBLIC_BASE = "https://sync-api.xircle.autos/k9m4x7q2/uploads";

function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

module.exports = function createReport({ db, activity, getSetting, dingtalk, UPLOAD_DIR, pageUrl }) {
  const fmt = activity.fmt;
  const day = (ms) => fmt(ms).slice(0, 10);

  function collect(offsetDays = 0) {
    const target = day(Date.now() - offsetDays * 86400000);
    const now = Date.now();
    const notTest = "key_id IN (SELECT id FROM license_keys WHERE agent_id IS NULL OR agent_id NOT IN (SELECT id FROM agents WHERE is_test = 1))";
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const onlineCut = fmt(now - activity.ONLINE_MS);
    const online = one(`SELECT count(*) c, count(DISTINCT key_id) k FROM device_presence
      WHERE last_active_at>? AND device_row_id IN (SELECT id FROM devices WHERE status='active')`, onlineCut);
    const today = one(`SELECT count(DISTINCT key_id) u, count(DISTINCT device_row_id) d FROM daily_active WHERE day=? AND ${notTest}`, target);
    const bound = one("SELECT count(*) c FROM devices WHERE status='active'");
    const newKeys = one(`SELECT count(*) c FROM license_keys WHERE date(activated_at)=?`, target);
    const problems = db.prepare(`SELECT a.created_at, a.event, a.detail, a.platform, a.version, a.device_id, k.name key_name, k.note key_note, k.key_code
      FROM activity_log a LEFT JOIN license_keys k ON k.id=a.key_id
      WHERE a.ok=0 AND a.created_at>=? ORDER BY a.id DESC LIMIT 8`).all(target + " 00:00:00");
    const problemCount = one("SELECT count(*) c FROM activity_log WHERE ok=0 AND created_at>=?", target + " 00:00:00").c;
    const trend = db.prepare(`SELECT day, count(DISTINCT key_id) u FROM daily_active WHERE day>=? AND ${notTest} GROUP BY day ORDER BY day`)
      .all(day(now - 6 * 86400000));
    const versions = db.prepare(`SELECT COALESCE(NULLIF(version,''),'1.1.x') v, count(*) c FROM device_presence
      WHERE last_active_at>=? AND ${notTest} GROUP BY 1 ORDER BY 2 DESC`).all(target + " 00:00:00");
    const guard = (() => { try { return JSON.parse(getSetting("mars_guard_state") || "{}"); } catch (e) { return {}; } })();
    const expiry = getSetting("mars_expiry") || "";
    const expDays = /^\d{14}$/.test(expiry)
      ? Math.ceil((Date.parse(`${expiry.slice(0, 4)}-${expiry.slice(4, 6)}-${expiry.slice(6, 8)}T${expiry.slice(8, 10)}:${expiry.slice(10, 12)}:59+08:00`) - now) / 86400000)
      : null;
    return { target, online, today, bound, newKeys, problems, problemCount, trend, versions, guard, expDays };
  }

  const TIPS = {
    sync_fail: "多为客户网络不稳或苹果后台挂起，通常自行恢复；持续出现再看",
    relogin_detected: "1.2.0 插件会自动换新并刷新，关注是否反复发生",
    rejected_expired: "订阅码到期，客户续费即可",
    rejected_disabled: "订阅码已被禁用，确认是否要恢复",
    rejected_notfound: "码不存在，可能是客户输错",
    rejected_limit: "设备名额已满，可提醒客户或减少其设备数",
    client_error: "插件报错，收集到多次时需要排查版本",
    guard_fail: "上游拉取失败，关注是否连续发生",
    guard_breaker: "已熔断暂停拉取，需人工处理上游",
    guard_alert: "系统告警",
  };

  function render(d) {
    const problems = d.problemCount;
    const badge = problems === 0 && !(d.guard && d.guard.dead) ? ["", "今日正常"] : ["bad", "有异常"];
    const maxU = Math.max(1, ...d.trend.map((t) => t.u));
    const bars = d.trend.map((t) =>
      `<div class="bar"><span class="v">${t.u}</span><div class="col" style="height:${Math.max(3, Math.round((t.u / maxU) * 92))}px"></div><span class="d">${t.day.slice(5)}</span></div>`
    ).join("");
    const problemBlock = problems === 0
      ? `<div class="okline">✓ 今日无异常，一切正常</div>`
      : `<table><tr><th style="width:52px">时间</th><th style="width:120px">客户</th><th style="width:88px">设备</th><th>问题</th><th style="width:220px">建议</th></tr>` +
        d.problems.map((p) => `<tr><td class="nowrap">${esc(p.created_at.slice(11, 16))}</td><td class="nowrap">${esc(p.key_name || p.key_note || (p.key_code || "").slice(0, 14) || "-")}</td>
          <td>${esc({ pc: "电脑", android: "安卓", ios: "苹果" }[p.platform] || p.platform || "-")}</td>
          <td>${esc((activity.EVENTS[p.event] || [, p.event])[1])}${p.detail ? "：" + esc(p.detail.slice(0, 60)) : ""}</td>
          <td style="color:#777">${esc(TIPS[p.event] || "持续关注")}</td></tr>`).join("") +
        (problems > d.problems.length ? `<tr><td colspan="5" style="color:#999">…还有 ${problems - d.problems.length} 条，后台日志中心查看全部</td></tr>` : "") + "</table>";
    const sys = [
      ["登录态守护", d.guard && d.guard.lastResult ? (d.guard.dead ? `<span class="warn">异常：${esc((d.guard.lastResult.detail || "").slice(0, 40))}</span>` : `<span class="ok">正常</span>`) : "—"],
      ["上次换新登录态", d.guard && d.guard.lastRefresh ? `${esc(d.guard.lastRefresh.at)}（${d.guard.lastRefresh.ok ? "成功" : "失败"}）` : "无"],
      ["上游订阅码", d.expDays != null ? (d.expDays <= 7 ? `<span class="warn">剩 ${d.expDays} 天到期，余数 ${esc(getSetting("mars_bd") || "")}</span>` : `剩 ${d.expDays} 天 · 余数 ${esc(getSetting("mars_bd") || "")}`) : "—"],
      ["连续失败 / 熔断", d.guard && d.guard.fails ? `<span class="warn">${d.guard.fails} 次${d.guard.breakerUntil ? "，已熔断" : ""}</span>` : "0 次"],
      ["版本分布", d.versions.length ? d.versions.map((v) => `${esc(v.v)} · ${v.c}`).join("　") : "—"],
      ["同步总量", db.prepare("SELECT count(*) c FROM activity_log WHERE event='page_sync' AND created_at>=?").get(d.target + " 00:00:00").c + " 次"],
    ].map(([k, v]) => `<div class="r"><span>${k}</span><b>${v}</b></div>`).join("");
    const wd = "日一二三四五六"[new Date(d.target + "T00:00:00+08:00").getDay()];
    return TEMPLATE
      .replace(/\{\{DATE\}\}/g, d.target)
      .replace(/\{\{WEEKDAY\}\}/g, wd)
      .replace(/\{\{STATUS_CLASS\}\}/g, badge[0])
      .replace(/\{\{STATUS_BADGE\}\}/g, badge[1])
      .replace(/\{\{TODAY_USERS\}\}/g, d.today.u)
      .replace(/\{\{TODAY_DEVICES\}\}/g, d.today.d)
      .replace(/\{\{ONLINE_DEVICES\}\}/g, d.online.c)
      .replace(/\{\{ONLINE_USERS\}\}/g, d.online.k)
      .replace(/\{\{TODAY_ACTIVATED\}\}/g, d.newKeys.c)
      .replace(/\{\{BOUND_DEVICES\}\}/g, d.bound.c)
      .replace(/\{\{TODAY_PROBLEMS\}\}/g, problems)
      .replace(/\{\{PROBLEMS_CLASS\}\}/g, problems ? "bad" : "")
      .replace(/\{\{PROBLEM_COUNT_TEXT\}\}/g, problems ? `${problems} 条` : "")
      .replace(/\{\{TREND_BARS\}\}/g, bars)
      .replace(/\{\{TREND_NOTE\}\}/g, "人/天")
      .replace(/\{\{PROBLEM_BLOCK\}\}/g, problemBlock)
      .replace(/\{\{SYS_ROWS\}\}/g, sys)
      .replace(/\{\{FOOTER_TIME\}\}/g, fmt(Date.now()).slice(11, 16));
  }

  let browser = null;
  async function screenshot(html, out) {
    if (!browser) {
      browser = await puppeteer.launch({ args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"] });
    }
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 920, height: 400, deviceScaleFactor: 2 });
      await page.setContent(html, { waitUntil: "load" });
      const el = await page.$("body");
      await el.screenshot({ path: out });
    } finally {
      await page.close();
    }
  }

  async function generate(offsetDays = 0) {
    const data = collect(offsetDays);
    const html = render(data);
    const file = `report-${data.target}.png`;
    const out = path.join(UPLOAD_DIR, file);
    await screenshot(html, out);
    return { file, url: `${PUBLIC_BASE}/${file}`, data, html };
  }

  async function send(offsetDays = 0) {
    const g = await generate(offsetDays);
    const p = g.data.problemCount;
    const url = pageUrl ? pageUrl(g.data.target) : g.url;
    const badge = p === 0 && !(g.data.guard && g.data.guard.dead) ? "✅ 今日正常" : `🔴 ${p} 条问题`;
    const rows = p === 0
      ? "| 状态 | 今日无异常 |\n| --- | --- |"
      : "| 时间 | 客户 | 平台 | 问题 | 建议 |\n| --- | --- | --- | --- | --- |\n" +
        g.data.problems.map((x) => {
          const name = String(x.key_name || x.key_note || x.key_code || "-").replace(/\|/g, "");
          const label = (activity.EVENTS[x.event] || [, x.event])[1];
          const tip = TIPS[x.event] || "持续关注";
          return `| ${x.created_at.slice(11,16)} | ${name.slice(0,18)} | ${{pc:"电脑",android:"安卓",ios:"苹果"}[x.platform] || x.platform || "-"} | ${label} | ${tip} |`;
        }).join("\n");
    const text =
      `### 工作台日报 · ${g.data.target}\n\n` +
      `${badge}\n\n` +
      `| 指标 | 数值 |\n| --- | --- |\n` +
      `| 今日活跃用户 | **${g.data.today.u}** 人 |\n` +
      `| 当前在线设备 | **${g.data.online.c}** 台 |\n` +
      `| 今日新激活 | **${g.data.newKeys.c}** 个 |\n` +
      `| 今日问题 | **${p}** 条 |\n\n` +
      `日报时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}\n\n` +
      `问题明细请点击下方按钮查看。`;
    await dingtalk.post({
      msgtype: "actionCard",
      actionCard: {
        title: `工作台日报 · ${g.data.target}`,
        text: text + `\n\n点击下方按钮查看完整网页版日报。`,
        singleTitle: "查看完整日报",
        singleURL: url,
        btnOrientation: "0",
      },
    });
    return g;
  }

  // 每天到点自动发送（分钟级轮询）
  let timer = null;
  function start() {
    timer = setInterval(async () => {
      try {
        if (getSetting("report_enabled") !== "1") return;
        const t = (getSetting("report_time") || "22:00").split(":");
        const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
        const minutes = d.getHours() * 60 + d.getMinutes();
        const target = (parseInt(t[0], 10) || 22) * 60 + (parseInt(t[1], 10) || 0);
        if (minutes < target || minutes >= target + 5) return;
        if (getSetting("report_last_sent") === fmt(Date.now()).slice(0, 10)) return;
        await send(0);
        require("./db").prepare("INSERT INTO settings (key,value) VALUES ('report_last_sent',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(fmt(Date.now()).slice(0, 10));
        console.log("[report] 日报已发送到钉钉");
      } catch (e) {
        console.warn("[report]", e.message);
      }
    }, 60 * 1000);
  }

  return { collect, render, generate, send, start };
};
