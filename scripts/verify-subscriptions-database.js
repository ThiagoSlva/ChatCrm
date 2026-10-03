'use strict';
// Manual SQL integration: all fixtures remain in one outer rollback-only transaction.
const assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {databaseOptions,repositoryForPool}=require('../src/database');
const {loadEnvironment}=require('../src/server');
const {secret,digest,hashPassword}=require('../src/security');
const {preservationFingerprint,verificationPool}=require('./verify-portal-database');
const {verifySubscriptionSchema,verifyPortalSchema}=require('./migrate-database');
const {NOTICE_VERSION}=require('../src/subscriptions-database');
const {guardedConnection}=require('./verify-crm-concurrency');
async function subscriptionsFingerprint(c){
 const core=await preservationFingerprint(c);
 const [rows]=await c.query('SELECT SHA2(JSON_ARRAY(account_id,version,subscribed,notice_version,client_key,request_hash,created_at),256) AS fingerprint FROM cl_portal_subscription_events ORDER BY account_id,version');
 const [ddl]=await c.query('SHOW CREATE TABLE cl_portal_subscription_events');
 return digest(JSON.stringify([core,rows.map(r=>r.fingerprint),String(Object.values(ddl[0])[1]).replace(/\s+/g,' ').trim()]));
}
async function verifySubscriptions(c){
 const checks=[],tokens=[secret(),secret()],visitors=[secret(),secret()],ids=[secret().slice(0,24),secret().slice(0,24)],codes=[secret(),secret()],hash=await hashPassword(secret()),suffix=secret().slice(0,16);
 let baseline,failure,fault=false;
 const denied=(p,code)=>assert.rejects(p,e=>e.statusCode===code),input=(subscribed,version,key=secret().slice(0,32))=>({subscribed,version,noticeVersion:NOTICE_VERSION,clientKey:key});
 await c.beginTransaction();
 try{
  await c.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');await verifyPortalSchema(c);await verifySubscriptionSchema(c);
  const pool=verificationPool(c,async(sql,args)=>{const result=await c.execute(sql,args);if(fault&&sql.startsWith('INSERT INTO cl_portal_subscription_events')){fault=false;throw Error('Controlled audit failure');}return result;});
  const repo=repositoryForPool(pool);assert.equal((await repo.capabilities()).schemaVersion,8);assert.equal((await repo.capabilities()).subscriptions,true);
  baseline=await subscriptionsFingerprint(c);
  for(let i=0;i<2;i++){
   await c.execute('INSERT INTO cl_visitors (name,token_hash,expires_at,created_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR),UTC_TIMESTAMP())',['Inscricao sintetica '+i+' '+suffix,digest(visitors[i])]);
   await repo.createPortalAccount(visitors[i],{accessId:ids[i],passwordHash:hash,recoveryHash:digest(codes[i])});
   const a=await repo.findPortalAccount(ids[i]);await repo.createPortalSession(tokens[i],a.id,hash,1);
  }
  checks.push('schema8-eighteen-tables-own-portal-identities-no-operational-change');
  assert.equal((await repo.portalSubscription(tokens[0])).preference.subscribed,false);
  const choice=input(true,0);assert.equal((await repo.updatePortalSubscription(tokens[0],choice)).preference.version,1);
  assert.equal((await repo.portalSubscription(tokens[1])).preference.subscribed,false);
  await repo.updatePortalSubscription(tokens[1],input(true,0));
  const [counts]=await c.execute('SELECT COUNT(*) AS total FROM cl_portal_subscription_events');const beforeCount=Number(counts[0].total);
  assert.equal((await repo.updatePortalSubscription(tokens[0],choice)).replayed,true);
  assert.equal(Number((await c.execute('SELECT COUNT(*) AS total FROM cl_portal_subscription_events'))[0][0].total),beforeCount);
  await repo.updatePortalSubscription(tokens[0],input(false,1));const replay=await repo.updatePortalSubscription(tokens[0],choice);assert.equal(replay.preference.subscribed,false);assert.equal(replay.preference.version,2);
  await denied(repo.updatePortalSubscription(tokens[0],{...choice,subscribed:false}),409);await denied(repo.updatePortalSubscription(tokens[0],input(true,0)),409);
  assert.equal((await repo.portalSubscription(tokens[1])).preference.subscribed,true);
  checks.push('default-off-account-isolation-replay-current-state-and-stale-opt-in-denied');
  fault=true;await assert.rejects(repo.updatePortalSubscription(tokens[0],input(true,2)));assert.equal((await repo.portalSubscription(tokens[0])).preference.version,2);
  await repo.updatePortalSubscription(tokens[0],input(true,2));
  const a=await repo.findPortalAccount(ids[0]);
  for(let v=4;v<=103;v++)await c.execute('INSERT INTO cl_portal_subscription_events (account_id,version,subscribed,notice_version,client_key,request_hash,created_at) VALUES (?,?,1,?,?,?,UTC_TIMESTAMP())',[a.id,v,NOTICE_VERSION,secret().slice(0,32),digest('quota synthetic '+v)]);
  await repo.updatePortalSubscription(tokens[0],input(false,103));await denied(repo.updatePortalSubscription(tokens[0],input(true,104)),429);
  await c.execute('UPDATE cl_portal_subscription_events SET created_at=DATE_SUB(UTC_TIMESTAMP(),INTERVAL 2 DAY) WHERE account_id=?',[a.id]);
  assert.equal((await repo.updatePortalSubscription(tokens[0],input(true,104))).preference.version,105);
  checks.push('audit-failure-rolled-back-daily-quota-expiry-withdrawal-always-allowed');
  const before=await repo.portalSubscription(tokens[0]);
  assert.equal(await repo.recoverPortalAccount(ids[0],digest(codes[0]),1,await hashPassword(secret()),digest(secret())),true);
  await denied(repo.portalSubscription(tokens[0]),401);
  const recovered=await repo.findPortalAccount(ids[0]),next=secret();await repo.createPortalSession(next,recovered.id,recovered.passwordHash,recovered.version);
  assert.deepEqual(await repo.portalSubscription(next),before);assert.equal((await repo.portalSubscription(tokens[1])).preference.subscribed,true);
  checks.push('recovery-preserves-preference-revoked-session-denied-other-account-preserved');
 }catch(e){failure=e;}finally{fault=false;await c.rollback();}
 if(baseline)assert.equal(await subscriptionsFingerprint(c),baseline);if(failure)throw failure;
 checks.push('all-fixtures-rolled-back-eighteen-table-records-logical-schema-preserved');return{verifiedAt:new Date().toISOString(),checks};
}
async function main(){loadEnvironment();const options=databaseOptions();if(!options)throw Error();const c=guardedConnection(await mysql.createConnection({...options,connectTimeout:5000}));try{console.log('Inscricoes verificadas em transacao revertida: '+JSON.stringify(await verifySubscriptions(c)));}finally{await c.end();}}
if(require.main===module)main().catch(()=>{console.error('Verificacao SQL de inscricoes falhou. Nenhum segredo foi exibido.');process.exitCode=1;});
module.exports={verifySubscriptions,subscriptionsFingerprint};
