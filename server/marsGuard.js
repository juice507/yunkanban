// 金十登录态守护：定时探活 + 30 分钟模拟使用 + 退避/熔断，防止反复拉取死循环。
// 只用现有设备 token 拉取(pullMarsPack)，绝不自动重新绑定订阅码，不消耗订阅余数。
const zlib = require("zlib");

const APP_ID = "g93rhHb9DcDptyPb"; // 行情指标(Flutter)实际使用的 app-id
const BACKOFF_MIN = [1, 2, 5, 10, 30]; // 连续失败后的等待(分钟)
const BREAKER_FAILS = 5; // 连续失败多少次熔断
const BREAKER_MS = 60 * 60 * 1000; // 熔断暂停 1 小时
const ALERT_GAP_MS = 2 * 60 * 60 * 1000; // 告警最短间隔 2 小时
const DEEP_MS = 30 * 60 * 1000; // 模拟使用检查间隔

function inflate(b64) {
  const raw = Buffer.from(String(b64 || ""), "base64");
  for (const fn of [zlib.inflateSync, zlib.inflateRawSync, zlib.unzipSync]) {
    try { return fn(raw).toString("utf8"); } catch (e) { /* next */ }
  }
  return null;
}
function parseMaybe(v) {
  if (typeof v === "string") { try { return JSON.parse(v); } catch (e) { return v; } }
  return v;
}
function xtokenOf(clsB64) {
  try {
    const obj = JSON.parse(inflate(clsB64));
    const coos = parseMaybe(obj.coos) || [];
    const root = coos.find((c) => c && c.name === "x-token" && String(c.domain || "").replace(/^\./, "") === "jin10.com");
    const any = coos.find((c) => c && c.name === "x-token");
    return ((root || any) && (root || any).value) || "";
  } catch (e) {
    return "";
  }
}

