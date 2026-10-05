'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {NOTICE_VERSION}=require('../src/subscriptions-database');
const {digest,secret}=require('../src/security');
const {buildServer}=require('../src/server');
const {fixture}=require('./helpers/campaigns-fixture');
const denied=(p,code)=>assert.rejects(p,e=>e.statusCode===code);

test('campaign preview has no identities; account versions freeze audience; stale or empty audiences are rejected',async()=>{
 const f=fixture();let p=await f.repo.previewCampaign(1,f.staff[0],{title:'  Nova oferta  ',text:'Mensagem'});assert.equal(p.recipientCount,0);assert.equal(p.title,'Nova oferta');assert.deepEqual(Object.keys(p).sort(),['audienceHash','noticeVersion','recipientCount','text','title']);
 const body={title:p.title,text:p.text,audienceHash:p.audienceHash,clientKey:secret().slice(0,32)};await denied(f.repo.createCampaign(1,f.staff[0],body),409);
 f.choice(1,true);p=await f.repo.previewCampaign(1,f.staff[0],{title:'Oferta',text:'Mensagem'});f.choice(1,false);f.choice(1,true);
 await denied(f.repo.createCampaign(1,f.staff[0],{...body,title:p.title,audienceHash:p.audienceHash}),409);assert.equal(f.state().campaigns.length,0);
 f.accounts.get(2).subscribed=1;f.accounts.get(2).version=1;f.accounts.get(2).noticeVersion='obsolete';assert.equal((await f.repo.previewCampaign(1,f.staff[0],{title:'Oferta',text:'Mensagem'})).recipientCount,1);
});

test('creation replays exact key without duplicate queues; changed body conflicts; insert failure rolls back whole queue',async()=>{
 const f=fixture();f.choice(1,true);f.choice(2,true);const p=await f.repo.previewCampaign(1,f.staff[0],{title:'Oferta',text:'Mensagem'}),body={title:p.title,text:p.text,audienceHash:p.audienceHash,clientKey:secret().slice(0,32)};
 const results=await Promise.all([f.repo.createCampaign(1,f.staff[0],body),f.repo.createCampaign(1,f.staff[0],body)]);assert.deepEqual(results.map(r=>r.created).sort(),[false,true]);assert.equal(f.state().campaigns.length,1);assert.equal(f.state().recipients.length,2);
 await denied(f.repo.createCampaign(1,f.staff[0],{...body,text:'Outra mensagem'}),409);
 f.fault('queue');await assert.rejects(f.create('Falha controlada'));assert.equal(f.state().campaigns.length,1);assert.equal(f.state().recipients.length,2);
 assert.equal((await f.repo.campaignByRequest(1,f.staff[0],body.clientKey)).id,results[0].campaign.id);assert.equal(await f.repo.campaignByRequest(1,f.staff[0],secret().slice(0,32)),null);
});

test('withdrawal and re-subscription cannot reactivate old pending campaign; deactivated accounts and changed notice skip',async()=>{
 const f=fixture(5);for(let i=1;i<=5;i++)f.choice(i,true);const {campaign}=await f.create();
 f.choice(1,false);f.choice(2,false);f.choice(2,true);f.accounts.get(3).active=0;f.accounts.get(4).noticeVersion='obsolete';
 const r=await f.repo.processCampaign(1,f.staff[0],campaign.id,secret().slice(0,32));assert.equal(r.batch.delivered,1);assert.equal(r.batch.skipped,4);assert.equal(r.campaign.counts.pending,0);
 for(let i=1;i<=2;i++)assert.equal((await f.repo.portalNews(f.portal[i-1])).news.length,0);assert.equal((await f.repo.portalNews(f.portal[4])).news.length,1);
 assert(!f.traces.some(sql=>sql.includes('cl_chat_messages')||sql.includes('cl_contacts')));
});

test('batch replay does not advance another 50 recipients; failed delivery or batch audit rolls back; distinct batches drain queue once',async()=>{
 const f=fixture(63);for(let i=1;i<=63;i++)f.choice(i,true);const {campaign}=await f.create(),key=secret().slice(0,32);
 for(const fault of ['delivery','batch']){f.fault(fault);await assert.rejects(f.repo.processCampaign(1,f.staff[0],campaign.id,key));assert.equal(f.state().recipients.filter(r=>r.state==='delivered').length,0);assert.equal(f.state().batches.length,0);}
 f.fault(null);const first=await f.repo.processCampaign(1,f.staff[0],campaign.id,key);assert.equal(first.batch.delivered,50);assert.equal(first.batch.remaining,13);
 const replay=await f.repo.processCampaign(1,f.staff[0],campaign.id,key);assert.equal(replay.replayed,true);assert.equal(replay.batch.remaining,13);assert.equal(f.state().recipients.filter(r=>r.state==='delivered').length,50);
 const last=await f.repo.processCampaign(1,f.staff[0],campaign.id,secret().slice(0,32));assert.equal(last.batch.delivered,13);assert.equal(last.batch.remaining,0);assert.equal(f.state().batches.length,2);
});

