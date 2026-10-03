'use strict';

// Manual HTTP/SQL integration check. Never called by npm test or deployment.
// Only empty dedicated test databases, fresh private backup and explicit opt-in.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const mysql = require('mysql2/promise');
const { databaseOptions } = require('../src/database');
const { loadEnvironment } = require('../src/server');
const { secret, digest, hashPassword } = require('../src/security');
const { preservationFingerprint } = require('./verify-portal-database');
const { guardedConnection } = require('./verify-crm-concurrency');
const validators = require('./migrate-database');
const TABLES = Object.freeze(['cl_schema','cl_company','cl_users','cl_sessions','cl_departments','cl_department_members','cl_visitors','cl_chat_conversations','cl_chat_messages','cl_chat_limits','cl_contacts','cl_opportunities','cl_opportunity_events','cl_conversation_contacts','cl_conversation_contact_events','cl_portal_accounts','cl_portal_sessions']);
const LOCK = 'SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE';
const ORDER = { cl_sessions:'token_hash', cl_department_members:'department_id, user_id', cl_chat_messages:'conversation_id, \`sequence\`', cl_chat_limits:'key_hash', cl_opportunity_events:'opportunity_id, version', cl_conversation_contacts:'conversation_id', cl_conversation_contact_events:'conversation_id, version', cl_portal_sessions:'token_hash' };
const normalize = value => JSON.parse(JSON.stringify(value));
const int = value => Number.isInteger(value) && value > 0 && value <= 4294967295;
const fail = () => { throw Error('Verificacao manual interrompida.'); };

function parseArguments(args, configuredOrigin) {
  if (!Array.isArray(args) || !args.includes('--allow-temporary-fixtures') || args.length < 3 || args.length > 4 || new Set(args).size !== args.length) fail();
  const manifest = args.find(a => a.startsWith('--backup-manifest='));
  const origin = args.find(a => a.startsWith('--origin='));
  if (!manifest || !origin || args.some(a => a !== '--allow-temporary-fixtures' && a !== '--cleanup-only' && a !== manifest && a !== origin)) fail();
  const url = new URL(origin.slice(9));
  if (url.protocol !== 'https:' || url.username || url.password || url.href !== url.origin + '/' || url.origin !== configuredOrigin || origin.slice(9) !== url.origin) fail();
  const manifestFile = manifest.slice(18);
  if (!path.isAbsolute(manifestFile)) fail();
  return { origin:url.origin, manifestFile, cleanupOnly:args.includes('--cleanup-only') };
}

