'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const {digest,secret}=require('../src/security');
const {definitions}=require('../scripts/database-backup');
const {httpsClient,verifyFlow}=require('../scripts/campaigns-https-flow');
const verifier=require('../scripts/verify-campaigns-https');
const {fixture}=require('./helpers/campaigns-fixture');
const {buildServer}=require('../src/server');
const clone=value=>structuredClone(value), date='2026-10-05 17:00:00',hash='a'.repeat(64),passwordHash='scrypt-v1$'+'a'.repeat(32)+'$'+'b'.repeat(128);
function ownership() {
 const original=Object.fromEntries(definitions.map(d=>[d.name,[]]));
 original.cl_schema=[[1,9]];original.cl_company=[[1,'Test company']];original.cl_users=[[1,'Original','admin@example.test',passwordHash,'admin',1,date]];
 original.cl_chat_limits=[[hash,1,3,2]];
 const snapshot={sha256:hash,payload:{tables:definitions.map(d=>({name:d.name,rows:clone(original[d.name])}))}};
 const suffix='c'.repeat(32),seed={cl_users:[[2,'Operador HTTPS '+suffix,'https-'+suffix+'@example.test',passwordHash,'operator',1,date]],
  cl_sessions:[['d'.repeat(64),1,date],['e'.repeat(64),2,date]],cl_visitors:[],cl_portal_accounts:[],cl_portal_sessions:[]};
 for(let i=0;i<53;i++) {const id=i+1;seed.cl_visitors.push([id,'Cliente HTTPS '+i+' '+suffix,secret(),date,date]);
  seed.cl_portal_accounts.push([id,id,secret().slice(0,24),passwordHash,secret(),1,1,date]);seed.cl_portal_sessions.push([secret(),id,date]);}
 const r={kind:'campaigns-https-v1',schemaVersion:9,suffix,commit:'f'.repeat(40),origin:'https://test.local',backupChecksum:hash,adminId:1,
  originalHashes:verifier.hashes(original),baseline:'1'.repeat(64),seed,intents:[]};
 const current=clone(original);for(const [name,data] of Object.entries(seed))current[name].push(...clone(data));
 return {original,snapshot,r,current};
}
function connection(data,original,{fault}={}) {
 const traces=[];let saved,active=false,fail=fault;
 const c={query:async sql=>{traces.push(sql);
  if(sql==='START TRANSACTION') {saved=clone(data);active=true;return [[]];}
  if(sql==='ROLLBACK') {if(active) {for(const name of Object.keys(data))data[name]=clone(saved[name]);}active=false;return [[]];}
  if(sql==='COMMIT') {active=false;if(fail==='commit'){fail=null;throw Error('Lost acknowledgement');}return [[]];}
  const match=/FROM `(\w+)`.*LIMIT 200 OFFSET (\d+)/.exec(sql);assert(match);
  const d=definitions.find(d=>d.name===match[1]);return [data[d.name].slice(Number(match[2]),Number(match[2])+200).map(row=>Object.fromEntries(d.columns.map((column,i)=>[column,row[i]])))];
 },execute:async(sql,args)=>{traces.push(sql);if(sql==='SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE')return [[{id:1}]];
  const match=/^DELETE FROM `(\w+)` WHERE `(\w+)` IN/.exec(sql);assert(match);
  const d=definitions.find(d=>d.name===match[1]),column=d.columns.indexOf(match[2]);const before=data[d.name].length;
  data[d.name]=data[d.name].filter(row=>!args.includes(row[column]));if(fail===d.name)throw Error('Deletion fault');return [{affectedRows:before-data[d.name].length}];
 }};
 const fingerprint=async()=>JSON.stringify(verifier.hashes(data))===JSON.stringify(verifier.hashes(original))?'1'.repeat(64):'2'.repeat(64);
 return {c,traces,fingerprint};
}

