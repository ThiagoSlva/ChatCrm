'use strict';
const assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {databaseOptions,repositoryForPool}=require('../src/database');
const {loadEnvironment}=require('../src/server');
const {secret,digest,hashPassword}=require('../src/security');
const {verifyDepartmentSchema,verifyChatSchema,verifyContactSchema,verifyOpportunitySchema,verifyConversationContactSchema,verifyPortalSchema}=require('./migrate-database');

async function preservationFingerprint(connection) {
  // Hash rows in SQL; never output existing identities, tokens or message content.
  const tables = [
    ['cl_schema', 'id, version', 'id'], ['cl_company', 'id, name', 'id'],
    ['cl_users', 'id, name, email, password_hash, role, active, created_at', 'id'],
    ['cl_sessions', 'token_hash, user_id, expires_at', 'token_hash'],
    ['cl_departments', 'id, name, active, public_chat, created_at', 'id'],
    ['cl_department_members', 'department_id, user_id', 'department_id, user_id'],
    ['cl_visitors', 'id, name, token_hash, expires_at, created_at', 'id'],
    ['cl_chat_conversations', 'id, visitor_id, department_id, assigned_to, status, last_sequence, updated_at, created_at', 'id'],
    ['cl_chat_messages', 'conversation_id, `sequence`, sender, author_id, client_key, text, created_at', 'conversation_id, `sequence`'],
    ['cl_chat_limits', 'key_hash, window_start, count, expires_at', 'key_hash'],
    ['cl_contacts', 'id, department_id, name, email, phone, company, kind, version, created_by, client_key, request_hash, created_at, updated_at', 'id'],
    ['cl_opportunities', 'id, contact_id, title, amount_cents, stage, version, created_by, client_key, request_hash, created_at, updated_at', 'id'],
    ['cl_opportunity_events', 'opportunity_id, version, actor_id, title, amount_cents, stage, created_at', 'opportunity_id, version'],
    ['cl_conversation_contacts', 'conversation_id, contact_id, version, updated_by, updated_at', 'conversation_id'],
    ['cl_conversation_contact_events', 'conversation_id, version, contact_id, actor_id, created_at', 'conversation_id, version'],
    ['cl_portal_accounts', 'id, visitor_id, access_id, password_hash, recovery_hash, version, active, created_at', 'id'],
    ['cl_portal_sessions', 'token_hash, account_id, expires_at', 'token_hash']
  ];
  const fingerprints = [];
  for (const [table, fields, order] of tables) {
    const [rows] = await connection.query('SELECT SHA2(JSON_ARRAY(' + fields + '), 256) AS fingerprint FROM ' + table + ' ORDER BY ' + order);
    const [ddl] = await connection.query('SHOW CREATE TABLE ' + table);
    // Consumed InnoDB auto-increment numbers can advance despite rollback.
    const definition = String(Object.values(ddl[0])[1]).replace(/\bAUTO_INCREMENT=\d+\b/gi, '').replace(/\s+/g, ' ').trim();
    fingerprints.push([table, rows.map(row => row.fingerprint), digest(definition)]);
  }
  return digest(JSON.stringify(fingerprints));
}


// A single outer connection cannot host overlapping repository transactions.
// Refuse a second lease before it can replace the first transaction's savepoint.
function verificationPool(connection, execute = (sql, args) => connection.execute(sql, args)) {
 let leased = false;
 return {
  execute,
  async getConnection() {
   if (leased) throw new Error('Overlapping verification transactions are not allowed.');
   leased = true;
   return {
    execute,
    beginTransaction: () => connection.query('SAVEPOINT cl_portal_verification'),
    commit: () => connection.query('RELEASE SAVEPOINT cl_portal_verification'),
    async rollback() {
     await connection.query('ROLLBACK TO SAVEPOINT cl_portal_verification');
     await connection.query('RELEASE SAVEPOINT cl_portal_verification');
    },
    release() { leased = false; }
   };
  }
 };
}