function privateFile(file, directory, fileSystem = fs) {
  const stat = fileSystem.lstatSync(file);
  if (fileSystem.realpathSync(file) !== file || path.dirname(file) !== directory || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) fail();
  return stat;
}
async function verifyBackup(manifestFile, fileSystem = fs) {
  const directory = path.dirname(manifestFile);
  if (fileSystem.realpathSync(directory) !== directory || (fileSystem.statSync(directory).mode & 0o777) !== 0o700) fail();
  privateFile(manifestFile, directory, fileSystem);
  const data = JSON.parse(fileSystem.readFileSync(manifestFile,'utf8'));
  if (data.schemaVersion !== 7 || !/^[a-f0-9]{64}$/.test(data.databaseFingerprint || '') || !/^[a-f0-9]{64}$/.test(data.backupSha256 || '') || !Number.isSafeInteger(data.backupBytes) || data.backupBytes < 1 || typeof data.backup !== 'string' || !path.isAbsolute(data.backup)) fail();
  if (privateFile(data.backup, directory, fileSystem).size !== data.backupBytes) fail();
  const hash = createHash('sha256');
  for await (const chunk of fileSystem.createReadStream(data.backup)) hash.update(chunk);
  if (hash.digest('hex') !== data.backupSha256) fail();
  return data;
}
async function inspectSchema(connection) {
  const [rows] = await connection.query('SHOW TABLES');
  assert.deepEqual(rows.map(r=>Object.values(r)[0]).sort(),[...TABLES].sort());
  const [schema] = await connection.query('SELECT id, version FROM cl_schema ORDER BY id');
  assert.deepEqual(schema.map(r=>({id:Number(r.id),version:Number(r.version)})),[{id:1,version:7}]);
  const [engines] = await connection.query('SELECT TABLE_NAME AS tableName, ENGINE AS engine FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  assert.deepEqual(engines.map(r=>r.tableName).sort(),[...TABLES].sort());
  assert(engines.every(r=>String(r.engine).toUpperCase()==='INNODB'));
  for (const name of ['verifyDepartmentSchema','verifyChatSchema','verifyContactSchema','verifyOpportunitySchema','verifyConversationContactSchema','verifyPortalSchema']) await validators[name](connection);
}
async function inspectPreflight(connection) {
  await inspectSchema(connection);
  const [companies] = await connection.query('SELECT id FROM cl_company ORDER BY id');
  assert.deepEqual(companies.map(r=>Number(r.id)),[1]);
  const [users] = await connection.query('SELECT id, role, active FROM cl_users ORDER BY id');
  assert.equal(users.length,1); assert.equal(users[0].role,'admin'); assert.equal(Number(users[0].active),1);
  const adminId = Number(users[0].id); assert(int(adminId));
  for (const table of TABLES.slice(3)) {
    const [rows] = await connection.query('SELECT COUNT(*) AS total FROM ' + table);
    assert.equal(Number(rows[0].total),0,'Banco de teste deve estar vazio.');
  }
  return adminId;
}
async function snapshot(connection) {
  const rows = {};
  for (const table of TABLES.slice(2)) rows[table] = normalize((await connection.query('SELECT * FROM ' + table + ' ORDER BY ' + (ORDER[table] || 'id')))[0]);
  return rows;
}
function validateRegistry(r) {
  assert(r && r.schemaVersion === 7 && /^[a-f0-9]{32}$/.test(r.suffix || '') && /^[a-f0-9]{64}$/.test(r.baseline || '') && int(r.adminId));
  assert(r.seed && r.user && int(r.user.id) && int(r.departmentId) && r.user.id !== r.adminId);
  assert.equal(r.seed.cl_users.length,1);
  const user = r.seed.cl_users[0];
  assert.equal(Number(user.id),r.user.id); assert.equal(user.name,'Operador HTTPS ' + r.suffix);
  assert.equal(user.email,'portal-https-' + r.suffix + '@example.test'); assert.equal(user.role,'operator'); assert.equal(Number(user.active),1);
  assert.match(user.password_hash,/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(r.seed.cl_departments.length,1);
  assert.equal(Number(r.seed.cl_departments[0].id),r.departmentId);
  assert.equal(r.seed.cl_departments[0].name,'HTTPS ' + r.suffix);
  assert.equal(Number(r.seed.cl_departments[0].active),1); assert.equal(Number(r.seed.cl_departments[0].public_chat),0);
  assert.equal(r.seed.cl_visitors.length,2); assert.equal(r.seed.cl_portal_accounts.length,2); assert.equal(r.seed.cl_chat_conversations.length,2);
  assert.equal(r.seed.cl_sessions.length,1); assert.equal(Number(r.seed.cl_sessions[0].user_id),r.user.id);
  assert.equal(r.seed.cl_department_members.length,1);
  assert.deepEqual(r.seed.cl_department_members[0],{department_id:r.departmentId,user_id:r.user.id});
  const ids = new Set();
  for (let i=0;i<2;i++) {
    const v=r.seed.cl_visitors[i], a=r.seed.cl_portal_accounts[i], c=r.seed.cl_chat_conversations[i];
    assert(int(Number(v.id)) && int(Number(a.id)) && int(Number(c.id))); assert(!ids.has(Number(v.id))); ids.add(Number(v.id));
    assert.equal(v.name,'Cliente HTTPS ' + i + ' ' + r.suffix); assert.match(v.token_hash,/^[a-f0-9]{64}$/);
    assert.equal(Number(a.visitor_id),Number(v.id)); assert.match(a.access_id,/^[a-f0-9]{24}$/); assert.equal(a.password_hash,user.password_hash);
    assert.match(a.recovery_hash,/^[a-f0-9]{64}$/); assert.equal(Number(a.version),1); assert.equal(Number(a.active),1);
    assert.equal(Number(c.visitor_id),Number(v.id)); assert.equal(Number(c.department_id),r.departmentId);
    assert.equal(c.status,'waiting'); assert.equal(c.assigned_to,null); assert.equal(Number(c.last_sequence),0);
  }
  assert.equal(new Set(r.seed.cl_portal_accounts.map(a=>Number(a.id))).size,2);
  assert.equal(new Set(r.seed.cl_chat_conversations.map(c=>Number(c.id))).size,2);
  assert.equal(r.seed.cl_portal_sessions.length,3);
  assert.deepEqual(r.seed.cl_portal_sessions.map(s=>Number(s.account_id)).sort((a,b)=>a-b),[Number(r.seed.cl_portal_accounts[0].id),Number(r.seed.cl_portal_accounts[0].id),Number(r.seed.cl_portal_accounts[1].id)].sort((a,b)=>a-b));
  for (const table of ['cl_sessions','cl_portal_sessions']) for (const s of r.seed[table]) assert.match(s.token_hash,/^[a-f0-9]{64}$/);
  for (const table of ['cl_chat_messages','cl_chat_limits','cl_contacts','cl_opportunities','cl_opportunity_events','cl_conversation_contacts','cl_conversation_contact_events']) assert.deepEqual(r.seed[table],[]);
  assert.equal(r.messages.length,3);
  for (const [i,m] of r.messages.entries()) {
    assert.equal(m.conversation_id,Number(r.seed.cl_chat_conversations[0].id)); assert.equal(m.sequence,i+1);
    assert.equal(m.sender,i===1?'team':'visitor'); assert.equal(m.author_id,i===1?r.user.id:Number(r.seed.cl_visitors[0].id));
    assert.equal(m.text,['Pergunta sintetica ','Resposta sintetica ','Retorno sintetico '][i]+r.suffix); assert.match(m.client_key,/^[a-f0-9]{32}$/);
  }
  assert.equal(new Set(r.messages.map(m=>m.client_key)).size,3);
}
function validateOwnedRows(r, rows) {
  validateRegistry(r);
  const users=rows.cl_users.filter(u=>Number(u.id)!==r.adminId);
  assert.deepEqual(users,r.seed.cl_users);
  for (const table of ['cl_departments','cl_department_members','cl_visitors','cl_portal_accounts','cl_contacts','cl_opportunities','cl_opportunity_events','cl_conversation_contacts','cl_conversation_contact_events']) assert.deepEqual(rows[table],r.seed[table]);
  for (const table of ['cl_sessions','cl_portal_sessions']) {
    const expected = new Map(r.seed[table].map(s=>[s.token_hash,s]));
    assert(rows[table].length<=expected.size);
    for (const s of rows[table]) assert.deepEqual(s,expected.get(s.token_hash));
  }
  assert(rows.cl_chat_messages.length<=3);
  const messageKeys=new Set();
  for (const m of rows.cl_chat_messages) {
    const allowed=r.messages.find(x=>x.client_key===m.client_key); assert(allowed);
    const actual={...m}; delete actual.created_at;
    assert.deepEqual(actual,allowed); assert(!messageKeys.has(m.client_key)); messageKeys.add(m.client_key);
  }
  assert.equal(rows.cl_chat_conversations.length,2);
  for (const c of rows.cl_chat_conversations) {
    const before=r.seed.cl_chat_conversations.find(x=>Number(x.id)===Number(c.id)); assert(before);
    for (const field of ['id','visitor_id','department_id','created_at']) assert.deepEqual(c[field],before[field]);
    if (Number(c.id)!==r.messages[0].conversation_id) assert.deepEqual(c,before);
    else {
      assert(['waiting','open','closed'].includes(c.status));
      assert(c.assigned_to===null || Number(c.assigned_to)===r.user.id);
      assert.equal(Number(c.last_sequence),rows.cl_chat_messages.length);
      assert.deepEqual(rows.cl_chat_messages.map(m=>Number(m.sequence)).sort((a,b)=>a-b),Array.from({length:rows.cl_chat_messages.length},(_,i)=>i+1));
    }
  }
  const budgets = new Map([[digest('message:visitor:'+r.seed.cl_visitors[0].id),2],[digest('message:team:'+r.user.id),1]]);
  assert(rows.cl_chat_limits.length<=2);
  for (const row of rows.cl_chat_limits) assert(budgets.has(row.key_hash) && Number.isSafeInteger(Number(row.count)) && Number(row.count)>0 && Number(row.count)<=budgets.get(row.key_hash));
}
function writeJournal(file, registry, { create = false } = {}) {
  if (create) fs.writeFileSync(file,JSON.stringify(registry)+'\n',{flag:'wx',mode:0o600});
  else {
    privateFile(file,path.dirname(file));
    const next=file+'.next';
    fs.writeFileSync(next,JSON.stringify(registry)+'\n',{flag:'wx',mode:0o600});
    fs.renameSync(next,file);
  }
}
async function setupFixtures(connection, registry, runtime, journalFile) {
  await connection.beginTransaction();
  try {
    await connection.execute(LOCK); registry.adminId=await inspectPreflight(connection);
    assert.equal(await preservationFingerprint(connection),registry.baseline);
    const hash=await hashPassword(secret());
    const [u]=await connection.execute("INSERT INTO cl_users (name,email,password_hash,role,active) VALUES (?,?,?,'operator',1)",['Operador HTTPS '+registry.suffix,'portal-https-'+registry.suffix+'@example.test',hash]);
    registry.user={id:Number(u.insertId)};
    const [d]=await connection.execute('INSERT INTO cl_departments (name,active,public_chat) VALUES (?,1,0)',['HTTPS '+registry.suffix]); registry.departmentId=Number(d.insertId);
    await connection.execute('INSERT INTO cl_department_members (department_id,user_id) VALUES (?,?)',[registry.departmentId,registry.user.id]);
    await connection.execute('INSERT INTO cl_sessions (token_hash,user_id,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[digest(runtime.team),registry.user.id]);
    for(let i=0;i<2;i++) {
      const [v]=await connection.execute('INSERT INTO cl_visitors (name,token_hash,expires_at,created_at) VALUES (?,?,DATE_SUB(UTC_TIMESTAMP(),INTERVAL 1 SECOND),UTC_TIMESTAMP())',['Cliente HTTPS '+i+' '+registry.suffix,digest(runtime.guests[i])]);
      const [a]=await connection.execute('INSERT INTO cl_portal_accounts (visitor_id,access_id,password_hash,recovery_hash,version,active,created_at) VALUES (?,?,?,?,1,1,UTC_TIMESTAMP())',[Number(v.insertId),secret().slice(0,24),hash,digest(secret())]);
      for (const token of runtime.portals[i]) await connection.execute('INSERT INTO cl_portal_sessions (token_hash,account_id,expires_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR))',[digest(token),Number(a.insertId)]);
      await connection.execute('INSERT INTO cl_chat_conversations (visitor_id,department_id,updated_at,created_at) VALUES (?,?,UTC_TIMESTAMP(),UTC_TIMESTAMP())',[Number(v.insertId),registry.departmentId]);
    }
    registry.seed=await snapshot(connection); registry.seed.cl_users=registry.seed.cl_users.filter(u=>Number(u.id)!==registry.adminId);
    registry.messages=[0,1,2].map(i=>({conversation_id:Number(registry.seed.cl_chat_conversations[0].id),sequence:i+1,sender:i===1?'team':'visitor',author_id:i===1?registry.user.id:Number(registry.seed.cl_visitors[0].id),client_key:secret().slice(0,32),text:['Pergunta sintetica ','Resposta sintetica ','Retorno sintetico '][i]+registry.suffix}));
    registry.stage='commit-attempted'; validateRegistry(registry); writeJournal(journalFile,registry,{create:true});
    registry.journalCreated=true;
    await connection.commit();
    registry.stage='setup-committed'; writeJournal(journalFile,registry);
  } catch(error) { try{await connection.rollback();}catch{} throw error; }
}
async function cleanupFixtures(connection, registry, fingerprint = preservationFingerprint) {
  validateRegistry(registry);
  await connection.beginTransaction();
  try {
    await connection.execute(LOCK);
    if (await fingerprint(connection)===registry.baseline) { await connection.rollback(); return {alreadyClean:true}; }
    // No DELETE before every sentinel and dependency has been checked.
    const rows=await snapshot(connection); validateOwnedRows(registry,rows);
    const remove=async(table,column,values,count)=>{
      const [result]=await connection.execute('DELETE FROM '+table+' WHERE '+column+' IN ('+values.map(()=>'?').join(',')+')',values);
      assert.equal(Number(result.affectedRows),count);
    };
    await remove('cl_portal_sessions','token_hash',registry.seed.cl_portal_sessions.map(s=>s.token_hash),rows.cl_portal_sessions.length);
    await remove('cl_portal_accounts','id',registry.seed.cl_portal_accounts.map(a=>Number(a.id)),2);
    await remove('cl_chat_messages','conversation_id',registry.seed.cl_chat_conversations.map(c=>Number(c.id)),rows.cl_chat_messages.length);
    await remove('cl_chat_conversations','id',registry.seed.cl_chat_conversations.map(c=>Number(c.id)),2);
    await remove('cl_visitors','id',registry.seed.cl_visitors.map(v=>Number(v.id)),2);
    await remove('cl_chat_limits','key_hash',[digest('message:visitor:'+registry.seed.cl_visitors[0].id),digest('message:team:'+registry.user.id)],rows.cl_chat_limits.length);
    await remove('cl_sessions','token_hash',registry.seed.cl_sessions.map(s=>s.token_hash),rows.cl_sessions.length);
    await remove('cl_department_members','department_id',[registry.departmentId],1);
    await remove('cl_departments','id',[registry.departmentId],1);
    await remove('cl_users','id',[registry.user.id],1);
    assert.equal(await fingerprint(connection),registry.baseline,'Preservacao nao confirmada.');
    await connection.commit(); return {removedOwnedFixtures:true};
  } catch(error) { try{await connection.rollback();}catch{} throw error; }
}
function httpsClient(origin, cookie = '', csrfToken = '', fetchImpl = fetch) {
  return async(route,method='GET',body,options={})=>{
    const url=new URL(route,origin);
    if(!route.startsWith('/api/') || url.origin!==origin || !['GET','POST'].includes(method)) fail();
    const response=await fetchImpl(url,{method,redirect:'error',headers:{
      ...(cookie?{Cookie:cookie}:{}),
      ...(method==='POST'?{Origin:origin,'Content-Type':'application/json',...(csrfToken?{'X-CSRF-Token':csrfToken}:{})}:{}),
      ...(options.noCsrf?{'X-CSRF-Token':''}:{}),...(options.foreignOrigin?{Origin:'https://unauthorized.example.test'}:{})
    },body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    const text=await response.text(); if(text.length>32768) fail();
    return {status:response.status,data:JSON.parse(text)};
  };
}
async function verifyFlow(origin, r, runtime) {
  const checks=[];
  const team=httpsClient(origin,'__Host-cl_session='+runtime.team,digest('csrf:'+runtime.team));
  const a=httpsClient(origin,'__Host-cl_portal='+runtime.portals[0][0],digest('portal-csrf:'+runtime.portals[0][0]));
  const secondDevice=httpsClient(origin,'__Host-cl_portal='+runtime.portals[0][1],digest('portal-csrf:'+runtime.portals[0][1]));
  const b=httpsClient(origin,'__Host-cl_portal='+runtime.portals[1][0],digest('portal-csrf:'+runtime.portals[1][0]));
  const anonymous=httpsClient(origin);
  const conversation=r.messages[0].conversation_id;
  const portalRoute='/api/portal/conversations/'+conversation;
  const teamRoute='/api/chat/team/conversations/'+conversation;
  const payload=i=>({text:r.messages[i].text,clientKey:r.messages[i].client_key});
  assert.equal((await anonymous('/api/portal/me')).status,401);
  const profile=await a('/api/portal/me'); assert.equal(profile.status,200);
  assert.deepEqual(Object.keys(profile.data.account).sort(),['accessId','name']);
  assert.equal(profile.data.csrfToken,digest('portal-csrf:'+runtime.portals[0][0]));
  const staff=await team('/api/auth/me'); assert.equal(staff.status,200); assert.equal(staff.data.user.role,'operator'); assert.equal(staff.data.capabilities.schemaVersion,7);
  assert.equal((await httpsClient(origin,'__Host-cl_visitor='+runtime.guests[0])('/api/chat/visitor/me')).status,401);
  checks.push('prepared-separate-sessions-and-expired-original-guest');
  const list=await a('/api/portal/conversations'); assert.equal(list.status,200); assert.equal(list.data.conversations.length,1);
  assert.deepEqual(Object.keys(list.data.conversations[0]).sort(),['departmentName','id','status','updatedAt']);
  assert.equal(list.data.conversations[0].id,conversation); assert.equal(list.data.conversations[0].departmentName,'Atendimento anterior');
  assert.equal((await b(portalRoute+'/messages')).status,404);
  assert.equal((await b(portalRoute+'/messages','POST',payload(0))).status,404);
  assert.equal((await a(portalRoute+'/messages','POST',payload(0),{noCsrf:true})).status,403);
  assert.equal((await a(portalRoute+'/messages','POST',payload(0),{foreignOrigin:true})).status,403);
  checks.push('own-history-safe-dto-other-account-origin-and-csrf-denied');
  const first=await a(portalRoute+'/messages','POST',payload(0)); assert.equal(first.status,201); assert.equal(first.data.message.sequence,1);
  const replay=await a(portalRoute+'/messages','POST',payload(0)); assert.equal(replay.status,200); assert.deepEqual(replay.data,first.data);
  assert.equal((await a(portalRoute+'/messages','POST',{...payload(0),text:'Divergencia sintetica '+r.suffix})).status,409);
  const queue=await team('/api/chat/team/conversations'); assert.equal(queue.status,200); assert(queue.data.conversations.some(c=>c.id===conversation));
  const incoming=await team(teamRoute+'/messages'); assert.equal(incoming.status,200); assert.equal(incoming.data.messages[0].text,payload(0).text);
  checks.push('client-message-team-queue-real-http-and-idempotent-replay');
  assert.equal((await team(teamRoute+'/claim','POST',{})).status,200);
  const reply=await team(teamRoute+'/messages','POST',payload(1)); assert.equal(reply.status,201); assert.equal(reply.data.message.sequence,2);
  assert.equal((await team(teamRoute+'/messages','POST',payload(1))).status,200);
  const page=await a(portalRoute+'/messages?after=0&limit=1'); assert.equal(page.status,200); assert.equal(page.data.cursor,1); assert.equal(page.data.hasMore,true);
  const later=await secondDevice(portalRoute+'/messages?after=1&limit=50'); assert.equal(later.status,200); assert.equal(later.data.messages[0].sender,'team'); assert.equal(later.data.messages[0].text,payload(1).text);
  assert.equal((await secondDevice(portalRoute+'/messages','POST',payload(2))).status,201);
  checks.push('operator-claim-reply-client-pagination-and-second-device');
  assert.equal((await team(teamRoute+'/close','POST',{})).status,200);
  const closed=await secondDevice('/api/portal/conversations'); assert.equal(closed.data.conversations[0].status,'closed');
  const history=await a(portalRoute+'/messages'); assert.equal(history.status,200); assert.equal(history.data.messages.length,3);
  assert.deepEqual(history.data.messages.map(m=>({text:m.text,sender:m.sender,sequence:m.sequence})),r.messages.map(m=>({text:m.text,sender:m.sender,sequence:m.sequence})));
  assert.equal((await a(portalRoute+'/messages','POST',{text:'Nova mensagem apos encerramento '+r.suffix,clientKey:secret().slice(0,32)})).status,409);
  assert.equal((await a(portalRoute+'/messages','POST',payload(0))).status,200);
  assert.equal((await a('/api/portal/conversations','POST',{departmentId:r.departmentId})).status,404);
  checks.push('closed-history-preserved-new-send-denied-private-channel-not-opened');
  assert.equal((await a('/api/portal/logout','POST',{})).status,200); assert.equal((await a('/api/portal/me')).status,401);
  assert.equal((await secondDevice('/api/portal/me')).status,200); assert.equal((await b('/api/portal/me')).status,200);
  checks.push('logout-one-device-other-device-and-account-preserved');
  return checks;
}
async function main() {
  loadEnvironment(); const settings=parseArguments(process.argv.slice(2),process.env.APP_URL);
  const backup=await verifyBackup(settings.manifestFile);
  const journalFile=settings.manifestFile+'.portal-https-run.json';
  const options=databaseOptions(); if(!options) fail();
  let connection,registry,failed,checks=[];
  const connect=async()=>{
    const c=guardedConnection(await mysql.createConnection({...options,connectTimeout:5000}));
    const [lock]=await c.execute("SELECT GET_LOCK('conversa-livre-schema-v1',0) AS acquired");
    if(Number(lock[0]?.acquired)!==1) {await c.end();fail();}
    return c;
  };
  try {
    connection=await connect(); await inspectSchema(connection);
    if(settings.cleanupOnly) {
      privateFile(journalFile,path.dirname(settings.manifestFile)); registry=JSON.parse(fs.readFileSync(journalFile,'utf8'));
      assert.equal(registry.baseline,backup.databaseFingerprint); assert.equal(registry.origin,settings.origin);
      await cleanupFixtures(connection,registry); registry.stage='cleaned'; writeJournal(journalFile,registry);
      checks=['cleanup-only-owned-fixtures-and-seventeen-table-preservation'];
    } else {
      if(fs.existsSync(journalFile)) fail();
      await inspectPreflight(connection); assert.equal(await preservationFingerprint(connection),backup.databaseFingerprint);
      const runtime={team:secret(),guests:[secret(),secret()],portals:[[secret(),secret()],[secret()]]};
      registry={schemaVersion:7,suffix:secret().slice(0,32),baseline:backup.databaseFingerprint,origin:settings.origin};
      await setupFixtures(connection,registry,runtime,journalFile);
      try {checks=await verifyFlow(settings.origin,registry,runtime);} catch(error){failed=error;}
    }
  } catch(error){failed=error;}
  finally {
    try {
      if(!settings.cleanupOnly && registry?.journalCreated && registry.stage!=='cleaned') {
        if(!connection?.alive) connection=await connect();
        await cleanupFixtures(connection,registry); registry.stage='cleaned'; writeJournal(journalFile,registry);
        checks.push('owned-synthetic-fixtures-removed-seventeen-table-preservation');
      }
    } catch{failed=Error('Limpeza ou preservacao nao confirmada.');}
    if(connection?.alive) {try{await connection.execute("SELECT RELEASE_LOCK('conversa-livre-schema-v1')");}catch{failed=Error('Lock nao confirmado.');}}
    if(connection) {try{await connection.end();}catch{failed=Error('Conexao nao encerrada.');}}
  }
  if(failed) fail();
  process.stdout.write('Portal HTTPS verificado: '+JSON.stringify({verifiedAt:new Date().toISOString(),checks,preparedSessions:true,passwordLoginTested:false,registrationRecoveryHttpTested:false})+'\n');
}
if(require.main===module)main().catch(()=>{process.stderr.write('Verificacao HTTPS do portal falhou. Revise o diario privado e use cleanup-only para conferir fixtures antes de repetir. Nenhuma credencial foi exibida.\n');process.exitCode=1;});
module.exports={TABLES,parseArguments,privateFile,verifyBackup,validateRegistry,validateOwnedRows,cleanupFixtures,httpsClient,inspectPreflight};