test('cancel preserves delivered news; only own delivered messages can be read idempotently; unsubscribed history remains',async()=>{
 const f=fixture(53);for(let i=1;i<=53;i++)f.choice(i,true);const {campaign}=await f.create();const key=secret().slice(0,32);await f.repo.processCampaign(1,f.staff[0],campaign.id,key);
 const cancelled=await f.repo.cancelCampaign(1,f.staff[0],campaign.id);assert.equal(cancelled.counts.cancelled,3);assert.equal(cancelled.counts.delivered,50);
 assert.equal((await f.repo.processCampaign(1,f.staff[0],campaign.id,key)).replayed,true);await denied(f.repo.processCampaign(1,f.staff[0],campaign.id,secret().slice(0,32)),409);
 assert.equal(await f.repo.readPortalNews(f.portal[52],campaign.id),null);assert.deepEqual(await f.repo.readPortalNews(f.portal[0],campaign.id),{read:true});
 const before=f.state().recipients[0].readAt;await f.repo.readPortalNews(f.portal[0],campaign.id);assert.equal(f.state().recipients[0].readAt,before);
 f.choice(1,false);assert.equal((await f.repo.portalNews(f.portal[0])).news.length,1);assert.equal((await f.repo.portalNews(f.portal[52])).news.length,0);
});

test('repository revalidates administrator session inside schema lock, strict values, quota and prepared schema',async()=>{
 const f=fixture();f.choice(1,true);
 await denied(f.repo.previewCampaign(2,f.staff[1],{title:'Oferta',text:'Mensagem'}),403);
 f.adminActive(false);await denied(f.create(),403);f.adminActive(true);f.revoked(true);await denied(f.create(),401);f.revoked(false);
 f.enabled(false);await denied(f.create(),503);f.enabled(true);f.maxCount(500);await denied(f.create(),429);f.maxCount(0);
 for(const input of [{title:'Oferta',text:'Mensagem',extra:true},{title:123,text:'Mensagem'},{title:'Oferta',text:{toString:()=>''}},{title:'Oferta',text:'\u0000'}])await denied(Promise.resolve().then(()=>f.repo.previewCampaign(1,f.staff[0],input)),400);
 await denied(Promise.resolve().then(()=>f.repo.portalNews(f.portal[0],0,20)),400);
 assert(f.traces.indexOf('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE')<f.traces.findIndex(s=>s.startsWith('SELECT u.role')));
});

test('real Fastify routes deny anonymous, operator, foreign origin, CSRF and injected recipient; only portal cookie reads own news',async()=>{
 const f=fixture();f.choice(1,true);const staff=f.staff[0],portal=f.portal[0],staffHeaders={cookie:'__Host-cl_session='+staff,origin:'https://test.local','x-csrf-token':digest('csrf:'+staff)},portalHeaders={cookie:'__Host-cl_portal='+portal,origin:'https://test.local','x-csrf-token':digest('portal-csrf:'+portal)};
 const repo={...f.repo,close:async()=>{},capabilities:async()=>({portal:true,campaigns:true}),session:async t=>t===staff?{id:1,name:'Synthetic',role:'admin'}:t===f.staff[1]?{id:2,role:'operator'}:null,portalSession:async t=>f.portal.includes(t)?{accessId:'a'.repeat(24),name:'Synthetic'}:null};
 const app=buildServer({repository:repo,env:{NODE_ENV:'production',APP_URL:'https://test.local'}});
 try{
  const preview={method:'POST',url:'/api/campaigns/preview',payload:{title:'Oferta',text:'Mensagem'}};
  assert.equal((await app.inject(preview)).statusCode,403);
  assert.equal((await app.inject({...preview,headers:{...staffHeaders,cookie:'__Host-cl_session='+f.staff[1],'x-csrf-token':digest('csrf:'+f.staff[1])}})).statusCode,403);
  assert.equal((await app.inject({...preview,headers:{...staffHeaders,origin:'https://other.local'}})).statusCode,403);
  assert.equal((await app.inject({...preview,headers:{...staffHeaders,'x-csrf-token':'invalid'}})).statusCode,403);
  const p=await app.inject({...preview,headers:staffHeaders});assert.equal(p.statusCode,200);
  const body={title:'Oferta',text:'Mensagem',audienceHash:p.json().audienceHash,clientKey:secret().slice(0,32)};
  assert.equal((await app.inject({method:'POST',url:'/api/campaigns',headers:staffHeaders,payload:{...body,accountId:1}})).statusCode,400);
  const created=await app.inject({method:'POST',url:'/api/campaigns',headers:staffHeaders,payload:body});assert.equal(created.statusCode,201);const id=created.json().campaign.id;
  assert.equal((await app.inject({method:'POST',url:'/api/campaigns/'+id+'/process',headers:staffHeaders,payload:{clientKey:secret().slice(0,32)}})).statusCode,200);
  assert.equal((await app.inject({url:'/api/portal/news',headers:staffHeaders})).statusCode,401);
  const own=await app.inject({url:'/api/portal/news',headers:portalHeaders});assert.equal(own.statusCode,200);assert.equal(own.json().news.length,1);
  assert.equal((await app.inject({method:'POST',url:'/api/portal/news/'+id+'/read',headers:portalHeaders,payload:{}})).statusCode,200);
 }finally{await app.close();}
});
