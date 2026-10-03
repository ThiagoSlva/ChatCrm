'use strict';

// Explicit, manual credential verification on a dedicated test installation.
// Authentication rate counters are never deleted/reset by this verifier.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {databaseOptions}=require('../src/database');
const {loadEnvironment}=require('../src/server');
const {secret,digest,verifyPassword}=require('../src/security');
const {preservationFingerprint,credentialPreservationFingerprint}=require('./verify-portal-database');
const {TABLES,parseArguments,privateFile,verifyBackup,inspectSchema}=require('./verify-portal-https');
const {guardedConnection}=require('./verify-crm-concurrency');
const LOCK='SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE';
const normalize=value=>JSON.parse(JSON.stringify(value));
const uint=value=>Number.isInteger(value)&&value>0&&value<=4294967295;
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const passwordHash=value=>typeof value==='string'&&/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value);
function stopped(){throw Error('Verificacao de credenciais interrompida.');}
function writeJournal(file,registry,create=false){
 if(create) fs.writeFileSync(file,JSON.stringify(registry)+'\n',{flag:'wx',mode:0o600});
 else {privateFile(file,path.dirname(file));fs.writeFileSync(file+'.next',JSON.stringify(registry)+'\n',{flag:'wx',mode:0o600});fs.renameSync(file+'.next',file);}
}
async function preflight(connection){
 await inspectSchema(connection);
 const [companies]=await connection.query('SELECT id FROM cl_company ORDER BY id');assert.deepEqual(companies.map(r=>Number(r.id)),[1]);
 const [users]=await connection.query('SELECT id,role,active FROM cl_users ORDER BY id');assert.equal(users.length,1);assert.equal(users[0].role,'admin');assert.equal(Number(users[0].active),1);
 for(const table of TABLES.slice(3).filter(t=>t!=='cl_chat_limits')){
  const [rows]=await connection.query('SELECT COUNT(*) AS total FROM '+table);assert.equal(Number(rows[0].total),0);
 }
}
async function fixtureRows(connection){
 const rows={};
 for(const table of TABLES.slice(3).filter(t=>t!=='cl_chat_limits')){
  const order=({cl_sessions:'token_hash',cl_department_members:'department_id,user_id',cl_chat_messages:'conversation_id,\`sequence\`',cl_opportunity_events:'opportunity_id,version',cl_conversation_contacts:'conversation_id',cl_conversation_contact_events:'conversation_id,version',cl_portal_sessions:'token_hash'})[table]||'id';
  rows[table]=normalize((await connection.query('SELECT * FROM '+table+' ORDER BY '+order))[0]);
 }
 return rows;
}
function validateRegistry(r){
 assert(r&&r.schemaVersion===7&&r.kind==='portal-credentials-https'&&/^[a-f0-9]{32}$/.test(r.suffix||'')&&hash(r.baseline)&&hash(r.dataBaseline));
 assert.equal(new URL(r.origin).origin,r.origin);assert.equal(new URL(r.origin).protocol,'https:');
 assert(r.seed&&r.identities?.length===2);
 const d=r.seed.cl_departments;assert.equal(d.length,1);assert(uint(Number(d[0].id)));assert.equal(d[0].name,'Credenciais HTTPS '+r.suffix);assert.equal(Number(d[0].active),1);assert.equal(Number(d[0].public_chat),0);
 assert.equal(r.seed.cl_visitors.length,2);assert.equal(r.seed.cl_chat_conversations.length,2);
 assert.equal(new Set(r.identities.map(x=>x.accessId)).size,2);
 assert.equal(new Set(r.seed.cl_visitors.map(x=>Number(x.id))).size,2);
 assert.equal(new Set(r.seed.cl_chat_conversations.map(x=>Number(x.id))).size,2);
 for(let i=0;i<2;i++){
  const v=r.seed.cl_visitors[i],c=r.seed.cl_chat_conversations[i],identity=r.identities[i];
  assert(uint(Number(v.id))&&uint(Number(c.id)));assert.equal(v.name,'Credenciais HTTPS '+i+' '+r.suffix);assert(hash(v.token_hash));
  assert.match(identity.accessId,/^[a-f0-9]{24}$/);assert(hash(identity.recoveryHash)&&hash(identity.newRecoveryHash));assert.notEqual(identity.recoveryHash,identity.newRecoveryHash);
  assert.equal(Number(c.visitor_id),Number(v.id));assert.equal(Number(c.department_id),Number(d[0].id));assert.equal(c.assigned_to,null);assert.equal(c.status,'waiting');assert.equal(Number(c.last_sequence),0);
 }
 for(const table of TABLES.slice(3).filter(t=>!['cl_chat_limits','cl_departments','cl_visitors','cl_chat_conversations'].includes(t))) assert.deepEqual(r.seed[table],[]);
}
function validateFixtures(r,rows){
 validateRegistry(r);
 for(const table of TABLES.slice(3).filter(t=>!['cl_chat_limits','cl_visitors','cl_portal_accounts','cl_portal_sessions'].includes(t)))assert.deepEqual(rows[table],r.seed[table]);
 assert.equal(rows.cl_visitors.length,2);
 for(const visitor of rows.cl_visitors){
  const before=r.seed.cl_visitors.find(v=>Number(v.id)===Number(visitor.id));assert(before);
  for(const key of Object.keys(before).filter(k=>k!=='expires_at'))assert.deepEqual(visitor[key],before[key]);
  assert(Number.isFinite(Date.parse(visitor.expires_at)));
 }
 assert(rows.cl_portal_accounts.length<=2);
 const ids=new Set(),visitors=new Set();
 for(const a of rows.cl_portal_accounts){
  const i=r.seed.cl_visitors.findIndex(v=>Number(v.id)===Number(a.visitor_id));assert(i>=0);const identity=r.identities[i];
  assert(uint(Number(a.id))&&!ids.has(Number(a.id))&&!visitors.has(Number(a.visitor_id)));ids.add(Number(a.id));visitors.add(Number(a.visitor_id));
  assert.equal(a.access_id,identity.accessId);assert.equal(Number(a.active),1);assert(passwordHash(a.password_hash));
  assert([1,...(i===0?[2]:[])].includes(Number(a.version)));assert.equal(a.recovery_hash,Number(a.version)===1?identity.recoveryHash:identity.newRecoveryHash);
 }
 const sessions=new Set(),count=new Map();
 for(const s of rows.cl_portal_sessions){
  assert(hash(s.token_hash)&&ids.has(Number(s.account_id))&&!sessions.has(s.token_hash));sessions.add(s.token_hash);
  count.set(Number(s.account_id),(count.get(Number(s.account_id))||0)+1);assert(count.get(Number(s.account_id))<=5);assert(Number.isFinite(Date.parse(s.expires_at)));
 }
}
async function cleanup(connection,r,fingerprint=credentialPreservationFingerprint){
 validateRegistry(r);await connection.beginTransaction();
 try{
  await connection.execute(LOCK);
  if(await fingerprint(connection)===r.dataBaseline){await connection.rollback();return {alreadyClean:true,authenticationLimitsRetained:true};}
  const rows=await fixtureRows(connection);validateFixtures(r,rows);
  const remove=async(table,column,values,count)=>{
   if(!values.length){assert.equal(count,0);return;}
   const [result]=await connection.execute('DELETE FROM '+table+' WHERE '+column+' IN ('+values.map(()=>'?').join(',')+')',values);assert.equal(Number(result.affectedRows),count);
  };
  const accountIds=rows.cl_portal_accounts.map(a=>Number(a.id));
  await remove('cl_portal_sessions','account_id',accountIds,rows.cl_portal_sessions.length);
  await remove('cl_portal_accounts','id',accountIds,accountIds.length);
  await remove('cl_chat_conversations','id',r.seed.cl_chat_conversations.map(c=>Number(c.id)),2);
  await remove('cl_visitors','id',r.seed.cl_visitors.map(v=>Number(v.id)),2);
  await remove('cl_departments','id',[Number(r.seed.cl_departments[0].id)],1);
  // Shared IP counters and access counters survive, including uncertain late requests.
  assert.equal(await fingerprint(connection),r.dataBaseline);await connection.commit();
  return {removedOwnedFixtures:true,authenticationLimitsRetained:true};
 }catch(error){try{await connection.rollback();}catch{}throw error;}
}
async function setup(connection,r,runtime,journalFile){
 await connection.beginTransaction();
 try{
  await connection.execute(LOCK);await preflight(connection);assert.equal(await preservationFingerprint(connection),r.baseline);
  r.dataBaseline=await credentialPreservationFingerprint(connection);
  const [d]=await connection.execute('INSERT INTO cl_departments (name,active,public_chat) VALUES (?,1,0)',['Credenciais HTTPS '+r.suffix]);
  for(let i=0;i<2;i++){
   const [v]=await connection.execute('INSERT INTO cl_visitors (name,token_hash,expires_at,created_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR),UTC_TIMESTAMP())',['Credenciais HTTPS '+i+' '+r.suffix,digest(runtime[i].guest)]);
   await connection.execute('INSERT INTO cl_chat_conversations (visitor_id,department_id,updated_at,created_at) VALUES (?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())',[Number(v.insertId),Number(d.insertId)]);
  }
  r.seed=await fixtureRows(connection);r.stage='commit-attempted';validateRegistry(r);writeJournal(journalFile,r,true);r.journalCreated=true;
  await connection.commit();r.stage='setup-committed';writeJournal(journalFile,r);
 }catch(error){try{await connection.rollback();}catch{}throw error;}
}
async function readJson(response){
 const reader=response.body?.getReader();if(!reader)stopped();
 const chunks=[];let bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>32768)stopped();chunks.push(Buffer.from(part.value));}}
 finally{await reader.cancel().catch(()=>{});}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
