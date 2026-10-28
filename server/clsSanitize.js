// 从金十 cookie/localStorage 压缩包里拿掉用户偏好项。
// 共享账号快照里的「行情指标」是空的, 每次注入都会把顾客刚勾的选项冲掉。
// 登录身份仍下发, 指标/自选等留给顾客浏览器本地记住。
const zlib = require("zlib");

const KEEP_FLUTTER = new Set([
  "flutter.spUser",
]);

const DROP_KEYS = new Set([
  "FLASH_SUBSCRIPTION_CATEGORIES",
  "CLASSIFY_LIST",
  "CURRENT_CLASSIFY",
  "notify",
  "sound",
  "VIP_WATCH_TIPS_STEP",
  "VIP_WATCH_VIP_FIRST_ENTER_TIME",
  "flashsTop20",
]);

function isUserPrefKey(k) {
  const key = String(k || "");
  if (DROP_KEYS.has(key)) return true;
  if (key.startsWith("VIP_WATCH_")) return true;
  if (key.startsWith("flutter.") && !KEEP_FLUTTER.has(key)) return true;
  return false;
}

function stripUserPrefs(ls) {
  if (!ls || typeof ls !== "object" || Array.isArray(ls)) return ls || {};
  const next = {};
  for (const [k, v] of Object.entries(ls)) {
    if (isUserPrefKey(k)) continue;
    next[k] = v;
  }
  return next;
}

