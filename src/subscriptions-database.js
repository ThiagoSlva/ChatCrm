'use strict';
const {digest}=require('./security');
const {portalIdentity}=require('./portal-database');
const NOTICE_VERSION='portal-news-v1';
const NOTICE='Quero receber novidades desta empresa na caixa de novidades do meu portal. Posso cancelar a inscrição aqui a qualquer momento. Isso não muda meus atendimentos.';
const fail=code=>{throw Object.assign(Error(),{statusCode:code});};
const dto=row=>({subscribed:row?Number(row.subscribed)===1:false,version:row?Number(row.version):0,noticeVersion:NOTICE_VERSION,updatedAt:row?row.created_at:null});
function subscriptionRepository({transaction,capabilities}){
 async function coordinated(token,work){return transaction(async c=>{
  await c.execute('SELECT id FROM cl_schema WHERE id = 1 FOR UPDATE');
  if((await capabilities(c)).subscriptions!==true)fail(503);
  const identity=await portalIdentity(c,token);return work(c,identity.accountId);
 });}
 const latest=async(c,id)=>(await c.execute('SELECT version,subscribed,created_at FROM cl_portal_subscription_events WHERE account_id = ? ORDER BY version DESC LIMIT 1 FOR UPDATE',[id]))[0][0]||null;
 return {
  async portalSubscription(token){return coordinated(token,async(c,id)=>({preference:dto(await latest(c,id)),notice:NOTICE}));},
  async updatePortalSubscription(token,input){
   if(!input||typeof input!=='object'||Array.isArray(input)||![Object.prototype,null].includes(Object.getPrototypeOf(input))||Object.keys(input).sort().join(',')!=='clientKey,noticeVersion,subscribed,version'||typeof input.subscribed!=='boolean'||!Number.isInteger(input.version)||input.version<0||input.version>4294967295||input.noticeVersion!==NOTICE_VERSION||typeof input.clientKey!=='string'||!/^[a-f0-9]{32}$/.test(input.clientKey))fail(400);
   const requestHash=digest(JSON.stringify([input.version,input.subscribed,NOTICE_VERSION]));
   return coordinated(token,async(c,id)=>{
    const [replays]=await c.execute('SELECT request_hash FROM cl_portal_subscription_events WHERE account_id = ? AND client_key = ? FOR UPDATE',[id,input.clientKey]);
    const before=await latest(c,id),current=dto(before);
    if(replays.length){if(replays[0].request_hash!==requestHash)fail(409);return {preference:current,replayed:true,changed:false};}
    if(input.version!==current.version)fail(409);
    if(input.subscribed===current.subscribed)return {preference:current,replayed:false,changed:false};
    if(current.version>=4294967295)fail(409);
    // Bound daily choice changes without ever blocking withdrawal. No operator can opt in a client.
    const [counts]=await c.execute('SELECT COUNT(*) AS total FROM cl_portal_subscription_events WHERE account_id = ? AND created_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 1 DAY)',[id]);
    if(input.subscribed&&Number(counts[0].total)>=100)fail(429);
    await c.execute('INSERT INTO cl_portal_subscription_events (account_id,version,subscribed,notice_version,client_key,request_hash,created_at) VALUES (?,?,?,?,?,?,UTC_TIMESTAMP())',[id,current.version+1,input.subscribed?1:0,NOTICE_VERSION,input.clientKey,requestHash]);
    return {preference:dto(await latest(c,id)),replayed:false,changed:true};
   });
  }
 };
}
module.exports={subscriptionRepository,NOTICE_VERSION,NOTICE};
