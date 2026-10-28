const {test}=require('node:test');const assert=require('node:assert/strict');const Database=require('better-sqlite3');const factory=require('./adapter');
for(const behavior of ['authentication','bind-read','duplicate','conflict','multi-key','invalid-key','secrets-and-dates'])test(behavior,async()=>{
 const keys=new Database(':memory:');keys.exec("CREATE TABLE license_keys(id INTEGER PRIMARY KEY,key_code TEXT,name TEXT,status TEXT,expiry_date TEXT,valid_days INTEGER,activated_at TEXT,max_devices INTEGER,license_type TEXT); INSERT INTO license_keys VALUES(1,'PRIVATE','fixture','active','2030-01-01',365,'2029-01-01',3,'standard'),(2,'PRIVATE2','fixture2','active','2030-01-02',30,'2029-01-02',2,'standard')");const db=new Database(':memory:');const server=factory(keys,db,'fixture-token').listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 const call=async(body,token='fixture-token')=>{const r=await fetch(base+(body?'/bindings':'/bindings?corpId=fixture&externalUserid=A'),{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()}};const identity={corpId:'fixture',externalUserid:'A',keyId:1};const before=keys.prepare('SELECT * FROM license_keys').all();try{
 if(behavior==='authentication')assert.equal((await call(null,'bad')).status,401);
 else {assert.equal((await call(identity)).status,200);
 if(behavior==='duplicate'){assert.equal((await call(identity)).status,200);assert.equal(db.prepare('SELECT count(*) n FROM bindings').get().n,1)}
 if(behavior==='conflict')assert.equal((await call({...identity,externalUserid:'B'})).status,409);
 if(behavior==='multi-key'){assert.equal((await call({...identity,keyId:2})).status,200);assert.equal((await call()).data.items.length,2)}
 if(behavior==='invalid-key')assert.equal((await call({...identity,keyId:9999})).status,404);
 if(behavior==='bind-read'){const read=await call();assert.equal(read.data.items[0].id,1);assert.equal(read.data.items[0].expiry_date,'2030-01-01')}
 if(behavior==='secrets-and-dates'){const read=await call();assert.equal(JSON.stringify(read).includes('PRIVATE'),false);assert.equal('key_code' in read.data.items[0],false);assert.deepEqual(keys.prepare('SELECT * FROM license_keys').all(),before)}
 }
 } finally {await new Promise(r=>server.close(r));keys.close();db.close()}
});