async function getJson(url, xt, ver) {
  const r = await fetch(url, {
    headers: {
      "x-token": xt, "x-app-id": APP_ID, "x-version": ver || "1.0.0",
      Origin: "https://www.jin10.com", Referer: "https://www.jin10.com/",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => null);
  return { http: r.status, j };
}

// alive: true=已登录 false=金十明确说要重新登录 null=查不了(网络等，不算失效)
// vip:   true=会员接口有数据 false=提示仅限会员 null=未知
async function probe(xt, deep) {
  if (!xt) return { alive: false, vip: null, detail: "没有 x-token" };
  const out = { alive: null, vip: null, detail: "" };
  try {
    const u = await getJson("https://uc-api.jin10.com/userinfo", xt);
    if (u.j && u.j.status === 401) return { alive: false, vip: null, detail: "userinfo: 请重新登录" };
    if (u.j && u.j.status === 200 && u.j.data) out.alive = true;
    else return { alive: null, vip: null, detail: `userinfo 异常 HTTP ${u.http}` };
  } catch (e) {
    return { alive: null, vip: null, detail: "userinfo 网络错误 " + e.message };
  }
  if (!deep) { out.detail = "userinfo 正常"; return out; }
  const notes = ["userinfo 正常"];
  try {
    const c = await getJson("https://user-config-api.jin10.com/config/list", xt);
    if (c.j && c.j.status === 401) return { alive: false, vip: null, detail: "config/list: 请重新登录" };
    notes.push(c.j && c.j.status === 200 ? "用户配置正常" : `用户配置 HTTP ${c.http}`);
  } catch (e) { notes.push("用户配置网络错误"); }
  try {
    const o = await getJson("https://order-book-api.jin10.com/order-book?pair=XAUUSD", xt);
    if (o.j && o.j.status === 401) return { alive: false, vip: null, detail: "order-book: 请重新登录" };
    if (o.j && o.j.data) { out.vip = true; notes.push("会员数据(订单簿)正常"); }
    else if (o.j && o.j.status === 403) { out.vip = false; notes.push("会员数据: " + (o.j.message || "仅限会员")); }
    else notes.push(`会员数据 HTTP ${o.http}`);
  } catch (e) { notes.push("会员数据网络错误"); }
  out.detail = notes.join("；");
  return out;
}

module.exports = function createMarsGuard(deps) {
  const { getSetting, setSetting, pullMarsPack, saveMarsPack, alert, isMarsMode } = deps;
  const ev = (event, detail, ok) => { try { deps.log && deps.log(event, { detail, ok }); } catch (e) { /* ignore */ } };
  const st = {
    fails: 0, nextAllowedAt: 0, breakerUntil: 0, lastAlertAt: 0, inflight: null,
    lastCheckAt: 0, lastDeepAt: 0, lastResult: null, lastRefresh: null, dead: false,
  };
  const now = () => Date.now();
  const fmt = (ms) => (ms ? new Date(ms).toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) : "");

  function persist() {
    try {
      setSetting("mars_guard_state", JSON.stringify({
        fails: st.fails, nextAllowedAt: fmt(st.nextAllowedAt), breakerUntil: fmt(st.breakerUntil),
        lastCheckAt: fmt(st.lastCheckAt), lastDeepAt: fmt(st.lastDeepAt),
        lastResult: st.lastResult, lastRefresh: st.lastRefresh, dead: st.dead,
      }));
    } catch (e) { /* ignore */ }
  }
  async function maybeAlert(text, force) {
    if (!force && now() - st.lastAlertAt < ALERT_GAP_MS) return;
    st.lastAlertAt = now();
    ev("guard_alert", text, false);
    try { await alert(text); } catch (e) { console.warn("[mars guard alert]", e.message); }
  }
  function onFail(reason) {
    st.fails += 1;
    const wait = BACKOFF_MIN[Math.min(st.fails - 1, BACKOFF_MIN.length - 1)] * 60 * 1000;
    st.nextAllowedAt = now() + wait;
    st.lastRefresh = { at: fmt(now()), ok: false, reason };
    console.warn(`[mars guard] 拉取失败(${st.fails})：${reason}，${wait / 60000} 分钟后再试`);
    ev("guard_fail", `第 ${st.fails} 次失败：${reason}，${wait / 60000} 分钟后再试`, false);
    if (st.fails >= BREAKER_FAILS) {
      st.breakerUntil = now() + BREAKER_MS;
      console.warn("[mars guard] 连续失败，熔断 1 小时");
      ev("guard_breaker", `连续 ${st.fails} 次失败，暂停自动拉取到 ${fmt(st.breakerUntil)}`, false);
      maybeAlert(`连续 ${st.fails} 次拉取登录态失败，已暂停自动拉取 1 小时。原因：${reason}。上游可能掉线，请人工处理；处理后可在后台手动拉取。`);
    }
    persist();
  }

  // 单飞 + 退避 + 熔断 + 校验通过才替换
  async function refresh(opts = {}) {
    if (st.inflight) return st.inflight;
    if (!opts.force) {
      if (now() < st.breakerUntil) throw new Error("自动拉取已熔断，" + fmt(st.breakerUntil) + " 后恢复");
      if (now() < st.nextAllowedAt) throw new Error("退避中，" + fmt(st.nextAllowedAt) + " 后再试");
    }
    st.inflight = (async () => {
      const token = getSetting("mars_token");
      if (!token) throw new Error("还没有 MarsConnect 设备，请先保存订阅编码");
      let pack;
      try {
        pack = await pullMarsPack(token);
      } catch (e) {
        onFail("上游拉取失败：" + e.message);
        throw e;
      }
      const xt = xtokenOf(pack.cls);
      const p = await probe(xt, true);
      if (p.alive !== true) {
        const reason = p.alive === false ? "上游新包在金十仍是未登录(" + p.detail + ")" : "新包校验不了(" + p.detail + ")";
        onFail(reason + "，已丢弃，继续下发旧包");
        throw new Error(reason);
      }
      const changed = xt !== xtokenOf(getSetting("mars_cls_b64"));
      saveMarsPack(pack);
      const wasDead = st.dead;
      st.fails = 0; st.nextAllowedAt = 0; st.breakerUntil = 0; st.dead = false;
      st.lastRefresh = { at: fmt(now()), ok: true, changed, detail: p.detail };
      console.log(`[mars guard] 新登录包校验通过并已替换(${changed ? "token 已更换" : "token 未变"})：${p.detail}`);
      ev("token_refreshed", `${changed ? "token 已更换" : "token 未变"}；${p.detail}`, true);
      if (wasDead) maybeAlert("登录态已从上游重新拉取并校验通过，客户恢复正常。", true);
      persist();
      return true;
    })().finally(() => { st.inflight = null; });
    return st.inflight;
  }

  async function check(deep) {
    if (!isMarsMode() || !getSetting("mars_token")) return null;
    const p = await probe(xtokenOf(getSetting("mars_cls_b64")), deep);
    st.lastCheckAt = now();
    if (deep) st.lastDeepAt = now();
    st.lastResult = { at: fmt(now()), deep: !!deep, alive: p.alive, vip: p.vip, detail: p.detail };
    persist();
    if (deep || p.alive !== true) ev("guard_check", `${deep ? "模拟使用检查" : "探活"}：${p.alive === true ? "正常" : p.alive === false ? "失效" : "查不了(网络)"}；${p.detail}`, p.alive !== false);
    if (p.alive === null) { console.warn("[mars guard] 检查不了(网络)，不当作失效：", p.detail); return p; }
    const bad = p.alive === false || (deep && p.vip === false);
    if (!bad) {
      if (deep) console.log("[mars guard] 模拟使用检查正常：", p.detail);
      if (st.dead) { st.dead = false; maybeAlert("登录态已恢复正常。", true); persist(); }
      return p;
    }
    st.dead = true;
    console.warn("[mars guard] 当前登录态失效：", p.detail);
    try {
      await refresh();
    } catch (e) {
      maybeAlert(`客户拿到的金十登录态失效(${p.detail})，自动换新失败：${e.message}`);
    }
    return p;
  }

  // 02:30-04:00 每 5 分钟，其余每 10 分钟；另外每 30 分钟做一次模拟使用检查
  function intervalMs() {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const m = d.getHours() * 60 + d.getMinutes();
    return m >= 150 && m < 240 ? 5 * 60 * 1000 : 10 * 60 * 1000;
  }
  let running = false;
  async function tick() {
    if (running) return;
    running = true;
    try {
      const deepDue = now() - st.lastDeepAt >= DEEP_MS;
      const quickDue = now() - st.lastCheckAt >= intervalMs() - 5000;
      if (deepDue) await check(true);
      else if (quickDue) await check(false);
    } catch (e) {
      console.warn("[mars guard tick]", e.message);
    } finally {
      running = false;
    }
  }
  function start() {
    setTimeout(tick, 30 * 1000);
    setInterval(tick, 60 * 1000);
    console.log("[mars guard] 已启动：凌晨 02:30-04:00 每 5 分钟、其余每 10 分钟探活；每 30 分钟模拟使用检查");
  }
  function status() {
    return {
      fails: st.fails, dead: st.dead, inflight: !!st.inflight,
      nextAllowedAt: fmt(st.nextAllowedAt), breakerUntil: fmt(st.breakerUntil),
      lastCheckAt: fmt(st.lastCheckAt), lastDeepAt: fmt(st.lastDeepAt),
      lastResult: st.lastResult, lastRefresh: st.lastRefresh, intervalMin: intervalMs() / 60000,
    };
  }
  function reset() { st.fails = 0; st.nextAllowedAt = 0; st.breakerUntil = 0; persist(); }

  return { start, refresh, check, status, reset, probe, xtokenOf };
};

module.exports.xtokenOf = xtokenOf;
module.exports.probe = probe;
