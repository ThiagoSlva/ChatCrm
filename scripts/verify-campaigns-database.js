'use strict';
// Manual integration: synthetic recipients and administrators remain uncommitted.
const assert=require('node:assert/strict'),mysql=require('mysql2/promise');
const {databaseOptions,repositoryForPool}=require('../src/database');
const {loadEnvironment}=require('../src/server');
const {secret,digest,hashPassword}=require('../src/security');
const {subscriptionsFingerprint}=require('./verify-subscriptions-database');
const {verificationPool}=require('./verify-portal-database');
const {guardedConnection}=require('./verify-crm-concurrency');
const {verifyCampaignSchema}=require('./migrate-database');
const {NOTICE_VERSION}=require('../src/subscriptions-database');
const {TABLES:portalTables}=require('./verify-portal-https');
const TABLES=[...portalTables,'cl_portal_subscription_events','cl_campaigns','cl_campaign_recipients','cl_campaign_batches'];
const definitions=[
 ['cl_campaigns','id,title,text,created_by,client_key,request_hash,audience_hash,notice_version,state,created_at','id'],
 ['cl_campaign_recipients','campaign_id,account_id,consent_version,state,delivered_at,read_at','campaign_id,account_id'],
 ['cl_campaign_batches','campaign_id,client_key,delivered,skipped,remaining,created_at','campaign_id,client_key']
];
async function campaignsFingerprint(c){
 const core=await subscriptionsFingerprint(c),tables=[];
 for(const [name,fields,order]of definitions){
  const [rows]=await c.query('SELECT SHA2(JSON_ARRAY('+fields+'),256) AS fingerprint FROM '+name+' ORDER BY '+order);
  const [ddl]=await c.query('SHOW CREATE TABLE '+name);
  tables.push([name,rows.map(r=>r.fingerprint),String(Object.values(ddl[0])[1]).replace(/\bAUTO_INCREMENT=\d+\b/gi,'').replace(/\s+/g,' ').trim()]);
 }
 return digest(JSON.stringify([core,tables]));
}
async function verifyCampaigns(c){
 let baseline,failure,fault=null;const checks=[],hash=await hashPassword(secret()),staff=[secret(),secret()],portal=[],accounts=[],ids=[],suffix=secret().slice(0,16);
 const denied=(p,status)=>assert.rejects(p,e=>e.statusCode===status),choice=(subscribed,version)=>({subscribed,version,noticeVersion:NOTICE_VERSION,clientKey:secret().slice(0,32)});
 const [tables]=await c.query('SHOW TABLES');assert.deepEqual(tables.map(r=>Object.values(r)[0]).sort(),[...TABLES].sort());
 const [engines]=await c.execute('SELECT TABLE_NAME, ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()');assert.equal(engines.length,21);assert(engines.every(r=>r.ENGINE==='InnoDB'));
 await c.beginTransaction();
 try{
  await c.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');await verifyCampaignSchema(c);
  baseline=await campaignsFingerprint(c);
  const pool=verificationPool(c,async(sql,args)=>{const r=await c.execute(sql,args);if((fault==='queue'&&sql.startsWith('INSERT INTO cl_campaign_recipients'))||(fault==='batch'&&sql.startsWith('INSERT INTO cl_campaign_batches'))){fault=null;throw Error('Controlled campaign failure');}return r;});
  const repo=repositoryForPool(pool);assert.equal((await repo.capabilities()).schemaVersion,9);assert.equal((await repo.capabilities()).campaigns,true);
  for(let i=0;i<2;i++){const [u]=await c.execute('INSERT INTO cl_users (name,email,password_hash,role) VALUES (?,?,?,?)',['Campanha sintetica '+i,'campaign-'+i+'-'+suffix+'@example.test',hash,i?'operator':'admin']);ids.push(Number(u.insertId));assert.equal(await repo.createSession(staff[i],ids[i],hash),true);}
  const preview=()=>repo.previewCampaign(ids[0],staff[0],{title:'Novidade sintetica '+suffix,text:'Entrega local de teste. Nenhum destinatario real.'});
  const create=async()=>{const p=await preview();return{input:{title:p.title,text:p.text,audienceHash:p.audienceHash,clientKey:secret().slice(0,32)}};};
  await denied(repo.previewCampaign(ids[1],staff[1],{title:'Teste',text:'Teste'}),403);
  for(let i=0;i<53;i++){
   const guest=secret(),token=secret(),accessId=secret().slice(0,24);
   await c.execute('INSERT INTO cl_visitors (name,token_hash,expires_at,created_at) VALUES (?,?,DATE_ADD(UTC_TIMESTAMP(),INTERVAL 1 HOUR),UTC_TIMESTAMP())',['Cliente de campanha sintetico '+i+' '+suffix,digest(guest)]);
   await repo.createPortalAccount(guest,{accessId,passwordHash:hash,recoveryHash:digest(secret())});
   const account=await repo.findPortalAccount(accessId);accounts.push(account.id);portal.push(token);await repo.createPortalSession(token,account.id,hash,1);
   await repo.updatePortalSubscription(token,choice(true,0));
  }
  assert.equal((await repo.portalNews(portal[0])).news.length,0);
  const {input}=await create(),r=await repo.createCampaign(ids[0],staff[0],input),id=r.campaign.id;
  assert.equal(r.campaign.total>=53,true);assert.equal((await repo.createCampaign(ids[0],staff[0],input)).created,false);
  await denied(repo.createCampaign(ids[0],staff[0],{...input,text:'Outro texto'}),409);
  assert.equal((await repo.campaignByRequest(ids[0],staff[0],input.clientKey)).id,id);
  checks.push('schema9-twenty-one-tables-admin-revalidated-immutable-audience-exact-creation-replay');
  await repo.updatePortalSubscription(portal[0],choice(false,1));await repo.updatePortalSubscription(portal[0],choice(true,2));
  await c.execute('UPDATE cl_portal_accounts SET active=0 WHERE id=?',[accounts[1]]);
  // Existing operational recipients, if present, must never be processed by this verifier.
  // Restrict the private queue to synthetic rows inside the outer rollback transaction.
  await c.execute('DELETE FROM cl_campaign_recipients WHERE campaign_id=? AND account_id NOT IN ('+accounts.map(()=>'?').join(',')+')',[id,...accounts]);
  const key=secret().slice(0,32),first=await repo.processCampaign(ids[0],staff[0],id,key);
  assert.equal(first.batch.delivered,48);assert.equal(first.batch.skipped,2);assert.equal(first.batch.remaining,3);
  const replay=await repo.processCampaign(ids[0],staff[0],id,key);assert.equal(replay.replayed,true);assert.equal(replay.batch.remaining,3);assert.equal(replay.campaign.counts.delivered,48);
  assert.equal((await repo.portalNews(portal[0])).news.some(n=>Number(n.id)===id),false);
  assert.equal((await repo.portalNews(portal[2])).news.some(n=>Number(n.id)===id),true);
  assert.equal(await repo.readPortalNews(portal[52],id),null);
  assert.deepEqual(await repo.readPortalNews(portal[2],id),{read:true});const readAt=(await repo.portalNews(portal[2])).news.find(n=>Number(n.id)===id).readAt;
  await repo.readPortalNews(portal[2],id);assert.deepEqual((await repo.portalNews(portal[2])).news.find(n=>Number(n.id)===id).readAt,readAt);
  checks.push('withdraw-resubscribe-and-inactive-account-skipped-batch-replay-does-not-advance-own-read-only');
  const cancelled=await repo.cancelCampaign(ids[0],staff[0],id);assert.equal(cancelled.counts.cancelled,3);assert.equal(cancelled.counts.delivered,48);
  await denied(repo.processCampaign(ids[0],staff[0],id,secret().slice(0,32)),409);
  assert.equal((await repo.processCampaign(ids[0],staff[0],id,key)).replayed,true);
  assert.equal((await repo.portalNews(portal[2])).news.some(n=>Number(n.id)===id),true);
  checks.push('cancel-removes-only-pending-deliveries-already-delivered-news-preserved');
  const next=(await create()).input;
  fault='queue';await assert.rejects(repo.createCampaign(ids[0],staff[0],next));assert.equal(await repo.campaignByRequest(ids[0],staff[0],next.clientKey),null);
  const second=await repo.createCampaign(ids[0],staff[0],next),nextId=second.campaign.id;
  await c.execute('DELETE FROM cl_campaign_recipients WHERE campaign_id=? AND account_id NOT IN ('+accounts.map(()=>'?').join(',')+')',[nextId,...accounts]);
  fault='batch';await assert.rejects(repo.processCampaign(ids[0],staff[0],nextId,secret().slice(0,32)));
  const after=await repo.findCampaign(ids[0],staff[0],nextId);assert.equal(after.counts.delivered,0);assert.equal(after.counts.pending,52);
  await repo.cancelCampaign(ids[0],staff[0],nextId);
  checks.push('queue-failure-and-delivery-audit-failure-rollback-no-partial-queue-or-news');
 }catch(e){failure=e;}finally{fault=null;await c.rollback();}
 if(baseline)assert.equal(await campaignsFingerprint(c),baseline);if(failure)throw failure;
 checks.push('all-synthetic-data-rolled-back-twenty-one-table-records-logical-schema-preserved');
 return{verifiedAt:new Date().toISOString(),checks,realCampaignsSent:false};
}
async function main(){loadEnvironment();const options=databaseOptions();if(!options)throw Error();const c=guardedConnection(await mysql.createConnection({...options,connectTimeout:5000}));try{console.log('Campanhas SQL verificadas em transacao revertida: '+JSON.stringify(await verifyCampaigns(c)));}finally{await c.end();}}
if(require.main===module)main().catch(()=>{console.error('Verificacao SQL de campanhas falhou. Nenhum segredo exibido.');process.exitCode=1;});
module.exports={verifyCampaigns,campaignsFingerprint,definitions};