test('HTTPS campaign scenario exercises actual routes and campaign repository with 53 synthetic portal sessions',async()=>{
 const f=fixture(53);let revoked=false;const origin='https://test.local',intents=[];
 const portalAccount=t=>[...f.accounts.values()].find(a=>a.token===t&&a.active);
 const repo={...f.repo,close:async()=>{},capabilities:async()=>({portal:true,campaigns:true,subscriptions:true}),
  session:async t=>t===f.staff[0]&&!revoked?{id:1,name:'Test',role:'admin'}:t===f.staff[1]?{id:2,role:'operator'}:null,
  portalSession:async t=>portalAccount(t)?{accessId:'a'.repeat(24),name:'Test'}:null,
  revoke:async()=>{revoked=true;f.revoked(true);},
  portalSubscription:async t=>{const a=portalAccount(t);return {preference:{subscribed:!!a.subscribed,version:a.version,noticeVersion:a.noticeVersion}};},
  updatePortalSubscription:async(t,input)=>{const a=portalAccount(t);assert.equal(a.version,input.version);f.choice(a.id,input.subscribed);return {preference:{subscribed:!!a.subscribed,version:a.version}};}
 };
 const app=buildServer({repository:repo,env:{NODE_ENV:'production',APP_URL:origin}});
 const transport=async(url,options)=>{assert.equal(options.redirect,'error');const response=await app.inject({method:options.method,url:new URL(url).pathname,headers:options.headers,payload:options.body});return new Response(response.body,{status:response.statusCode});};
 try {
  const checks=await verifyFlow({request:httpsClient(origin,transport),staff:f.staff,portal:f.portal,suffix:'a'.repeat(32),record:async intent=>intents.push(intent),
   ownQueue:async id=>assert(f.state().recipients.filter(r=>r.campaignId===id).every(r=>f.accounts.has(r.accountId))),disableAccount:async i=>{f.accounts.get(i+1).active=0;}});
  assert.equal(checks.length,3);assert.equal(intents.filter(i=>i.kind==='campaign').length,2);assert.equal(intents.filter(i=>i.kind==='choice').length,56);
  assert.equal(f.state().recipients.filter(r=>r.state==='delivered').length,48);assert.equal(f.state().batches.length,1);assert(revoked);
 } finally {await app.close();}
});

test('HTTPS client rejects other origins, credentials, insecure URLs, redirects and oversized streamed JSON',async()=>{
 for(const origin of ['http://test.local','https://user:pass@test.local','https://test.local/path'])assert.throws(()=>httpsClient(origin));
 let invoked=0;const request=httpsClient('https://test.local',async()=>{invoked++;return new Response('x'.repeat(32769));});
 await assert.rejects(request('https://foreign.test/api/test'));assert.equal(invoked,0);
 await assert.rejects(request('/api/test',{method:'DELETE'}));assert.equal(invoked,0);
 await assert.rejects(request('/api/test'));assert.equal(invoked,1);
 const redirects=httpsClient('https://test.local',async(_,o)=>{assert.equal(o.redirect,'error');throw Error('redirect rejected');});await assert.rejects(redirects('/api/test'));
});

test('ownership validates complete source, compiled fixtures and private intent before any cleanup',()=>{
 const f=ownership();verifier.validateOwned(f.r,f.current,f.snapshot);
 const attacks=[data=>data.cl_users[0][3]='changed',data=>data.cl_chat_limits[0][2]++,data=>data.cl_contacts.push([1]),
  data=>data.cl_portal_sessions.push([secret(),999,date]),data=>data.cl_visitors[0][1]='foreign',data=>data.cl_portal_accounts[0][6]=0,
  data=>data.cl_campaign_recipients.push([1,999,1,'pending',null,null]),data=>data.cl_sessions.push([secret(),1,date])];
 for(const attack of attacks){const data=clone(f.current);attack(data);assert.throws(()=>verifier.validateOwned(f.r,data,f.snapshot));}
 const altered=clone(f.r);altered.seed.cl_users[0][4]='admin';assert.throws(()=>verifier.validateRegistry(altered,f.snapshot));
});

test('unknown rows refuse before DELETE; failed cleanup rolls back; lost COMMIT can be diagnosed without replay',async()=>{
 const f=ownership();const unknown=clone(f.current);unknown.cl_company[0][1]='external edit';const bad=connection(unknown,f.original);
 await assert.rejects(verifier.cleanup(bad.c,f.r,f.snapshot,bad.fingerprint));assert(!bad.traces.some(s=>s.startsWith('DELETE')));
 const failed=connection(f.current,f.original,{fault:'cl_portal_accounts'});const before=clone(f.current);
 await assert.rejects(verifier.cleanup(failed.c,f.r,f.snapshot,failed.fingerprint));assert.deepEqual(f.current,before);
 const lost=connection(f.current,f.original,{fault:'commit'});await assert.rejects(verifier.cleanup(lost.c,f.r,f.snapshot,lost.fingerprint));assert.deepEqual(f.current,f.original);
 const repeated=await verifier.cleanup(lost.c,f.r,f.snapshot,lost.fingerprint);assert.equal(repeated.alreadyClean,true);
 assert(!lost.traces.some(sql=>/\b(DROP|TRUNCATE|ALTER|AUTO_INCREMENT)\b/.test(sql)));assert(!lost.traces.some(sql=>/^DELETE FROM `cl_chat_limits`/.test(sql)));
});

