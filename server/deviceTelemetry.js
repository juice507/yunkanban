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
const format=n=>new Date(n+8*3600000).toISOString().slice(0,19).replace('T',' ');
function install(db){db.exec(`CREATE TABLE IF NOT EXISTS device_metadata(device_row_id INTEGER PRIMARY KEY,metadata TEXT NOT NULL,collected_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS subscription_events(id INTEGER PRIMARY KEY,key_id INTEGER NOT NULL,device_row_id INTEGER,type TEXT NOT NULL,outcome TEXT NOT NULL,reason TEXT NOT NULL,metadata TEXT NOT NULL,created_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS subscription_events_key_time ON subscription_events(key_id,created_at,id);CREATE TABLE IF NOT EXISTS telemetry_settings(name TEXT PRIMARY KEY,value TEXT NOT NULL);`);db.prepare('INSERT OR IGNORE INTO telemetry_settings VALUES(?,?)').run('started_at',format(Date.now()));}
function record(db,{keyId,deviceId=null,type,outcome,reason='',metadata={}}){
 if(!Number.isSafeInteger(keyId)||keyId<1)return; // Unknown keys do not create telemetry.
 if(!['verify','device_bind','contact_edit','disable','enable','expiry_edit','key_edit','key_delete','device_edit','device_kick','device_delete'].includes(type)||!['ok','rejected'].includes(outcome))throw new Error('Invalid event');
 const safe=Object.fromEntries(['deviceType','model','modelSource','modelConfidence','os','osVersion','browser','browserVersion','appVersion','beforeExpiry','afterExpiry','changedFields','source','beforeStatus','afterStatus'].filter(k=>metadata[k]!=null).map(k=>[k,clean(metadata[k],200)]));
 const now=format(Date.now());db.prepare('INSERT INTO subscription_events(key_id,device_row_id,type,outcome,reason,metadata,created_at) VALUES(?,?,?,?,?,?,?)').run(keyId,deviceId,type,outcome,clean(reason),JSON.stringify(safe),now);
 if(deviceId&&type==='verify'&&outcome==='ok')db.prepare('INSERT INTO device_metadata VALUES(?,?,?) ON CONFLICT(device_row_id) DO UPDATE SET metadata=excluded.metadata,collected_at=excluded.collected_at').run(deviceId,JSON.stringify(safe),now);
 db.prepare('DELETE FROM subscription_events WHERE created_at<?').run(format(Date.now()-90*86400000));
 db.exec('DELETE FROM subscription_events WHERE id < (SELECT id FROM subscription_events ORDER BY id DESC LIMIT 1 OFFSET 99999)');
}
function options(q={}){
 const limit=q.limit===undefined?20:Number(q.limit),offset=q.offset===undefined?0:Number(q.offset);
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||offset>100000)throw {status:400,error:'Invalid pagination'};
 for(const k of ['from','to'])if(q[k]!=null){const s=q[k],n=typeof s==='string'?Date.parse(s.replace(' ','T')+'+08:00'):NaN;if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)||!Number.isFinite(n)||format(n)!==s)throw {status:400,error:'Invalid Shanghai datetime'};}
 if(q.from&&q.to&&q.from>q.to)throw {status:400,error:'Invalid date range'};
 if(q.group&&!['usage','operation'].includes(q.group))throw {status:400,error:'Invalid event group'};return {limit,offset};
}
function listEvents(db,keyId,q={}){const {limit,offset}=options(q);let where='key_id=?',args=[keyId];for(const k of ['from','to'])if(q[k]){where+=' AND created_at'+(k==='from'?'>=':'<=')+'?';args.push(q[k]);}if(q.group)where+=q.group==='usage'?" AND type IN ('verify','device_bind')":" AND type NOT IN ('verify','device_bind')";const total=db.prepare('SELECT count(*) n FROM subscription_events WHERE '+where).get(...args).n;const items=db.prepare('SELECT id,device_row_id,type,outcome,reason,metadata,created_at FROM subscription_events WHERE '+where+' ORDER BY id DESC LIMIT ? OFFSET ?').all(...args,limit,offset).map(x=>({...x,metadata:JSON.parse(x.metadata)}));return {items,total,limit,offset,hasMore:offset+items.length<total,timezone:'Asia/Shanghai',retentionDays:90,startedAt:db.prepare("SELECT value FROM telemetry_settings WHERE name='started_at'").get()?.value||null};}
function listDevices(db,keyId){return {items:db.prepare('SELECT d.id,d.status,d.device_label,d.first_login_at,d.last_seen_at,m.metadata,m.collected_at FROM devices d LEFT JOIN device_metadata m ON m.device_row_id=d.id WHERE d.key_id=? ORDER BY d.last_seen_at DESC LIMIT 100').all(keyId).map(({metadata,...d})=>({...d,model:null,...(metadata?JSON.parse(metadata):{deviceType:'unknown',model:null,modelSource:'unknown',modelConfidence:'unknown'})})),timezone:'Asia/Shanghai'};}
module.exports={identify,install,record,listEvents,listDevices,options};
