// Only interprets already supplied metadata; no fingerprinting or model guessing.
const clean=(v,n=80)=>typeof v==='string'&&v.length<=n&&!/[\x00-\x1f<>]/.test(v)?v.trim():'';
function identify(headers={},body={}) {
 const ua=clean(headers['user-agent'],1024),out={deviceType:'unknown',model:null,modelSource:'unknown',modelConfidence:'unknown',os:null,osVersion:null,browser:null,browserVersion:null,appVersion:clean(body.appVersion)||null};
 let m;
 if((m=ua.match(/Android\s+([\d.]+)/i))){out.os='Android';out.osVersion=m[1];out.deviceType=/Mobile/i.test(ua)?'phone':'tablet';m=ua.match(/Android[^;)]*;\s*(?:[a-z]{2}[-_][A-Z]{2};\s*)?([^;)]+?)(?:\s+Build\/[^;)]*)?\)/);if(m){const model=clean(m[1]);if(model&&!/^(K|wv|Linux|Android|Mobile)$/i.test(model)){out.model=model;out.modelSource='ua';out.modelConfidence='ua-derived';}}}
 else if((m=ua.match(/(?:iPhone|iPad).*?OS\s+([\d_]+)/i))){out.os='iOS';out.osVersion=m[1].replace(/_/g,'.');out.deviceType=/iPad/i.test(ua)?'tablet':'phone';}
 else if((m=ua.match(/Windows NT\s+([\d.]+)/i))){out.os='Windows';out.osVersion=m[1];out.deviceType='desktop';}
 else if((m=ua.match(/Mac OS X\s+([\d_]+)/i))){out.os='macOS';out.osVersion=m[1].replace(/_/g,'.');out.deviceType='desktop';}
 else if(/Linux/i.test(ua)){out.os='Linux';out.deviceType='desktop';}
 for(const [name,re] of [['Edge',/Edg(?:A|iOS)?\/([\d.]+)/],['Firefox',/(?:Firefox|FxiOS)\/([\d.]+)/],['Chrome',/(?:Chrome|CriOS)\/([\d.]+)/],['Safari',/Version\/([\d.]+).*Safari\//]])if((m=ua.match(re))){out.browser=name;out.browserVersion=m[1];break;}
 const reported=clean(body.deviceModel),ch=clean(headers['sec-ch-ua-model']);
 if(reported){out.model=reported;out.modelSource='client-reported';out.modelConfidence='unverified-report';}
 else if(ch&&/^"[^"\\]{1,80}"$/.test(ch)){out.model=ch.slice(1,-1);out.modelSource='ua-ch';out.modelConfidence='unverified-report';}
 return out;
}
module.exports={identify};