function credentialClient(origin,fetchImpl=fetch){
 if(new URL(origin).origin!==origin||new URL(origin).protocol!=='https:')stopped();
 return async(route,method='GET',body,{cookie='',csrf='',foreignOrigin=false}={})=>{
  const url=new URL(route,origin);if(!route.startsWith('/api/')||url.origin!==origin||!['GET','POST'].includes(method)||(method==='GET'&&body!==undefined))stopped();
  const response=await fetchImpl(url,{method,redirect:'error',signal:AbortSignal.timeout(15000),headers:{
   ...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{Origin:foreignOrigin?'https://unauthorized.example.test':origin,'Content-Type':'application/json',...(csrf?{'X-CSRF-Token':csrf}:{})}:{})
  },body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await readJson(response),cookies:response.headers.getSetCookie()};
 };
}
function portalCookie(result,{cleared=false,visitor=false}={}){
 const name=visitor?'__Host-cl_visitor':'__Host-cl_portal';
 const matching=result.cookies.filter(c=>c.startsWith(name+'='));assert.equal(matching.length,1);
 const parts=matching[0].split(';').map(p=>p.trim());const attributes=parts.slice(1);
 assert(attributes.includes('Path=/')&&attributes.includes('HttpOnly')&&attributes.includes('Secure'));
 assert(attributes.includes('SameSite='+ (visitor?'Lax':'Strict')));assert(attributes.includes('Max-Age='+(cleared?0:28800)));
 assert(!attributes.some(p=>/^Domain=/i.test(p)));
 const value=parts[0].slice(name.length+1);if(cleared)assert.equal(value,'');else assert(hash(value));
 return {cookie:parts[0],csrf:digest((visitor?'visitor-csrf:':'portal-csrf:')+value)};
}
async function flow(origin,r,runtime,connection,checkpoint=()=>{}){
 const http=credentialClient(origin),checks=[];
 const register=i=>({accessId:r.identities[i].accessId,password:runtime[i].password,confirmation:runtime[i].password,recoveryCode:runtime[i].code});
 const login=(i,password=runtime[i].password)=>({accessId:r.identities[i].accessId,password});
 const guest=i=>({cookie:'__Host-cl_visitor='+runtime[i].guest,csrf:digest('visitor-csrf:'+runtime[i].guest)});
 checkpoint('registration-origin-csrf');
 assert.equal((await http('/api/portal/login','POST',login(0),{foreignOrigin:true})).status,403);
 assert.equal((await http('/api/portal/register','POST',register(0),{cookie:guest(0).cookie})).status,403);
 for(let i=0;i<2;i++){
  checkpoint('registration-'+i);
  assert.equal((await http('/api/chat/visitor/me','GET',undefined,guest(i))).status,200);
  const registration=await http('/api/portal/register','POST',register(i),guest(i));assert.equal(registration.status,201);
  assert.deepEqual(registration.data,{created:true,account:{accessId:r.identities[i].accessId,name:r.seed.cl_visitors[i].name}});
  portalCookie(registration,{visitor:true,cleared:true});assert(!registration.cookies.some(c=>c.startsWith('__Host-cl_portal=')));
  assert.equal((await http('/api/chat/visitor/me','GET',undefined,guest(i))).status,401);
 }
 checks.push('registration-real-https-csrf-origin-guest-expiration-no-auto-login');
 const signIn=async(i,password)=>{
  const result=await http('/api/portal/login','POST',login(i,password));assert.equal(result.status,200);assert.deepEqual(result.data,{authenticated:true});return portalCookie(result);
 };
 checkpoint('password-login-two-devices');
 const a=await signIn(0),second=await signIn(0),b=await signIn(1);
 for(const [i,device]of [[0,a],[0,second],[1,b]]){
  const profile=await http('/api/portal/me','GET',undefined,device);assert.equal(profile.status,200);assert.deepEqual(profile.data,{account:{accessId:r.identities[i].accessId,name:r.seed.cl_visitors[i].name},csrfToken:device.csrf});
  const list=await http('/api/portal/conversations','GET',undefined,device);assert.equal(list.status,200);assert.equal(list.data.conversations.length,1);assert.equal(list.data.conversations[0].id,Number(r.seed.cl_chat_conversations[i].id));
 }
 assert.equal((await http('/api/portal/login','POST',login(0,secret()))).status,401);
 checks.push('password-login-secure-host-cookie-two-devices-isolated-own-history');
 const recover={accessId:r.identities[0].accessId,recoveryCode:runtime[0].code,newPassword:runtime[0].newPassword,confirmation:runtime[0].newPassword,newRecoveryCode:runtime[0].newCode};
 checkpoint('recovery');
 const recovered=await http('/api/portal/recover','POST',recover,a);assert.equal(recovered.status,200);assert.deepEqual(recovered.data,{recovered:true,authenticated:false});
 portalCookie(recovered,{cleared:true});portalCookie(recovered,{visitor:true,cleared:true});
 for(const device of[a,second])assert.equal((await http('/api/portal/me','GET',undefined,device)).status,401);
 assert.equal((await http('/api/portal/me','GET',undefined,b)).status,200);
 checkpoint('old-password-new-login-and-stale-code');
 assert.equal((await http('/api/portal/login','POST',login(0))).status,401);
 const fresh=await signIn(0,runtime[0].newPassword);
 assert.equal((await http('/api/portal/recover','POST',{...recover,newPassword:secret(),confirmation:recover.confirmation})).status,400);
 // Ten credential attempts in total; no retry, IP spoofing or counter reset.
 assert.equal((await http('/api/portal/recover','POST',{...recover,newPassword:runtime[0].password,confirmation:runtime[0].password,newRecoveryCode:secret()})).status,401);
 assert.equal((await http('/api/portal/me','GET',undefined,fresh)).status,200);assert.equal((await http('/api/portal/me','GET',undefined,b)).status,200);
 const rows=await fixtureRows(connection);validateFixtures(r,rows);assert.equal(rows.cl_portal_accounts.length,2);
 for(let i=0;i<2;i++){
  const account=rows.cl_portal_accounts.find(x=>x.access_id===r.identities[i].accessId);assert.equal(Number(account.version),i===0?2:1);
  assert(await verifyPassword(i===0?runtime[i].newPassword:runtime[i].password,account.password_hash));
 }
 checks.push('recovery-real-https-old-password-code-and-all-own-sessions-revoked-other-account-preserved');
 checkpoint('logout');
 assert.equal((await http('/api/portal/logout','POST',{},fresh)).status,200);assert.equal((await http('/api/portal/logout','POST',{},b)).status,200);
 assert.equal((await http('/api/portal/me','GET',undefined,fresh)).status,401);assert.equal((await http('/api/portal/me','GET',undefined,b)).status,401);
 checks.push('real-login-sessions-logout-revoked');
 return checks;
}
async function main(){
 loadEnvironment();const settings=parseArguments(process.argv.slice(2),process.env.APP_URL),backup=await verifyBackup(settings.manifestFile),journalFile=settings.manifestFile+'.portal-credentials-run.json';
 const options=databaseOptions();if(!options)stopped();
 let connection,registry,failure,checks=[],result;
 const connect=async()=>{
  const c=guardedConnection(await mysql.createConnection({...options,connectTimeout:5000}));
  const [rows]=await c.execute("SELECT GET_LOCK('conversa-livre-schema-v1',0) AS acquired");if(Number(rows[0]?.acquired)!==1){await c.end();stopped();}return c;
 };
 try{
  connection=await connect();await inspectSchema(connection);
  if(settings.cleanupOnly){
   privateFile(journalFile,path.dirname(settings.manifestFile));registry=JSON.parse(fs.readFileSync(journalFile,'utf8'));
   assert.equal(registry.baseline,backup.databaseFingerprint);assert.equal(registry.origin,settings.origin);
   result=await cleanup(connection,registry);registry.stage='cleaned';writeJournal(journalFile,registry);checks.push('cleanup-only-own-identities-data-and-logical-schema-preserved-rate-limits-retained');
  }else{
   if(fs.existsSync(journalFile))stopped();await preflight(connection);assert.equal(await preservationFingerprint(connection),backup.databaseFingerprint);
   const runtime=[0,1].map(()=>({guest:secret(),password:secret(),newPassword:secret(),code:secret(),newCode:secret()}));
   registry={schemaVersion:7,kind:'portal-credentials-https',suffix:secret().slice(0,32),baseline:backup.databaseFingerprint,origin:settings.origin,identities:runtime.map(x=>({accessId:secret().slice(0,24),recoveryHash:digest(x.code),newRecoveryHash:digest(x.newCode)}))};
   await setup(connection,registry,runtime,journalFile);checks=await flow(settings.origin,registry,runtime,connection,step=>{registry.lastCheck=step;writeJournal(journalFile,registry);});
  }
 }catch(error){failure=error;}
 finally{
  try{
   if(!settings.cleanupOnly&&registry?.journalCreated&&registry.stage!=='cleaned'){
    if(!connection?.alive)connection=await connect();result=await cleanup(connection,registry);registry.stage='cleaned';writeJournal(journalFile,registry);
    checks.push('own-fixtures-removed-sixteen-table-records-seventeen-table-logical-schema-preserved-rate-limits-retained');
   }
  }catch{failure=Error();}
  if(connection?.alive){try{await connection.execute("SELECT RELEASE_LOCK('conversa-livre-schema-v1')");}catch{failure=Error();}}
  if(connection){try{await connection.end();}catch{failure=Error();}}
 }
 if(failure)stopped();
 process.stdout.write('Credenciais do portal HTTPS verificadas: '+JSON.stringify({verifiedAt:new Date().toISOString(),checks,passwordLoginTested:!settings.cleanupOnly,registrationRecoveryHttpTested:!settings.cleanupOnly,authenticationLimitsRetained:true,...result})+'\n');
}
if(require.main===module)main().catch(()=>{process.stderr.write('Verificacao HTTPS de credenciais falhou. Confira o journal privado e cleanup-only; nao repetir login nem resetar limites. Nenhuma credencial foi exibida.\n');process.exitCode=1;});
module.exports={validateRegistry,validateFixtures,cleanup,credentialClient,portalCookie,readJson,preflight};