test('exact campaign intentions permit own queue and reject unrecorded keys, altered bodies and foreign recipients',()=>{
 const f=ownership();const audience=f.r.seed.cl_portal_accounts.map(a=>({accountId:a[0],consentVersion:1}));
 const body={title:'Ensaio HTTPS '+f.r.suffix,text:'Somente dados ficticios. Texto literal <b>teste</b>.',clientKey:'3'.repeat(32),audienceHash:digest(JSON.stringify(['portal-news-v1',audience]))};
 f.r.intents.push({kind:'campaign',body,audience});
 f.current.cl_campaigns.push([1,body.title,body.text,1,body.clientKey,digest(JSON.stringify([body.title,body.text,body.audienceHash])),body.audienceHash,'portal-news-v1','queued',date]);
 f.current.cl_campaign_recipients=audience.map(a=>[1,a.accountId,1,'pending',null,null]);verifier.validateOwned(f.r,f.current,f.snapshot);
 for(const attack of [d=>d.cl_campaigns[0][2]='external',d=>d.cl_campaigns[0][4]='4'.repeat(32),d=>d.cl_campaign_recipients[0][1]=999,d=>d.cl_campaign_recipients.pop()]) {
  const data=clone(f.current);attack(data);assert.throws(()=>verifier.validateOwned(f.r,data,f.snapshot));
 }
});

test('manual CLI requires complete explicit opt-in; help remains offline; journal is exclusive and private',()=>{
 const args=['--origin=https://test.local','--backup='+path.join(os.tmpdir(),'backup.json'),'--journal='+path.join(os.tmpdir(),'journal.json'),'--commit='+'a'.repeat(40),'--allow-temporary-fixtures'];
 assert(verifier.parseArguments(args));for(const extra of ['--force','--commit='+'b'.repeat(40),'--cleanup-only','--allow-temporary-fixtures']){
  if(extra==='--cleanup-only')assert(verifier.parseArguments([...args,extra]));else assert.equal(verifier.parseArguments([...args,extra]),null);
 }
 assert.equal(verifier.parseArguments(args.slice(0,-1)),null);
 const result=spawnSync(process.execPath,['scripts/verify-campaigns-https.js','--help'],{encoding:'utf8',env:{PATH:process.env.PATH}});assert.equal(result.status,0);assert.match(result.stdout,/allow-temporary-fixtures/);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chatcrm-campaigns-https-test-'));if(process.platform!=='win32')fs.chmodSync(dir,0o700);
 try {const file=path.join(dir,'journal.json'),r=ownership().r;verifier.writeJournal(file,r,true);assert.deepEqual(verifier.readJournal(file),r);
  assert.throws(()=>verifier.writeJournal(file,r,true));r.stage='cleaned';verifier.writeJournal(file,r);assert.equal(verifier.readJournal(file).stage,'cleaned');
  fs.writeFileSync(file+'.next','interrupted',{flag:'wx',mode:0o600});assert.throws(()=>verifier.writeJournal(file,r));assert.equal(fs.readFileSync(file+'.next','utf8'),'interrupted');
 }finally {const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved),fs.realpathSync(os.tmpdir()));assert.match(path.basename(resolved),/^chatcrm-campaigns-https-test-/);fs.rmSync(resolved,{recursive:true});}
});

test('inspection stops at the global row and byte ceilings before any mutation',async()=>{
 for(const largeText of [false,true]) {
  let calls=0;
  const c={query:async sql=>{calls++;const match=/FROM `(\w+)`/.exec(sql),d=definitions.find(d=>d.name===match[1]);
   if(d.name!=='cl_chat_messages')return [[]];
   return [Array.from({length:200},()=>Object.fromEntries(d.columns.map(column=>[column,column==='text'&&largeText?'x'.repeat(4000):1])))];
  }};
  await assert.rejects(verifier.rows(c));assert(calls<(largeText?40:140));
 }
});
