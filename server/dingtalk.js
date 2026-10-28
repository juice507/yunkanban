// 钉钉自定义机器人（加签）
const crypto = require("crypto");

module.exports = function createDingtalk(getSetting) {
  function config() {
    return {
      enabled: getSetting("dingtalk_enabled") === "1",
      webhook: getSetting("dingtalk_webhook") || "",
      secret: getSetting("dingtalk_secret") || "",
    };
  }
  function signedUrl(webhook, secret) {
    const ts = Date.now();
    const sign = encodeURIComponent(
      crypto.createHmac("sha256", secret).update(`${ts}\n${secret}`).digest("base64")
    );
    const sep = webhook.includes("?") ? "&" : "?";
    return `${webhook}${sep}timestamp=${ts}&sign=${sign}`;
  }
  async function post(payload) {
    const cfg = config();
    if (!cfg.webhook) throw new Error("还没填钉钉机器人 Webhook");
    if (!cfg.secret) throw new Error("还没填钉钉签名密钥");
    const r = await fetch(signedUrl(cfg.webhook, cfg.secret), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.errcode !== 0) throw new Error(`钉钉返回错误: ${j.errmsg || "HTTP " + r.status}`);
    return j;
  }
  const markdown = (title, text) => post({ msgtype: "markdown", markdown: { title, text } });
  return { config, post, markdown };
};
