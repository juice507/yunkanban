const {test}=require('node:test');const assert=require('node:assert/strict');
test('UA identifies Android model but never guesses iPhone generation',()=>{
 const {identify}=require('./deviceTelemetry');
 const a=identify({'user-agent':'Mozilla/5.0 (Linux; Android 13; SM-S918B Build/TP1A) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36'},{});
 assert.equal(a.model,'SM-S918B');assert.equal(a.modelSource,'ua');assert.equal(a.deviceType,'phone');assert.equal(a.browserVersion,'120.0.0.0');
 const i=identify({'user-agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 Version/17.2 Mobile/15E148 Safari/604.1'},{});
 assert.equal(i.model,null);assert.equal(i.modelSource,'unknown');assert.equal(i.os,'iOS');assert.equal(i.osVersion,'17.2');
});
test('reported model is unverified and bounded',()=>{
 const {identify}=require('./deviceTelemetry');
 assert.equal(identify({}, {deviceModel:'iPhone 15 Pro'}).modelConfidence,'unverified-report');
 assert.equal(identify({}, {deviceModel:'x'.repeat(81),appVersion:'<token>'}).model,null);
 assert.equal(identify({'sec-ch-ua-model':'"SM-A546B"'},{}).modelSource,'ua-ch');
});
test('SQLite collection keeps timestamps, no raw identity or secrets, bounded pagination',()=>{
 const Database=require('better-sqlite3'),{install,record,listEvents,listDevices}=require('./deviceTelemetry');
 const db=new Database(':memory:');db.exec("CREATE TABLE devices(id INTEGER PRIMARY KEY,key_id INTEGER,device_id TEXT,status TEXT,device_label TEXT,first_login_at TEXT,last_seen_at TEXT);INSERT INTO devices VALUES(1,116,'SECRET_DEVICE','active','标签','2026-01-01 00:00:00','2026-10-04 12:00:00')");
 install(db);install(db);
 record(db,{keyId:116,deviceId:1,type:'verify',outcome:'ok',metadata:require('./deviceTelemetry').identify({'user-agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X)'},{key:'SECRET_KEY',token:'SECRET_TOKEN'})});
 const rows=listEvents(db,116,{limit:1});assert.equal(rows.items.length,1);assert.equal(rows.items[0].type,'verify');assert.equal(rows.timezone,'Asia/Shanghai');
 assert(!JSON.stringify(rows).includes('SECRET'));assert.equal(listEvents(db,117,{}).items.length,0);
 assert.equal(listDevices(db,116).items[0].model,null);assert.equal(listDevices(db,116).items[0].first_login_at,'2026-01-01 00:00:00');
 assert.throws(()=>listEvents(db,116,{limit:101}));assert.throws(()=>listEvents(db,116,{from:'2026-02-30 00:00:00'}));
});
