// Restricted website business API. Never mount on a public admin session.
const express = require('express');
const crypto = require('crypto');
module.exports = function (db, bindings, secret) {
  const router = express.Router();
  const equal = (a,b) => {const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length && crypto.timingSafeEqual(x,y)};
  router.use((req,res,next)=>equal(req.get('Authorization'),'Bearer '+secret)&&secret ? next() : res.status(401).json({error:'Unauthorized'}));
  const parse = s => {
    if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) throw {status:400,error:'Invalid Shanghai datetime'};
    const n=Date.parse(s.replace(' ','T')+'+08:00');
    if(!Number.isFinite(n)||format(n)!==s) throw {status:400,error:'Invalid Shanghai datetime'};
    return n;
  };
  const format = n => new Date(n+8*3600000).toISOString().slice(0,19).replace('T',' ');
  const sign = payload => crypto.createHmac('sha256',secret).update(payload).digest('hex');
  const getRow = b => {
    if(typeof b.corpId!=='string'||!b.corpId||typeof b.externalUserid!=='string'||!b.externalUserid||!Number.isSafeInteger(b.keyId)||b.keyId<1) throw {status:400,error:'Invalid identity'};
    if(!bindings.prepare('SELECT 1 FROM bindings WHERE key_id=? AND corp_id=? AND external_userid=?').get(b.keyId,b.corpId,b.externalUserid)) throw {status:403,error:'Key not bound to customer'};
    const row=db.prepare('SELECT * FROM license_keys WHERE id=?').get(b.keyId);
    if(!row) throw {status:404,error:'Key not found'};
    if(typeof b.expectedExpiry!=='string'||row.expiry_date!==b.expectedExpiry) throw {status:409,error:'到期时间已变化，请刷新后重试'};
    if(!row.activated_at||!row.expiry_date||row.status==='disabled') throw {status:422,error:'未激活、无到期时间或已禁用密钥不可修改'};
    parse(row.expiry_date);return row;
  };
  const guard = fn => (req,res)=>{try{fn(req,res)}catch(e){res.status(e.status||500).json({error:e.error||'Subscription operation failed'})}};
  // Customer drafts are independent of any key; never backfill from a key on unbind.
  db.exec("CREATE TABLE IF NOT EXISTS subscription_customer_notes(corp_id TEXT NOT NULL,external_userid TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',version INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(corp_id,external_userid))");
  if (bindings.name && bindings.name !== ':memory:' && !db.prepare('PRAGMA database_list').all().some(row=>row.name==='subscription_binding_store')) db.prepare('ATTACH DATABASE ? AS subscription_binding_store').run(bindings.name);
  const bindingWriter = bindings.name && bindings.name !== ':memory:' ? db : bindings;
  const bindingTable = bindingWriter === db ? 'subscription_binding_store.bindings' : 'bindings';
  const customerIdentity=b=>{if(typeof b.corpId!=='string'||!b.corpId||b.corpId.length>100||typeof b.externalUserid!=='string'||!b.externalUserid||b.externalUserid.length>200)throw {status:400,error:'Invalid customer identity'};};
  const draft=b=>{customerIdentity(b);const row=db.prepare('SELECT note,version FROM subscription_customer_notes WHERE corp_id=? AND external_userid=?').get(b.corpId,b.externalUserid)||{note:'',version:0};return {scope:'customer',note:row.note,revision:sign(JSON.stringify([b.corpId,b.externalUserid,row.version,row.note]))};};
  router.post('/customer-note/read',guard((req,res)=>{res.set('Cache-Control','no-store');res.json({contact:draft(req.body)});}));
  router.post('/customer-note',guard((req,res)=>{
    const b=req.body,p=b.patch;customerIdentity(b);
    if(!p||Object.keys(p).length!==1||typeof p.note!=='string'||p.note.length>2000)throw {status:400,error:'Only customer note can be edited'};
    if(p.note===''&&b.confirmClear!==true)throw {status:400,error:'Explicit clear confirmation required'};
    db.transaction(()=>{
      if(bindings.prepare('SELECT 1 FROM bindings WHERE corp_id=? AND external_userid=?').get(b.corpId,b.externalUserid))throw {status:409,error:'客户已绑定，请刷新并编辑当前密钥备注'};
      if(!equal(b.expectedRevision,draft(b).revision))throw {status:409,error:'备注已变化，请刷新后重试'};
      db.prepare('INSERT INTO subscription_customer_notes(corp_id,external_userid,note,version) VALUES(?,?,?,1) ON CONFLICT(corp_id,external_userid) DO UPDATE SET note=excluded.note,version=version+1').run(b.corpId,b.externalUserid,p.note);
    }).immediate();res.json({updated:true,contact:draft(b)});
  }));
  router.post('/bindings',guard((req,res)=>{
    const b=req.body;customerIdentity(b);let keyId=b.keyId;
    if(b.keyCode!==undefined){if(keyId!==undefined||typeof b.keyCode!=='string'||!b.keyCode||b.keyCode.length>200)throw {status:400,error:'Invalid key'};const matches=db.prepare('SELECT id FROM license_keys WHERE key_code=?').all(b.keyCode);if(matches.length!==1)throw {status:404,error:'Key not found'};keyId=matches[0].id;}
    if(!Number.isSafeInteger(keyId)||keyId<1)throw {status:400,error:'Invalid key'};
    let noteConflict=false;
    db.transaction(()=>{
      const row=db.prepare('SELECT id,note FROM license_keys WHERE id=?').get(keyId);if(!row)throw {status:404,error:'Key not found'};
      const prior=bindingWriter.prepare('SELECT * FROM '+bindingTable+' WHERE key_id=?').get(keyId);
      if(prior&&(prior.corp_id!==b.corpId||prior.external_userid!==b.externalUserid))throw {status:409,error:'密钥已绑定其他客户'};
      const note=draft(b).note;
      if(!prior){bindingWriter.prepare('INSERT INTO '+bindingTable+'(key_id,corp_id,external_userid) VALUES(?,?,?)').run(keyId,b.corpId,b.externalUserid);
        if(note&&!(row.note||'').trim())db.prepare("UPDATE license_keys SET note=?,updated_at=datetime('now','localtime') WHERE id=?").run(note,keyId);
      }
      noteConflict=!!(note&&(row.note||'').trim()&&row.note!==note);
    }).immediate();res.json({bound:true,keyId,noteConflict});
  }));
  const contactFields=['customer_name','phone','wechat','qq','note'];
  const boundRow=b=>{
    if(typeof b.corpId!=='string'||!b.corpId||typeof b.externalUserid!=='string'||!b.externalUserid||!Number.isSafeInteger(b.keyId)||b.keyId<1) throw {status:400,error:'Invalid identity'};
    if(!bindings.prepare('SELECT 1 FROM bindings WHERE key_id=? AND corp_id=? AND external_userid=?').get(b.keyId,b.corpId,b.externalUserid)) throw {status:403,error:'Key not bound to customer'};
    const row=db.prepare('SELECT * FROM license_keys WHERE id=?').get(b.keyId);if(!row)throw {status:404,error:'Key not found'};return row;
  };
  const revision=row=>crypto.createHmac('sha256',secret).update(JSON.stringify([row.id,row.updated_at,...contactFields.map(f=>row[f]??'')])).digest('hex');
  const publicContact=row=>({scope:'key',keyId:row.id,...Object.fromEntries(contactFields.map(f=>[f,row[f]??''])),updatedAt:row.updated_at,revision:revision(row)});
  const telemetry=require('./deviceTelemetry');
  router.post('/devices/read',guard((req,res)=>{boundRow(req.body);res.set('Cache-Control','no-store');res.json(telemetry.listDevices(db,req.body.keyId));}));
  router.post('/events/read',guard((req,res)=>{boundRow(req.body);res.set('Cache-Control','no-store');res.json(telemetry.listEvents(db,req.body.keyId,req.body));}));
  router.post('/contact/read',guard((req,res)=>res.json({contact:publicContact(boundRow(req.body))})));
  router.post('/contact',guard((req,res)=>{
    const b=req.body,p=b.patch;
    if(!p||typeof p!=='object'||Array.isArray(p)||!Object.keys(p).length||Object.keys(p).some(f=>!contactFields.includes(f)||typeof p[f]!=='string'||p[f].length>(f==='note'?2000:200)))throw {status:400,error:'Invalid contact patch'};
    if(Object.values(p).some(v=>v==='')&&b.confirmClear!==true)throw {status:400,error:'Explicit clear confirmation required'};
    db.transaction(()=>{
      const row=boundRow(b);if(typeof b.expectedRevision!=='string'||!equal(b.expectedRevision,revision(row)))throw {status:409,error:'资料已在后台变化，请刷新后重试'};
      const fields=Object.keys(p),values=fields.map(f=>f==='phone'?p[f].trim():p[f]);
      if(values.some(v=>v==='')&&b.confirmClear!==true)throw {status:400,error:'Explicit clear confirmation required'};
      db.prepare('UPDATE license_keys SET '+fields.map(f=>f+'=?').join(',')+",updated_at=datetime('now','localtime') WHERE id=?").run(...values,b.keyId);
      telemetry.record(db,{keyId:b.keyId,type:'contact_edit',outcome:'ok',metadata:{source:'restricted-business-api',changedFields:fields.join(',')}});
    }).immediate();res.json({updated:true,contact:publicContact(boundRow(b))});
  }));
  router.post('/disable',guard((req,res)=>{
    const b=req.body;if(b.confirm!==true)throw {status:400,error:'Explicit disable confirmation required'};
    db.transaction(()=>{
      const row=boundRow(b);if(typeof b.expectedUpdatedAt!=='string'||row.updated_at!==b.expectedUpdatedAt||row.status!==b.expectedStatus)throw {status:409,error:'密钥状态已变化，请刷新后重新确认'};
      if(row.status!=='active')throw {status:422,error:'该密钥已禁用或源状态不可封禁'};
      db.prepare("UPDATE license_keys SET status='disabled',updated_at=datetime('now','localtime') WHERE id=?").run(b.keyId);
      db.prepare("UPDATE devices SET status='kicked' WHERE key_id=?").run(b.keyId);
      telemetry.record(db,{keyId:b.keyId,type:'disable',outcome:'ok',metadata:{source:'restricted-business-api'}});
    }).immediate();const row=boundRow(b);res.json({disabled:row.status==='disabled',keyId:row.id,status:row.status,updatedAt:row.updated_at});
  }));
  router.post('/enable',guard((req,res)=>{
    const b=req.body;if(b.confirm!==true)throw {status:400,error:'Explicit confirmation required'};
    db.transaction(()=>{const row=boundRow(b);if(typeof b.expectedUpdatedAt!=='string'||row.updated_at!==b.expectedUpdatedAt||row.status!==b.expectedStatus)throw {status:409,error:'状态已变化'};if(row.status!=='disabled')throw {status:422,error:'Only disabled keys can be enabled'};
      db.prepare("UPDATE license_keys SET status='active',updated_at=datetime('now','localtime') WHERE id=? AND status='disabled'").run(b.keyId);
      telemetry.record(db,{keyId:b.keyId,type:'enable',outcome:'ok',metadata:{source:'restricted-business-api',beforeStatus:'disabled',afterStatus:'active'}});
    }).immediate();const row=boundRow(b);res.json({updated:true,keyId:b.keyId,status:row.expiry_date&&parse(row.expiry_date)<=Date.now()?'expired':row.status});
  }));
  router.post('/device/remove',guard((req,res)=>{
    const b=req.body;if(b.confirm!==true||!Number.isSafeInteger(b.deviceId)||b.deviceId<1)throw {status:400,error:'Explicit device confirmation required'};
    db.transaction(()=>{boundRow(b);const row=db.prepare('SELECT * FROM devices WHERE id=?').get(b.deviceId);if(!row||row.key_id!==b.keyId)throw {status:403,error:'Device not related to key'};if(row.status!==b.expectedDeviceStatus||row.last_seen_at!==b.expectedLastSeen)throw {status:409,error:'Device changed'};
      telemetry.record(db,{keyId:b.keyId,deviceId:row.id,type:'device_delete',outcome:'ok',metadata:{source:'restricted-business-api'}});
      db.prepare('DELETE FROM device_metadata WHERE device_row_id=?').run(row.id);db.prepare('DELETE FROM devices WHERE id=? AND key_id=?').run(row.id,b.keyId);
    }).immediate();res.json({removed:true,deviceId:b.deviceId,keyId:b.keyId});
  }));
  router.post('/preview',guard((req,res)=>{
    const b=req.body,row=getRow(b),now=Date.now();let target;
    if(b.operation==='renew') {
      if(!Number.isSafeInteger(b.days)||b.days<1||b.days>3650) throw {status:400,error:'天数须为1至3650的整数'};
      target=format(Math.max(now,parse(row.expiry_date))+b.days*86400000);
    } else if(b.operation==='modify') target=format(parse(b.newExpiry));
    else throw {status:400,error:'Invalid operation'};
    const claims={corpId:b.corpId,externalUserid:b.externalUserid,keyId:b.keyId,expectedExpiry:b.expectedExpiry,operation:b.operation,days:b.days??null,newExpiry:target,expires:now+5*60000};
    const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');
    res.json({newExpiry:target,expectedExpiry:row.expiry_date,timezone:'Asia/Shanghai',basis:parse(row.expiry_date)>now?'expiry':'now',shortens:parse(target)<parse(row.expiry_date),expired:parse(target)<=now,previewToken:payload+'.'+sign(payload)});
  }));
  router.post('/commit',guard((req,res)=>{
    const b=req.body;
    if(b.confirm!==true||typeof b.previewToken!=='string') throw {status:400,error:'Explicit confirmation required'};
    const [payload,signature,...extra]=b.previewToken.split('.');
    if(extra.length||!equal(signature,sign(payload||''))) throw {status:400,error:'Invalid preview'};
    let c;try{c=JSON.parse(Buffer.from(payload,'base64url').toString())}catch{throw {status:400,error:'Invalid preview'}};
    if(c.expires<Date.now()||c.corpId!==b.corpId||c.externalUserid!==b.externalUserid||c.keyId!==b.keyId||c.expectedExpiry!==b.expectedExpiry||c.operation!==b.operation) throw {status:409,error:'预览已失效，请重新预览'};
    db.transaction(()=>{
      const row=getRow(b);const target=parse(c.newExpiry);
      if((target<parse(row.expiry_date)||target<=Date.now())&&b.confirmRisk!==true) throw {status:400,error:'缩短或已到期需明确风险确认'};
      const changed=db.prepare("UPDATE license_keys SET expiry_date=?,updated_at=datetime('now','localtime') WHERE id=? AND expiry_date=? AND activated_at=? AND status=?").run(c.newExpiry,b.keyId,b.expectedExpiry,row.activated_at,row.status);
      if(changed.changes!==1) throw {status:409,error:'到期时间已变化，请刷新'};
      telemetry.record(db,{keyId:b.keyId,type:'expiry_edit',outcome:'ok',metadata:{source:'restricted-business-api',beforeExpiry:row.expiry_date,afterExpiry:c.newExpiry}});
    }).immediate();
    res.json({updated:true,keyId:b.keyId,expiry_date:db.prepare('SELECT expiry_date FROM license_keys WHERE id=?').get(b.keyId).expiry_date,timezone:'Asia/Shanghai'});
  }));
  return router;
};
