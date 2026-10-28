const crypto = require("crypto");

// 云看板新密钥使用产品前缀。开头的 # 会阻止把密钥直接拼入 URL 的
// 第三方插件发送完整密钥；云看板插件通过 JSON 发送，不受影响。
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
function genKey(groups = 4, groupLen = 5) {
  const parts = [];
  for (let g = 0; g < groups; g++) {
    let s = "";
    for (let i = 0; i < groupLen; i++) {
      s += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
    }
    parts.push(s);
  }
  return "#YKB-" + parts.join("-");
}

module.exports = { genKey };
