'use strict';
const {campaignRepository}=require('../../src/campaigns-database');
const {NOTICE_VERSION}=require('../../src/subscriptions-database');
const {digest,secret}=require('../../src/security');
function fixture(n=3){
 const staff=[secret(),secret()],portal=Array.from({length:n},()=>secret()),accounts=new Map(portal.map((token,i)=>[i+1,{id:i+1,token,active:1,version:0,subscribed:0,noticeVersion:NOTICE_VERSION}]));
 let state={campaigns:[],recipients:[],batches:[],id:1},serial=Promise.resolve(),enabled=true,adminActive=true,fault=null,maxCount=0,revoked=false;
 const traces=[],date='2026-10-05T14:00:00.000Z';
 const connection={async execute(sql,args=[]){
  traces.push(sql);
  const rows=r=>[structuredClone(r)];
  if(sql==='SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE')return rows([{id:1}]);
  if(sql.startsWith('SELECT u.role, u.active FROM cl_sessions')){const i=staff.findIndex(t=>digest(t)===args[0]);return rows(i<0||args[1]!==i+1||revoked?[]:[{role:i?'operator':'admin',active:adminActive?1:0}]);}
  if(sql.startsWith('SELECT a.id AS accountId, a.visitor_id')){const a=[...accounts.values()].find(a=>digest(a.token)===args[0]&&a.active);return rows(a?[{accountId:a.id,visitorId:a.id+100,accessId:'a'.repeat(24),name:'Synthetic'}]:[]);}
  if(sql.startsWith('SELECT a.id AS accountId, s.version'))return rows([...accounts.values()].filter(a=>a.active&&a.subscribed===1&&a.noticeVersion===args[0]).sort((a,b)=>a.id-b.id).map(a=>({accountId:a.id,consentVersion:a.version})));
  if(sql.startsWith('SELECT id, request_hash'))return rows(state.campaigns.filter(c=>c.actorId===args[0]&&c.key===args[1]).map(c=>({id:c.id,requestHash:c.hash})));
  if(sql.startsWith('SELECT id, title, text'))return rows(state.campaigns.filter(c=>c.id===args[0]));
  if(sql.startsWith('SELECT state, COUNT')){const counts={};for(const r of state.recipients.filter(r=>r.campaignId===args[0]))counts[r.state]=(counts[r.state]||0)+1;return rows(Object.entries(counts).map(([state,total])=>({state,total})));}
  if(sql==='SELECT COUNT(*) AS total FROM cl_campaigns')return rows([{total:maxCount||state.campaigns.length}]);
  if(sql.startsWith('SELECT COUNT')&&sql.includes("account_id = ?"))return rows([{total:state.recipients.filter(r=>r.accountId===args[0]&&r.state==='delivered').length}]);
  if(sql.startsWith('SELECT COUNT')&&sql.includes('cl_campaign_recipients'))return rows([{total:state.recipients.filter(r=>r.campaignId===args[0]&&r.state==='pending').length}]);
  if(sql.startsWith('INSERT INTO cl_campaigns ')){const id=state.id++;state.campaigns.push({id,title:args[0],text:args[1],actorId:args[2],key:args[3],hash:args[4],audience:args[5],noticeVersion:args[6],state:'queued',createdAt:date});return[{insertId:id}];}
  if(sql.startsWith('INSERT INTO cl_campaign_recipients ')){for(let i=0;i<args.length;i+=3)state.recipients.push({campaignId:args[i],accountId:args[i+1],consentVersion:args[i+2],state:'pending',deliveredAt:null,readAt:null});if(fault==='queue')throw Error('Controlled queue insertion failure');return[{affectedRows:args.length/3}];}
  if(sql.startsWith('SELECT delivered, skipped'))return rows(state.batches.filter(b=>b.campaignId===args[0]&&b.key===args[1]).map(({delivered,skipped,remaining,createdAt})=>({delivered,skipped,remaining,createdAt})));
  if(sql.startsWith('SELECT account_id AS accountId'))return rows(state.recipients.filter(r=>r.campaignId===args[0]&&r.state==='pending').sort((a,b)=>a.accountId-b.accountId).slice(0,50).map(r=>({accountId:r.accountId,consentVersion:r.consentVersion})));
  if(sql.startsWith('SELECT s.version, s.subscribed')){const a=accounts.get(args[0]);return rows(a&&a.version?[a]:[]);}
  if(sql.startsWith('UPDATE cl_campaign_recipients SET state = ?')){const r=state.recipients.find(r=>r.campaignId===args[1]&&r.accountId===args[2]&&r.state==='pending');if(r){r.state=args[0];r.deliveredAt=sql.includes('UTC_TIMESTAMP()')?date:null;}if(fault==='delivery')throw Error('Controlled delivery failure');return[{affectedRows:r?1:0}];}
  if(sql.startsWith('INSERT INTO cl_campaign_batches ')){state.batches.push({campaignId:args[0],key:args[1],delivered:args[2],skipped:args[3],remaining:args[4],createdAt:date});if(fault==='batch')throw Error('Controlled batch failure');return[{affectedRows:1}];}
  if(sql.startsWith('UPDATE cl_campaigns SET')){state.campaigns.find(c=>c.id===args[0]).state='cancelled';return[{affectedRows:1}];}
  if(sql.startsWith("UPDATE cl_campaign_recipients SET state = 'cancelled'")){for(const r of state.recipients.filter(r=>r.campaignId===args[0]&&r.state==='pending'))r.state='cancelled';return[{affectedRows:1}];}
  if(sql.startsWith('SELECT c.id, c.title')){const offset=Number(sql.match(/OFFSET (\d+)/)[1]),limit=Number(sql.match(/LIMIT (\d+)/)[1]);return rows(state.recipients.filter(r=>r.accountId===args[0]&&r.state==='delivered').sort((a,b)=>b.campaignId-a.campaignId).slice(offset,offset+limit).map(r=>{const c=state.campaigns.find(c=>c.id===r.campaignId);return{id:c.id,title:c.title,text:c.text,deliveredAt:r.deliveredAt,readAt:r.readAt};}));}
  if(sql.startsWith('SELECT campaign_id FROM'))return rows(state.recipients.filter(r=>r.campaignId===args[0]&&r.accountId===args[1]&&r.state==='delivered').map(r=>({campaign_id:r.campaignId})));
  if(sql.startsWith('UPDATE cl_campaign_recipients SET read_at')){const r=state.recipients.find(r=>r.campaignId===args[0]&&r.accountId===args[1]);r.readAt=r.readAt||date;return[{affectedRows:1}];}
  if(sql.startsWith('SELECT id, title, state'))return rows(state.campaigns.slice().reverse().slice(0,20));
  throw Error('Unexpected SQL: '+sql);
 }};
 const transaction=work=>{const run=serial.then(async()=>{const before=structuredClone(state);try{return await work(connection);}catch(e){state=before;throw e;}});serial=run.catch(()=>{});return run;};
 const repo=campaignRepository({transaction,capabilities:async()=>({campaigns:enabled})});
 const choice=(id,subscribed)=>{const a=accounts.get(id);a.version++;a.subscribed=subscribed?1:0;};
 const create=async(title='Novidade sintética')=>{const p=await repo.previewCampaign(1,staff[0],{title,text:'Texto somente de teste'});return repo.createCampaign(1,staff[0],{title:p.title,text:p.text,audienceHash:p.audienceHash,clientKey:secret().slice(0,32)});};
 return{repo,staff,portal,accounts,traces,choice,create,state:()=>state,fault:x=>{fault=x;},enabled:x=>{enabled=x;},adminActive:x=>{adminActive=x;},revoked:x=>{revoked=x;},maxCount:x=>{maxCount=x;}};
}
module.exports={fixture};
