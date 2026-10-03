'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {subscriptionRepository,NOTICE_VERSION}=require('../src/subscriptions-database');
const {digest,secret}=require('../src/security');
const {buildServer}=require('../src/server');
function fixture(){
 const tokens=[secret(),secret()],events=[];let enabled=true,version=8,fault=false,capCount=0,serial=Promise.resolve();const traces=[];
 const c={async execute(sql,args=[]){
  traces.push(sql);
  if(sql==='SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE')return[[{id:1}]];
  if(sql.startsWith('SELECT a.id AS accountId')){const i=tokens.findIndex(t=>digest(t)===args[0]);return[enabled&&i>=0?[{accountId:i+1,visitorId:i+10,accessId:'a'.repeat(24),name:'Synthetic'}]:[]];}
  if(sql.startsWith('SELECT request_hash'))return[events.filter(e=>e.account_id===args[0]&&e.client_key===args[1]).map(e=>({request_hash:e.request_hash}))];
  if(sql.startsWith('SELECT version,subscribed'))return[[...events].filter(e=>e.account_id===args[0]).sort((a,b)=>b.version-a.version).slice(0,1)];
  if(sql.startsWith('SELECT COUNT'))return[[{total:capCount||events.filter(e=>e.account_id===args[0]).length}]];
  if(sql.startsWith('INSERT INTO')){events.push({account_id:args[0],version:args[1],subscribed:args[2],notice_version:args[3],client_key:args[4],request_hash:args[5],created_at:'2026-10-03T16:00:00.000Z'});if(fault)throw Error('controlled insert failure');return[{affectedRows:1}];}
  throw Error('Unexpected SQL');
 }};
 const transaction=work=>{const run=serial.then(async()=>{const before=structuredClone(events);try{return await work(c);}catch(e){events.splice(0,events.length,...before);throw e;}});serial=run.catch(()=>{});return run;};
 const repo=subscriptionRepository({transaction,capabilities:async()=>({portal:true,subscriptions:version===8})});
 const input=(subscribed,v,key=secret().slice(0,32))=>({subscribed,version:v,noticeVersion:NOTICE_VERSION,clientKey:key});
 return{tokens,events,traces,repo,input,enabled:v=>{enabled=v;},version:v=>{version=v;},fault:v=>{fault=v;},cap:v=>{capCount=v;}};
}
const denied=(p,code)=>assert.rejects(p,e=>e.statusCode===code);
test('default is unregistered, only original account changes and withdrawal preserves independent account',async()=>{
 const f=fixture(),a=f.tokens[0],b=f.tokens[1];assert.equal((await f.repo.portalSubscription(a)).preference.subscribed,false);
 assert.equal((await f.repo.updatePortalSubscription(a,f.input(true,0))).preference.version,1);
 assert.equal((await f.repo.portalSubscription(b)).preference.subscribed,false);
 assert.equal((await f.repo.updatePortalSubscription(b,f.input(true,0))).preference.subscribed,true);
 await f.repo.updatePortalSubscription(a,f.input(false,1));assert.equal((await f.repo.portalSubscription(b)).preference.subscribed,true);
 assert.deepEqual(Object.keys((await f.repo.portalSubscription(a)).preference).sort(),['noticeVersion','subscribed','updatedAt','version']);
 assert(f.traces.indexOf('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE')<f.traces.findIndex(s=>s.startsWith('SELECT a.id')));
});
test('two simultaneous choices on same version have one winner; stale opt-in never overwrites withdrawal',async()=>{
 const f=fixture(),a=f.tokens[0];const results=await Promise.allSettled([f.repo.updatePortalSubscription(a,f.input(true,0)),f.repo.updatePortalSubscription(a,f.input(true,0))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.statusCode,409);
 await f.repo.updatePortalSubscription(a,f.input(false,1));await denied(f.repo.updatePortalSubscription(a,f.input(true,0)),409);
 assert.equal((await f.repo.portalSubscription(a)).preference.subscribed,false);assert.equal(f.events.length,2);
});
test('lost response replay does not duplicate audit; replay of old opt-in returns CURRENT withdrawn choice',async()=>{
 const f=fixture(),input=f.input(true,0);await f.repo.updatePortalSubscription(f.tokens[0],input);
 assert.equal((await f.repo.updatePortalSubscription(f.tokens[0],input)).replayed,true);assert.equal(f.events.length,1);
 await f.repo.updatePortalSubscription(f.tokens[0],f.input(false,1));const old=await f.repo.updatePortalSubscription(f.tokens[0],input);
 assert.equal(old.preference.subscribed,false);assert.equal(old.preference.version,2);assert.equal(f.events.length,2);
 await denied(f.repo.updatePortalSubscription(f.tokens[0],{...input,subscribed:false}),409);
});
test('same-state no-op records no new audit; history quota denies opt-in but never blocks actual withdrawal',async()=>{
 const f=fixture(),a=f.tokens[0];assert.equal((await f.repo.updatePortalSubscription(a,f.input(false,0))).changed,false);
 assert.equal(f.events.length,0);await f.repo.updatePortalSubscription(a,f.input(true,0));f.cap(100);
 assert.equal((await f.repo.updatePortalSubscription(a,f.input(false,1))).preference.subscribed,false);
 await denied(f.repo.updatePortalSubscription(a,f.input(true,2)),429);assert.equal(f.events.length,2);
});
test('revoked session, old schema, bad input and transaction failure do not write consent',async()=>{
 const f=fixture(),a=f.tokens[0];f.enabled(false);await denied(f.repo.updatePortalSubscription(a,f.input(true,0)),401);f.enabled(true);f.version(7);await denied(f.repo.portalSubscription(a),503);f.version(8);
 for(const input of[{...f.input(true,0),subscribed:'true'},{...f.input(true,0),version:'0'},{...f.input(true,0),noticeVersion:'other'}, {...f.input(true,0),clientKey:{toString:()=> 'a'.repeat(32)}},{...f.input(true,0),accountId:2}])await denied(f.repo.updatePortalSubscription(a,input),400);
 assert.equal(f.events.length,0);f.fault(true);await assert.rejects(f.repo.updatePortalSubscription(a,f.input(true,0)));assert.equal(f.events.length,0);
});
test('HTTP preference requires portal identity, exact origin, CSRF and strict body; staff cannot subscribe clients',async t=>{
 const f=fixture(),origin='https://test.example.test',token=f.tokens[0];
 const repository={...f.repo,capabilities:async()=>({schemaVersion:8,portal:true,subscriptions:true}),close:async()=>{},portalSession:async v=>v===token?{accessId:'a'.repeat(24),name:'Synthetic'}:null,session:async()=>null};
 const app=buildServer({repository,env:{APP_URL:origin,NODE_ENV:'production'}});t.after(()=>app.close());
 const headers={cookie:'__Host-cl_portal='+token,origin,'x-csrf-token':digest('portal-csrf:'+token)},payload=f.input(true,0);
 const request=(extra={},body=payload)=>app.inject({url:'/api/portal/subscription',method:'POST',headers:{...headers,...extra},payload:body});
 assert.equal((await request({cookie:''})).statusCode,401);assert.equal((await request({cookie:'__Host-cl_session='+token})).statusCode,401);
 assert.equal((await request({origin:'https://foreign.example.test'})).statusCode,403);assert.equal((await request({'x-csrf-token':digest('visitor-csrf:'+token)})).statusCode,403);
 for(const body of[{...payload,version:'0'},{...payload,subscribed:'true'},{...payload,extra:true}])assert.equal((await request({},body)).statusCode,400);
 assert.equal(f.events.length,0);assert.equal((await request()).statusCode,200);
 const read=await app.inject({url:'/api/portal/subscription',headers});assert.equal(read.statusCode,200);assert.equal(read.json().preference.subscribed,true);
 f.version(7);repository.capabilities=async()=>({schemaVersion:7,portal:true});assert.equal((await request()).statusCode,503);
});
