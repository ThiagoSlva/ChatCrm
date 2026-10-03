'use strict';
const {NOTICE_VERSION}=require('./subscriptions-database');
function registerSubscriptions(app,repository,authorize){
 const empty={type:'object',additionalProperties:false,properties:{}};
 const properties={subscribed:{type:'boolean'},version:{type:'integer',minimum:0,maximum:4294967295},noticeVersion:{type:'string',enum:[NOTICE_VERSION]},clientKey:{type:'string',pattern:'^[a-f0-9]{32}$'}};
 async function ready(reply){if(!repository?.capabilities||(await repository.capabilities()).subscriptions!==true){reply.code(503).send({error:'As preferencias de novidades aguardam preparacao.'});return false;}return true;}
 app.get('/api/portal/subscription',{schema:{querystring:empty}},async(req,reply)=>{if(!await ready(reply))return;const session=await authorize(req,reply);if(session)return repository.portalSubscription(session.token);});
 app.post('/api/portal/subscription',{preValidation:async(req,reply)=>{
  const b=req.body;if(!b||typeof b!=='object'||Array.isArray(b)||typeof b.subscribed!=='boolean'||typeof b.version!=='number'||typeof b.noticeVersion!=='string'||typeof b.clientKey!=='string')return reply.code(400).send({error:'Dados invalidos.'});
 },schema:{querystring:empty,body:{type:'object',additionalProperties:false,properties,required:Object.keys(properties)}}},async(req,reply)=>{if(!await ready(reply))return;const session=await authorize(req,reply,true);if(session)return repository.updatePortalSubscription(session.token,req.body);});
}
module.exports={registerSubscriptions};