async function verifyPortalDatabase(connection){
 const checks=[],suffix=secret().slice(0,16),visitorTokens=[secret(),secret()],accessIds=[secret().slice(0,24),secret().slice(0,24)],codes=[secret(),secret()],passwordHash=await hashPassword(secret()),newHash=await hashPassword(secret());
 const denied=(work,status)=>assert.rejects(work,e=>e.statusCode===status);let baseline,failure,injectFailure=false;
 await connection.beginTransaction();
 try{
  await connection.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
  const pool=verificationPool(connection,async(sql,args)=>{if(injectFailure&&sql==='DELETE FROM cl_portal_sessions WHERE account_id = ?'){injectFailure=false;throw Error('Controlled recovery failure');}return connection.execute(sql,args);}),repo=repositoryForPool(pool);
  assert.deepEqual(await repo.capabilities(),{schemaVersion:7,departments:true,chat:true,contacts:true,opportunities:true,conversationContacts:true,portal:true});
  await verifyDepartmentSchema(connection);await verifyChatSchema(connection);await verifyContactSchema(connection);await verifyOpportunitySchema(connection);await verifyConversationContactSchema(connection);await verifyPortalSchema(connection);
  baseline=await preservationFingerprint(connection);checks.push('schema7-seventeen-tables-strict-defaults-local-foreign-keys');
  const [area]=await connection.execute('INSERT INTO cl_departments (name, public_chat) VALUES (?,1)',['Portal synthetic '+suffix]);const departmentId=Number(area.insertId),visitors=[],conversations=[];
  for(let i=0;i<2;i++){
   const [v]=await connection.execute('INSERT INTO cl_visitors (name, token_hash, expires_at, created_at) VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 8 HOUR), UTC_TIMESTAMP())',['Portal synthetic '+i+' '+suffix,digest(visitorTokens[i])]);visitors.push(Number(v.insertId));
   conversations.push((await repo.createVisitorConversation(visitorTokens[i],departmentId)).conversation.id);
  }
  const input={text:'Portal synthetic original message',clientKey:secret().slice(0,32)};const original=await repo.sendVisitorMessage(visitorTokens[0],conversations[0],input);assert.equal(original.created,true);
  for(let i=0;i<2;i++){assert.equal((await repo.createPortalAccount(visitorTokens[i],{accessId:accessIds[i],passwordHash,recoveryHash:digest(codes[i])})).created,true);assert.equal(await repo.visitorSession(visitorTokens[i]),null);}
  await denied(()=>repo.createPortalAccount(visitorTokens[0],{accessId:secret().slice(0,24),passwordHash,recoveryHash:digest(secret())}),401);
  checks.push('claim-current-visitor-only-expired-guest-cannot-repeat-or-read');
  const accounts=[],tokens=[secret(),secret()];
  for(const id of accessIds) accounts.push(await repo.findPortalAccount(id));
  for(let i=0;i<2;i++){assert.equal(await repo.createPortalSession(tokens[i],accounts[i].id,passwordHash,2),false);assert.equal(await repo.createPortalSession(tokens[i],accounts[i].id,passwordHash,1),true);assert.deepEqual(Object.keys(await repo.portalSession(tokens[i])).sort(),['accessId','name']);}
  for(let i=0;i<2;i++){const list=await repo.listPortalConversations(tokens[i]);assert.equal(list.conversations.length,1);assert.equal(list.conversations[0].id,conversations[i]);assert.deepEqual(Object.keys(list.conversations[0]).sort(),['departmentName','id','status','updatedAt']);}
  assert.equal(await repo.portalMessages(tokens[0],conversations[1],0,50),null);await denied(()=>repo.sendPortalMessage(tokens[0],conversations[1],input),404);
  checks.push('separate-accounts-safe-profiles-history-and-send-isolation');
  const replay=await repo.sendPortalMessage(tokens[0],conversations[0],input);assert.equal(replay.created,false);assert.deepEqual(replay.message,original.message);
  const next=await repo.sendPortalMessage(tokens[0],conversations[0],{text:'Portal synthetic second message',clientKey:secret().slice(0,32)});assert.equal(next.message.sequence,2);
  const history=await repo.portalMessages(tokens[0],conversations[0],0,1);assert.equal(history.hasMore,true);assert.equal(history.cursor,1);assert.equal((await repo.portalMessages(tokens[0],conversations[0],1,1)).messages[0].sequence,2);
  const [authors]=await connection.execute('SELECT DISTINCT author_id FROM cl_chat_messages WHERE conversation_id = ?',[conversations[0]]);assert.deepEqual(authors.map(r=>Number(r.author_id)),[visitors[0]]);
  checks.push('portal-preserves-original-author-idempotency-and-history-cursor');
  await connection.execute('UPDATE cl_departments SET public_chat=0 WHERE id=?',[departmentId]);assert.equal((await repo.listPortalConversations(tokens[0])).conversations[0].departmentName,'Atendimento anterior');assert.equal((await repo.createPortalConversation(tokens[0],departmentId)).created,false);
  await connection.execute('UPDATE cl_departments SET active=0 WHERE id=?',[departmentId]);assert.equal((await repo.portalMessages(tokens[0],conversations[0],0,50)).messages.length,2);await denied(()=>repo.sendPortalMessage(tokens[0],conversations[0],input),404);
  await connection.execute('UPDATE cl_departments SET active=1 WHERE id=?',[departmentId]);await connection.execute("UPDATE cl_chat_conversations SET status='closed' WHERE id=?",[conversations[0]]);assert.equal((await repo.sendPortalMessage(tokens[0],conversations[0],input)).created,false);await denied(()=>repo.createPortalConversation(tokens[0],departmentId),404);
  checks.push('inactive-area-readable-send-denied-private-channel-only-blocks-new');
  const more=[];for(let i=0;i<4;i++){const token=secret();assert.equal(await repo.createPortalSession(token,accounts[0].id,passwordHash,1),true);more.push(token);}await denied(()=>repo.createPortalSession(secret(),accounts[0].id,passwordHash,1),429);await repo.revokePortalSession(more[0]);assert.equal(await repo.portalSession(more[0]),null);assert.notEqual(await repo.portalSession(tokens[1]),null);
  checks.push('five-session-budget-and-logout-isolates-other-account');
  const ip=digest('Portal SQL synthetic '+suffix);for(let i=0;i<10;i++)assert.equal(await repo.portalAttempt(ip,accessIds[0]),true);assert.equal(await repo.portalAttempt(ip,accessIds[0]),false);assert.equal(await repositoryForPool(pool).portalAttempt(digest('Second synthetic '+suffix),accessIds[0]),false);
  const [limits]=await connection.execute('SELECT count FROM cl_chat_limits WHERE key_hash=?',[digest('portal-attempt-access:'+accessIds[0])]);assert.equal(Number(limits[0].count),11);
  checks.push('persistent-auth-attempt-limit-before-hash-including-refused');
  const before=await preservationFingerprint(connection);injectFailure=true;await assert.rejects(repo.recoverPortalAccount(accessIds[0],digest(codes[0]),1,newHash,digest(secret())),/Controlled/);assert.equal(await preservationFingerprint(connection),before);
  checks.push('controlled-recovery-failure-rolls-back-password-code-version-and-sessions');
  const newCode=secret();assert.equal(await repo.recoverPortalAccount(accessIds[0],digest(codes[0]),1,newHash,digest(newCode)),true);assert.equal(await repo.portalSession(tokens[0]),null);for(const token of more)assert.equal(await repo.portalSession(token),null);
  await denied(()=>repo.sendPortalMessage(tokens[0],conversations[0],input),401);assert.equal(await repo.createPortalSession(secret(),accounts[0].id,passwordHash,1),false);assert.equal(await repo.recoverPortalAccount(accessIds[0],digest(codes[0]),1,newHash,digest(secret())),false);
  const recovered=await repo.findPortalAccount(accessIds[0]);assert.equal(recovered.version,2);assert.equal(recovered.passwordHash,newHash);assert.equal(recovered.recoveryHash,digest(newCode));const newToken=secret();assert.equal(await repo.createPortalSession(newToken,recovered.id,newHash,2),true);assert.notEqual(await repo.portalSession(tokens[1]),null);
  checks.push('recovery-CAS-rotates-secret-invalidates-all-own-sessions-and-old-login');
  await connection.execute('UPDATE cl_portal_accounts SET active=0 WHERE id=?',[recovered.id]);assert.equal(await repo.portalSession(newToken),null);await denied(()=>repo.listPortalConversations(newToken),401);await connection.execute('UPDATE cl_portal_accounts SET active=1 WHERE id=?',[recovered.id]);await connection.execute('UPDATE cl_portal_sessions SET expires_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 SECOND) WHERE token_hash=?',[digest(newToken)]);assert.equal(await repo.portalSession(newToken),null);
  checks.push('expired-session-and-inactive-account-revalidated');
 }catch(error){failure=error;}finally{injectFailure=false;await connection.rollback();}
 if(baseline)assert.equal(await preservationFingerprint(connection),baseline,'Previous data and logical schema must be preserved.');if(failure)throw failure;
 checks.push('all-synthetic-data-rolled-back-seventeen-table-records-and-logical-schema-preserved');return {verifiedAt:new Date().toISOString(),checks};
}
async function main(){loadEnvironment();const options=databaseOptions();if(!options)throw Error('Configure o banco privado.');const connection=await mysql.createConnection(options);try{console.log('Portal verificado em transacao revertida: '+JSON.stringify(await verifyPortalDatabase(connection)));}finally{await connection.end();}}
if(require.main===module)main().catch(()=>{console.error('Verificacao SQL do portal falhou. Nenhuma credencial foi exibida.');process.exitCode=1;});
module.exports={verifyPortalDatabase,preservationFingerprint,verificationPool};