function inflateB64(b64) {
  if (!b64) return null;
  const raw = Buffer.from(String(b64), "base64");
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

function loosenCookies(obj) {
  const wasString = typeof obj.coos === "string";
  const coos = parseMaybe(obj.coos);
  if (!Array.isArray(coos)) return false;
  let changed = false;
  for (const c of coos) {
    if (c && c.httpOnly) {
      c.httpOnly = false;
      changed = true;
    }
  }
  if (changed) obj.coos = wasString ? JSON.stringify(coos) : coos;
  return changed;
}

// 旧插件只会写快照列出的域名。浏览器在 API/工具子域名留下的 host-only
// x-token 会盖过 .jin10.com 的新 Token，因此给实际使用的域名补同一份登录态。
const AUTH_HOSTS = [
  "www.jin10.com",
  "svip.jin10.com",
  "reportory.jin10.com",
  "bridge.content-protect.jin10.com",
  "subscription-api.jin10.com",
  "credits-api.jin10.com",
  "reference-api.jin10.com",
  "reference-open-api.jin10.com",
  "e6564436b4c349e0adb2df8c99be9679.z3c.jin10.com",
  "uc-api.jin10.com",
  "jiaoyixia-market.jin10.com",
  "indicators-api.jin10.com",
  "favor-api.jin10.com",
  "jad-api.jin10.com",
  "user-config-api.jin10.com",
  "search-open-api.jin10.com",
  "app-server.jin10.com",
  "mp-api.jin10.com",
  "common-open-api.jin10.com",
  "comment-api.jin10.com",
  "flash-api.jin10.com",
  "qihuo.jin10.com",
  "topic17z2k407.jin10.com",
  // 页面实际请求的动态 API 域名。旧的 host-only x-token 会盖过 .jin10.com。
  "0a8650194d064704ac11ec524a07f49e.z3c.jin10.com",
  "e275e6c04ee14c62ac337ef42009dc04.z3c.jin10.com",
  "e7b20d2f47974615a969c9090673c562.z3c.jin10.com",
  "45e2295b97334ffaafd913531ad526f6.z3c.jin10.com",
  "3318fc142ea545eab931e22a61ec6e5c.z3c.jin10.com",
  "388b845191014c1f968d9cfdc839fc26.z3c.jin10.com",
  "4a735ea38f8146198dc205d2e2d1bd28.z3c.jin10.com",
];
function syncAuthHostTokens(obj) {
  const wasString = typeof obj.coos === "string";
  const coos = parseMaybe(obj.coos);
  if (!Array.isArray(coos)) return false;
  const source = coos.find((c) => c && c.name === "x-token" &&
    String(c.domain || "").replace(/^\./, "") === "jin10.com");
  if (!source || !source.value) return false;
  let changed = false;
  for (const host of AUTH_HOSTS) {
    const target = coos.find((c) => c && c.name === "x-token" &&
      String(c.domain || "").replace(/^\./, "") === host &&
      (c.path || "/") === (source.path || "/"));
    const fresh = { ...source, domain: host, hostOnly: true };
    if (target) {
      if (target.value === fresh.value && target.expirationDate === fresh.expirationDate) continue;
      Object.assign(target, fresh);
    } else {
      coos.push(fresh);
    }
    changed = true;
  }
  if (changed) obj.coos = wasString ? JSON.stringify(coos) : coos;
  return changed;
}

// 旧版 iOS 插件按数组顺序逐个写入 Cookie。先写登录 Token，避免页面
// 在其余偏好 Cookie 写入期间发出未登录请求。
function prioritizeAuthCookies(obj) {
  const wasString = typeof obj.coos === "string";
  const coos = parseMaybe(obj.coos);
  if (!Array.isArray(coos)) return false;
  const ordered = coos.filter((c) => c && c.name === "x-token")
    .concat(coos.filter((c) => !c || c.name !== "x-token"));
  if (ordered.every((c, i) => c === coos[i])) return false;
  obj.coos = wasString ? JSON.stringify(ordered) : ordered;
  return true;
}

function injectVipCookie(obj) {
  const db = require("./db");
  const vipEnabled = db.prepare("SELECT value FROM settings WHERE key=?").get("vip_expiry_enabled");
  const vipDate = db.prepare("SELECT value FROM settings WHERE key=?").get("vip_expiry_date");
  if (!vipEnabled || vipEnabled.value !== "1" || !vipDate || !vipDate.value) return false;
  const wasString = typeof obj.coos === "string";
  const coos = parseMaybe(obj.coos);
  if (!Array.isArray(coos)) return false;
  const existing = coos.find(c => c && c.name === "vip_exp");
  if (existing) return false;
  const vipExpValue = vipDate.value.replace(/-/g, "");
  const vipCookie = {
    domain: ".jin10.com",
    expirationDate: new Date(vipDate.value + "T23:59:59").getTime() / 1000,
    hostOnly: false, httpOnly: false, name: "vip_exp", path: "/",
    sameSite: "unspecified", secure: true, session: false, storeId: "0",
    value: vipExpValue
  };
  coos.push(vipCookie);
  obj.coos = wasString ? JSON.stringify(coos) : coos;
  return true;
}

// Withdraw only the synthetic identity produced by the previous patch.
// An empty value overwrites stale client cache; the site reloads real userinfo.
function clearSyntheticSpUser(obj) {
  const wasString = typeof obj.ls === "string";
  const ls = parseMaybe(obj.ls);
  if (!ls || typeof ls !== "object" || Array.isArray(ls)) return false;
  let user = parseMaybe(ls["flutter.spUser"]);
  if (typeof user === "string") user = parseMaybe(user);
  if (!user || user.id !== 1 || user.vip_str !== "黑金会员") return false;
  ls["flutter.spUser"] = "";
  obj.ls = wasString ? JSON.stringify(ls) : ls;
  return true;
}

function sanitizeClsB64(clsB64) {
  if (!clsB64 || String(clsB64).length < 20) return clsB64 || "";
  try {
    const txt = inflateB64(clsB64);
    if (!txt) return clsB64;
    const obj = JSON.parse(txt);
    const loosened = loosenCookies(obj);
    const mirrored = syncAuthHostTokens(obj);
    const prioritized = prioritizeAuthCookies(obj);
    const vipInjected = injectVipCookie(obj);
    const cookiesChanged = loosened || mirrored || prioritized || vipInjected;
    const lsWasString = typeof obj.ls === "string";
    const ls = parseMaybe(obj.ls);
    let lsChanged = false;
    if (ls && typeof ls === "object" && !Array.isArray(ls)) {
      const next = stripUserPrefs(ls);
      lsChanged = Object.keys(next).length !== Object.keys(ls).length;
      if (!lsChanged) {
        for (const k of Object.keys(ls)) {
          if (!(k in next)) { lsChanged = true; break; }
        }
      }
      if (lsChanged) obj.ls = lsWasString ? JSON.stringify(next) : next;
    }
    if (clearSyntheticSpUser(obj)) lsChanged = true;
    if (!cookiesChanged && !lsChanged) return clsB64;
    return zlib.deflateSync(Buffer.from(JSON.stringify(obj), "utf8")).toString("base64");
  } catch (e) {
    return clsB64;
  }
}

module.exports = { isUserPrefKey, stripUserPrefs, sanitizeClsB64 };
