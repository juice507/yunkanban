const test=require('node:test'),assert=require('node:assert/strict');
const Database=require('/opt/yunkanban-admin/server/node_modules/better-sqlite3');
test('real restricted website handler: preview and CAS expiry write preserve activation, allocation and devices',async()=>{
 const db=new Database(':memory:'), bindings=new Database(':memory:');
 db.exec("CREATE TABLE license_keys(id INTEGER PRIMARY KEY,expiry_date TEXT,activated_at TEXT,status TEXT,valid_days INTEGER,license_type TEXT,updated_at TEXT);CREATE TABLE devices(id INTEGER,key_id INTEGER,status TEXT);INSERT INTO license_keys VALUES(1,'2027-01-01 10:00:00','2026-01-01 10:00:00','active',30,'formal','before');INSERT INTO devices VALUES(9,1,'active');");
 bindings.exec("CREATE TABLE bindings(key_id INTEGER,corp_id TEXT,external_userid TEXT);INSERT INTO bindings VALUES(1,'corp','customer')");
 const express=require('/opt/yunkanban-admin/server/node_modules/express'),app=express(); app.use(express.json());app.use(require('./websiteSubscription')(db,bindings,'fixture-only-secret'));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const url='http://127.0.0.1:'+server.address().port;
 const post=async(path,data,auth=true)=>{const r=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer fixture-only-secret'}:{})},body:JSON.stringify(data)});return {status:r.status,data:await r.json()}};
 try {
 const input={corpId:'corp',externalUserid:'customer',keyId:1,expectedExpiry:'2027-01-01 10:00:00',operation:'renew',days:30};
 assert.equal((await post('/preview',input,false)).status,401); assert.equal((await post('/preview',{...input,externalUserid:'other'})).status,403);
 const preview=await post('/preview',input);assert.equal(preview.status,200);assert.equal(preview.data.newExpiry,'2027-01-31 10:00:00');assert.equal(preview.data.timezone,'Asia/Shanghai');
 assert.equal(db.prepare('select expiry_date from license_keys').get().expiry_date,input.expectedExpiry);
 const result=await post('/commit',{...input,previewToken:preview.data.previewToken,confirm:true});assert.equal(result.status,200);
 assert.deepEqual(db.prepare('select expiry_date,activated_at,valid_days,license_type,status from license_keys').get(),{expiry_date:'2027-01-31 10:00:00',activated_at:'2026-01-01 10:00:00',valid_days:30,license_type:'formal',status:'active'});assert.equal(db.prepare('select status from devices').get().status,'active');
 assert.equal((await post('/commit',{...input,previewToken:preview.data.previewToken,confirm:true})).status,409);
 const modify={...input,expectedExpiry:'2027-01-31 10:00:00',operation:'modify',newExpiry:'2025-01-01 10:00:00'};
 const risk=await post('/preview',modify);assert.equal(risk.data.shortens,true);assert.equal(risk.data.expired,true);
 assert.equal((await post('/commit',{...modify,previewToken:risk.data.previewToken,confirm:true})).status,400);
 assert.equal((await post('/commit',{...modify,previewToken:risk.data.previewToken,confirm:true,confirmRisk:true})).status,200);
 const expiredInput={...input,expectedExpiry:'2025-01-01 10:00:00',days:17};
 const expiredPreview=await post('/preview',expiredInput);assert.equal(expiredPreview.status,200);assert.equal(expiredPreview.data.basis,'now');assert.ok(Date.parse(expiredPreview.data.newExpiry.replace(' ','T')+'+08:00')>Date.now());
 for(const days of [90,180,365]) assert.equal((await post('/preview',{...expiredInput,days})).status,200);
 for(const days of [0,-1,1.5,3651,'30']) assert.equal((await post('/preview',{...expiredInput,days})).status,400);
 db.prepare("UPDATE license_keys SET activated_at='' WHERE id=1").run();
 assert.equal((await post('/preview',{...input,expectedExpiry:'2025-01-01 10:00:00'})).status,422);
 assert.equal((await post('/preview',{...input,expectedExpiry:'wrong'})).status,409);
 }finally{await new Promise(r=>server.close(r));db.close();bindings.close()}
});
