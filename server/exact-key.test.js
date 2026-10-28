const {test}=require('node:test');const assert=require('node:assert/strict');const Database=require('better-sqlite3');const factory=require('./adapter');
test('full key literal including hash binds exactly, duplicate idempotent, conflict preserves owner and dates',async()=>{
 const keys=new Database(':memory:');keys.exec("CREATE TABLE license_keys(id INTEGER PRIMARY KEY,key_code TEXT,name TEXT,status TEXT,expiry_date TEXT,valid_days INTEGER,activated_at TEXT,max_devices INTEGER,license_type TEXT); INSERT INTO license_keys VALUES(116,'#YKB-AAAAA-BBBBB-CCCCC-DDDDD','fixture','active','2030-01-01',365,'2029-01-01',3,'standard')");const db=new Database(':memory:');const server=factory(keys,db,'fixture-token').listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const before=keys.prepare('SELECT * FROM license_keys').all();const call=async(body)=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/bindings',{method:'POST',headers:{Authorization:'Bearer fixture-token','Content-Type':'application/json'},body:JSON.stringify(body)});return {status:r.status,data:await r.json()}};
 try{const identity={corpId:'fixture',externalUserid:'A',keyCode:'#YKB-AAAAA-BBBBB-CCCCC-DDDDD'};
 assert.equal((await call(identity)).status,200);assert.equal((await call(identity)).data.keyId,116);
 assert.equal((await call({...identity,externalUserid:'B'})).status,409);
 assert.equal((await call({...identity,keyCode:'YKB-AAAAA-BBBBB-CCCCC-DDDDD'})).status,404);
 assert.equal((await call({...identity,keyCode:identity.keyCode+' '})).status,404);
 assert.equal((await call({...identity,keyId:116})).status,400);
 assert.equal(db.prepare('SELECT count(*) n FROM bindings').get().n,1);assert.equal(db.prepare('SELECT external_userid FROM bindings').get().external_userid,'A');assert.deepEqual(keys.prepare('SELECT * FROM license_keys').all(),before);
 }finally{await new Promise(r=>server.close(r));keys.close();db.close()}
});
