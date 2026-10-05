'use strict';

function registerCampaigns(app,repository,auth,portalAuthorize){
  const object=properties=>({type:'object',additionalProperties:false,properties,required:Object.keys(properties)});
  const empty=object({}),id={type:'integer',minimum:1,maximum:4294967295},key={type:'string',pattern:'^[a-f0-9]{32}$'};
  const fields={title:{type:'string',minLength:2,maxLength:120},text:{type:'string',minLength:1,maxLength:4000}};
  const pagination={type:'object',additionalProperties:false,properties:{page:{type:'integer',minimum:1,maximum:10000,default:1},limit:{type:'integer',minimum:1,maximum:50,default:20}}};
  const strict=props=>async(req,reply)=>{if(!req.body||typeof req.body!=='object'||Array.isArray(req.body)||Object.keys(props).some(k=>Object.hasOwn(req.body,k)&&typeof req.body[k]!=='string'))reply.code(400).send({error:'Dados invalidos.'});};
  const body=props=>({preValidation:strict(props),schema:{body:object(props),querystring:empty}});
  const missing=reply=>reply.code(404).send({error:'Campanha ou novidade nao disponivel.'});
  async function ready(reply){if(!repository?.capabilities||(await repository.capabilities()).campaigns!==true){reply.code(503).send({error:'Novidades aguardam preparacao da instalacao.'});return false;}return true;}
  async function team(req,reply,write=false){const user=await auth.authorize(req,reply,{write});if(!user)return null;if(user.role!=='admin'){reply.code(403).send({error:'Somente administradores gerenciam campanhas.'});return null;}if(!await ready(reply))return null;return{user,token:auth.readToken(req)};}
  async function portal(req,reply,write=false){const user=await portalAuthorize(req,reply,write);if(!user||!await ready(reply))return null;return user;}
  app.post('/api/campaigns/preview',body(fields),async(req,reply)=>{const s=await team(req,reply,true);if(s)return repository.previewCampaign(s.user.id,s.token,req.body);});
  app.post('/api/campaigns',body({...fields,audienceHash:{type:'string',pattern:'^[a-f0-9]{64}$'},clientKey:key}),async(req,reply)=>{const s=await team(req,reply,true);if(!s)return;const r=await repository.createCampaign(s.user.id,s.token,req.body);return reply.code(r.created?201:200).send(r);});
  app.get('/api/campaigns',{schema:{querystring:pagination}},async(req,reply)=>{const s=await team(req,reply);if(s)return repository.listCampaigns(s.user.id,s.token,req.query.page,req.query.limit);});
  app.get('/api/campaigns/request/:key',{schema:{params:object({key}),querystring:empty}},async(req,reply)=>{const s=await team(req,reply);if(!s)return;const campaign=await repository.campaignByRequest(s.user.id,s.token,req.params.key);return campaign?{campaign}:missing(reply);});
  app.get('/api/campaigns/:id',{schema:{params:object({id}),querystring:empty}},async(req,reply)=>{const s=await team(req,reply);if(!s)return;const campaign=await repository.findCampaign(s.user.id,s.token,req.params.id);return campaign?{campaign}:missing(reply);});
  app.post('/api/campaigns/:id/cancel',{schema:{params:object({id}),body:empty,querystring:empty}},async(req,reply)=>{const s=await team(req,reply,true);if(!s)return;const campaign=await repository.cancelCampaign(s.user.id,s.token,req.params.id);return campaign?{campaign}:missing(reply);});
  app.post('/api/campaigns/:id/process',{...body({clientKey:key}),schema:{...body({clientKey:key}).schema,params:object({id})}},async(req,reply)=>{const s=await team(req,reply,true);if(!s)return;return await repository.processCampaign(s.user.id,s.token,req.params.id,req.body.clientKey)||missing(reply);});
  app.get('/api/portal/news',{schema:{querystring:pagination}},async(req,reply)=>{const s=await portal(req,reply);if(s)return repository.portalNews(s.token,req.query.page,req.query.limit);});
  app.post('/api/portal/news/:id/read',{schema:{params:object({id}),body:empty,querystring:empty}},async(req,reply)=>{const s=await portal(req,reply,true);if(s)return await repository.readPortalNews(s.token,req.params.id)||missing(reply);});
}
module.exports={registerCampaigns};
