const express=require('express');const crypto=require('crypto');
module.exports=function(keys,bindings,token){
 const app=express();app.disable('x-powered-by');app.use(express.json({limit:'4kb'}));
 bindings.exec('CREATE TABLE IF NOT EXISTS bindings(key_id INTEGER PRIMARY KEY,corp_id TEXT NOT NULL,external_userid TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
 app.use((req,res,next)=>{const a=Buffer.from(req.get('Authorization')||'');const b=Buffer.from('Bearer '+token);if(!token||a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.status(401).json({error:'Unauthorized'});next()});

 app.use((req,res,next)=>{res.set('Cache-Control','no-store');next()});
 app.post('/reveal',(req,res)=>{
  const {corpId,externalUserid,keyId}=req.body;
  if(typeof corpId!=='string'||!corpId||typeof externalUserid!=='string'||!externalUserid||!Number.isSafeInteger(keyId)||keyId<1)return res.status(400).json({error:'Invalid identity'});
  if(!bindings.prepare('SELECT 1 FROM bindings WHERE key_id=? AND corp_id=? AND external_userid=?').get(keyId,corpId,externalUserid))return res.status(403).json({error:'Key not bound to customer'});
  const row=keys.prepare('SELECT key_code FROM license_keys WHERE id=?').get(keyId);
  if(!row)return res.status(404).json({error:'Key not found'});
  res.json({keyId,keyCode:row.key_code});
 });
 bindings.exec("CREATE TABLE IF NOT EXISTS binding_audit(id INTEGER PRIMARY KEY,key_id INTEGER NOT NULL,type TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
 app.post('/unbind',(req,res)=>{try{const b=req.body;if(typeof b.corpId!=='string'||!b.corpId||typeof b.externalUserid!=='string'||!b.externalUserid||!Number.isSafeInteger(b.keyId)||b.keyId<1||b.confirm!==true)return res.status(400).json({error:'Explicit scope confirmation required'});bindings.transaction(()=>{const row=bindings.prepare('SELECT 1 FROM bindings WHERE key_id=? AND corp_id=? AND external_userid=?').get(b.keyId,b.corpId,b.externalUserid);if(!row)throw {status:403};if(!keys.prepare('SELECT id FROM license_keys WHERE id=?').get(b.keyId))throw {status:404};bindings.prepare("INSERT INTO binding_audit(key_id,type) VALUES(?,'unbind')").run(b.keyId);const changed=bindings.prepare('DELETE FROM bindings WHERE key_id=? AND corp_id=? AND external_userid=?').run(b.keyId,b.corpId,b.externalUserid);if(changed.changes!==1)throw {status:409};}).immediate();res.json({unbound:true,keyId:b.keyId});}catch(e){res.status(e.status||500).json({error:'Unbind failed'})}});
 for(const action of ['bindings','customer-note/read','customer-note','preview','commit','contact/read','contact','disable','enable','device/remove','devices/read','events/read'])app.post('/'+action,async(req,res)=>{
  try {
   const r=await fetch('http://127.0.0.1:3951/internal/subscription/'+action,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify(req.body),signal:AbortSignal.timeout(7000)});
   const data=await r.json();res.status(r.status).json(data);
  }catch{res.status(503).json({error:'Subscription website API unavailable'})}
 });
 const hasUpdatedAt=keys.prepare('PRAGMA table_info(license_keys)').all().some(c=>c.name==='updated_at');
 const columns='id,name,status,expiry_date,valid_days,activated_at,max_devices,license_type'+(hasUpdatedAt?',updated_at':',NULL AS updated_at');
 const hasDevices=!!keys.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='devices'").get();
 app.get('/bindings',(req,res)=>{const ids=bindings.prepare('SELECT key_id FROM bindings WHERE corp_id=? AND external_userid=?').all(String(req.query.corpId||''),String(req.query.externalUserid||''));res.json({items:ids.map(x=>{const item=keys.prepare('SELECT '+columns+' FROM license_keys WHERE id=?').get(x.key_id);if(!item)return null;item.source_status=item.status;if(item.status==='active'&&item.expiry_date){const stamp=Date.parse(item.expiry_date.replace(' ','T')+'+08:00');if(Number.isFinite(stamp)&&stamp<=Date.now())item.status='expired';}item.expiry_timezone='Asia/Shanghai';if(hasDevices){const usage=keys.prepare("SELECT COUNT(CASE WHEN status='active' THEN 1 END) AS device_used, MAX(NULLIF(last_seen_at,'')) AS last_seen FROM devices WHERE key_id=?").get(x.key_id);Object.assign(item,usage);}return item;}).filter(Boolean)})});
 return app;
};
if(require.main===module){const Database=require('better-sqlite3');const keys=new Database(__dirname+'/data.sqlite',{readonly:true});const bindings=new Database(__dirname+'/subscription-bindings.sqlite');bindings.pragma('journal_mode=WAL');const token=require('fs').readFileSync(__dirname+'/subscription-token','utf8').trim();module.exports(keys,bindings,token).listen(3952,'127.0.0.1')}
