'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),{spawnSync}=require('node:child_process');
const {digest}=require('../src/security');
const {TABLES}=require('../scripts/verify-portal-https');
const {validateRegistry,validateFixtures,cleanup,credentialClient,portalCookie,readJson}=require('../scripts/verify-portal-credentials-https');
const {preservationFingerprint,credentialPreservationFingerprint}=require('../scripts/verify-portal-database');
function fixture(){
 const suffix='a'.repeat(32),time='2026-10-03T15:00:00.000Z',seed={};
 for(const table of TABLES.slice(3).filter(t=>t!=='cl_chat_limits'))seed[table]=[];
 seed.cl_departments=[{id:2,name:'Credenciais HTTPS '+suffix,active:1,public_chat:0,created_at:time}];
 seed.cl_visitors=[0,1].map(i=>({id:i+3,name:'Credenciais HTTPS '+i+' '+suffix,token_hash:digest('guest'+i),expires_at:time,created_at:time}));
 seed.cl_chat_conversations=[0,1].map(i=>({id:i+5,visitor_id:i+3,department_id:2,assigned_to:null,status:'waiting',last_sequence:0,updated_at:time,created_at:time}));
 const r={schemaVersion:7,kind:'portal-credentials-https',suffix,baseline:'b'.repeat(64),dataBaseline:'c'.repeat(64),origin:'https://test.example.test',seed,identities:[0,1].map(i=>({accessId:String(i+1).repeat(24),recoveryHash:digest('old'+i),newRecoveryHash:digest('new'+i)}))};
 const rows=structuredClone(seed);
 rows.cl_portal_accounts=[0,1].map(i=>({id:7+i,visitor_id:3+i,access_id:r.identities[i].accessId,password_hash:'scrypt-v1$'+'d'.repeat(32)+'$'+'e'.repeat(128),recovery_hash:r.identities[i].recoveryHash,version:1,active:1,created_at:time}));
 rows.cl_portal_sessions=[{token_hash:digest('session-a'),account_id:7,expires_at:time},{token_hash:digest('session-b'),account_id:8,expires_at:time}];
 return {r,rows};
}
function connection(rows){
 const statements=[];let fingerprints=0;
 return {
  statements,
  async beginTransaction(){statements.push('BEGIN');},async rollback(){statements.push('ROLLBACK');},async commit(){statements.push('COMMIT');},
  async execute(sql,args){
   statements.push({sql,args});
   if(sql.startsWith('DELETE')){
    const table=sql.split(' ')[2],column=sql.split(' ')[4];
    const count=rows[table].filter(r=>args.includes(r[column])).length;rows[table]=rows[table].filter(r=>!args.includes(r[column]));return[{affectedRows:count}];
   }
   return[[]];
  },
  async query(sql){
   statements.push({sql});
   const table=sql.split(' FROM ')[1]?.split(' ')[0];return[structuredClone(rows[table]||[])];
  },
  fingerprint:async()=>++fingerprints===1?'d'.repeat(64):'c'.repeat(64)
 };
}
test('credential cleanup validates immutable sentinels, identity, planned rotation and no foreign dependencies',()=>{
 const {r,rows}=fixture();validateRegistry(r);validateFixtures(r,rows);
 rows.cl_portal_accounts[0].version=2;rows.cl_portal_accounts[0].recovery_hash=r.identities[0].newRecoveryHash;validateFixtures(r,rows);
 for(const mutate of[
  x=>x.cl_visitors[0].name='Outro cliente',x=>x.cl_chat_conversations[0].visitor_id=99,
  x=>x.cl_portal_accounts[0].visitor_id=99,x=>x.cl_portal_accounts[1].version=2,
  x=>x.cl_portal_accounts[0].recovery_hash=digest('unplanned'),
  x=>x.cl_portal_sessions[0].account_id=99,x=>x.cl_sessions.push({user_id:1}),
  x=>x.cl_chat_messages.push({text:'foreign'}),x=>x.cl_conversation_contacts.push({contact_id:1}),
  x=>x.cl_portal_accounts.push({...x.cl_portal_accounts[1],id:50})
 ]){
  const copy=structuredClone(rows);mutate(copy);assert.throws(()=>validateFixtures(r,copy));
 }
 const wrong=structuredClone(r);wrong.seed.cl_departments[0].public_chat=1;assert.throws(()=>validateRegistry(wrong));
});
test('cleanup deletes only own identity IDs and never queries or removes any shared rate rows',async()=>{
 const {r,rows}=fixture(),c=connection(rows);
 const result=await cleanup(c,r,c.fingerprint);assert.deepEqual(result,{removedOwnedFixtures:true,authenticationLimitsRetained:true});
 assert.equal(c.statements.at(-1),'COMMIT');
 const deletions=c.statements.filter(x=>x.sql?.startsWith('DELETE'));
 assert.deepEqual(deletions.map(x=>x.sql.split(' ')[2]),['cl_portal_sessions','cl_portal_accounts','cl_chat_conversations','cl_visitors','cl_departments']);
 assert.deepEqual(deletions[0].args,[7,8]);assert(!c.statements.some(x=>x.sql?.includes('cl_chat_limits')));
});
test('foreign account/session blocks cleanup before first delete; changed baseline rolls deletes back',async()=>{
 for(const table of['cl_portal_accounts','cl_portal_sessions']){
  const {r,rows}=fixture();rows[table].push(table==='cl_portal_accounts'?{...rows[table][0],id:99,visitor_id:99}:{token_hash:digest('foreign'),account_id:99});
  const c=connection(rows);await assert.rejects(cleanup(c,r,c.fingerprint));assert(!c.statements.some(x=>x.sql?.startsWith('DELETE')));assert.equal(c.statements.at(-1),'ROLLBACK');
 }
 const {r,rows}=fixture(),c=connection(rows);await assert.rejects(cleanup(c,r,async()=> 'd'.repeat(64)));assert.equal(c.statements.at(-1),'ROLLBACK');assert(!c.statements.includes('COMMIT'));
});
test('partial registration, lost login response and ambiguous seed COMMIT remain cleanable without rate reset',async()=>{
 const {r,rows}=fixture();rows.cl_portal_accounts.pop();rows.cl_portal_sessions=rows.cl_portal_sessions.filter(x=>x.account_id===7);
 rows.cl_portal_sessions.push({token_hash:digest('unknown-reply-but-owned-account'),account_id:7,expires_at:'2026-10-03T15:00:00.000Z'});
 const c=connection(rows);await cleanup(c,r,c.fingerprint);
 const untouched=connection({});assert.deepEqual(await cleanup(untouched,r,async()=>r.dataBaseline),{alreadyClean:true,authenticationLimitsRetained:true});
 assert(!untouched.statements.some(x=>x.sql?.startsWith('DELETE')));
});
test('fingerprint excludes only rate record hashes; still checks all 17 logical DDLs and other records',async()=>{
 let rate='rate-before',user='user-before',ddl='stable';
 const c={async query(sql){
  const table=sql.startsWith('SHOW')?sql.slice(18):sql.split(' FROM ')[1]?.split(' ORDER BY ')[0];
  if(sql.startsWith('SHOW'))return[[{'Table':table,'Create Table':'CREATE TABLE '+table+' '+(table==='cl_chat_limits'?ddl:'stable')+' AUTO_INCREMENT=2'}]];
  return [[{fingerprint:table==='cl_chat_limits'?rate:table==='cl_users'?user:'stable-'+table}]];
 }};
 const full=await preservationFingerprint(c),data=await credentialPreservationFingerprint(c);
 rate='rate-after';assert.notEqual(await preservationFingerprint(c),full);assert.equal(await credentialPreservationFingerprint(c),data);
 user='changed-admin';assert.notEqual(await credentialPreservationFingerprint(c),data);
 user='user-before';ddl='changed-index';assert.notEqual(await credentialPreservationFingerprint(c),data);
});
test('credential cookie requires Secure HttpOnly host path, correct SameSite and actual login/clear lifetime',()=>{
 const valid=value=>({cookies:['__Host-cl_portal='+value+'; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure']});
 assert.equal(portalCookie(valid('a'.repeat(64))).csrf,digest('portal-csrf:'+'a'.repeat(64)));
 for(const alter of[
  s=>s.replace('; Secure',''),s=>s.replace('; HttpOnly',''),s=>s.replace('Strict','Lax'),s=>s.replace('Path=/','Path=/portal'),
  s=>s+'; Domain=test.example.test',s=>s.replace('28800','0'),s=>s.replace('a'.repeat(64),'invalid')
 ])assert.throws(()=>portalCookie({cookies:[alter(valid('a'.repeat(64)).cookies[0])]}));
 assert.throws(()=>portalCookie({cookies:[...valid('a'.repeat(64)).cookies,...valid('a'.repeat(64)).cookies]}));
 portalCookie({cookies:['__Host-cl_portal=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure']},{cleared:true});
 portalCookie({cookies:['__Host-cl_visitor=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure']},{cleared:true,visitor:true});
});
test('HTTP credentials stay in bounded POST body, fixed HTTPS origin, no redirects or automatic retries',async()=>{
 const calls=[],http=credentialClient('https://test.example.test',async(url,options)=>{
  calls.push({url:String(url),options});return new Response(JSON.stringify({authenticated:true}),{status:200,headers:{'Set-Cookie':'__Host-cl_portal=test'}});
 });
 const result=await http('/api/portal/login','POST',{accessId:'1'.repeat(24),password:'synthetic-secret'});
 assert.deepEqual(result.data,{authenticated:true});assert.equal(calls.length,1);
 assert(!calls[0].url.includes('synthetic-secret'));assert.equal(calls[0].options.redirect,'error');assert(calls[0].options.signal instanceof AbortSignal);
 assert.equal(calls[0].options.headers.Origin,'https://test.example.test');assert.equal(JSON.parse(calls[0].options.body).password,'synthetic-secret');
 for(const route of['https://other.example.test/api/portal/login','//other.example.test/api/portal/login','/health'])await assert.rejects(http(route));
 await assert.rejects(http('/api/portal/login','DELETE'));await assert.rejects(http('/api/portal/me','GET',{}));assert.equal(calls.length,1);
 assert.throws(()=>credentialClient('http://test.example.test'));
});
test('response reader stops and cancels oversized streamed bytes; malformed JSON is rejected',async()=>{
 await assert.rejects(readJson(new Response('a'.repeat(32769))));
 await assert.rejects(readJson(new Response('not-json')));
 assert.deepEqual(await readJson(new Response('{"ok":true}')),{ok:true});
 let cancelled=false;
 const response={body:new ReadableStream({start(c){c.enqueue(new Uint8Array(32769));},cancel(){cancelled=true;}})};
 await assert.rejects(readJson(response));assert.equal(cancelled,true);
});
test('credential CLI without opt-in cannot connect, print configured secret or run fixtures',()=>{
 const secret='private-never-output-credential',result=spawnSync(process.execPath,[path.resolve(__dirname,'../scripts/verify-portal-credentials-https.js')],{env:{...process.env,APP_URL:'https://test.example.test',DB_PASSWORD:secret},encoding:'utf8',timeout:5000});
 assert.equal(result.status,1);assert(!result.stdout.includes(secret)&&!result.stderr.includes(secret));assert.match(result.stderr,/nao repetir login nem resetar limites/);
});
