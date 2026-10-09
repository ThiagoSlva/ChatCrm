'use strict';
function registerReplies(app,repository,auth) {
  const id={type:'integer',minimum:1,maximum:4294967295};
  const object=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
  const fields={departmentId:{anyOf:[id,{type:'null'}]},title:{type:'string',minLength:1,maxLength:100},text:{type:'string',minLength:1,maxLength:2000},active:{type:'boolean'}};
  const query=object({page:{...id,maximum:10000,default:1},limit:{...id,maximum:50,default:20},q:{type:'string',maxLength:100,default:''}},[]);
  const strictBody=async(request,reply)=>{
    const b=request.body;if(!b||typeof b!=='object'||Array.isArray(b)||typeof b.title!=='string'||typeof b.text!=='string'||typeof b.active!=='boolean'||(b.departmentId!==null&&typeof b.departmentId!=='number')||
      (Object.hasOwn(b,'version')&&typeof b.version!=='number')||(Object.hasOwn(b,'clientKey')&&typeof b.clientKey!=='string'))return reply.code(400).send({error:'Dados invalidos.'});
  };
  const strictQuery=async(request,reply)=>{if(Object.values(request.query).some(v=>typeof v!=='string'))return reply.code(400).send({error:'Filtros invalidos.'});};
  async function session(request,reply,admin,write=false) {
    const user=await auth.authorize(request,reply,{admin,write});if(!user)return null;
    if(!repository?.capabilities||!(await repository.capabilities()).replies){reply.code(503).send({error:'Modelos privados aguardam preparacao da instalacao.'});return null;}
    return {user,token:auth.readToken(request)};
  }
  app.get('/api/replies/templates',{preValidation:strictQuery,schema:{querystring:query}},async(request,reply)=>{const s=await session(request,reply,true);if(s)return repository.listReplyTemplates(s.user.id,s.token,request.query.page,request.query.limit,request.query.q);});
  app.get('/api/replies/templates/:id',{schema:{params:object({id})}},async(request,reply)=>{const s=await session(request,reply,true);if(s)return {template:await repository.findReplyTemplate(s.user.id,s.token,request.params.id)};});
  app.post('/api/replies/templates',{preValidation:strictBody,schema:{body:object({...fields,clientKey:{type:'string',pattern:'^[a-f0-9]{32}$'}})}},async(request,reply)=>{const s=await session(request,reply,true,true);if(!s)return;const result=await repository.createReplyTemplate(s.user.id,s.token,request.body);return reply.code(result.created?201:200).send({template:result.template});});
  app.put('/api/replies/templates/:id',{preValidation:strictBody,schema:{params:object({id}),body:object({...fields,version:id})}},async(request,reply)=>{const s=await session(request,reply,true,true);if(s)return repository.updateReplyTemplate(s.user.id,s.token,request.params.id,request.body);});
  app.get('/api/chat/team/conversations/:id/replies',{preValidation:strictQuery,schema:{params:object({id}),querystring:query}},async(request,reply)=>{const s=await session(request,reply,false);if(s)return repository.listConversationReplies(s.user.id,s.token,request.params.id,request.query.page,request.query.limit,request.query.q);});
  app.get('/api/chat/team/conversations/:id/replies/:templateId',{schema:{params:object({id,templateId:id})}},async(request,reply)=>{const s=await session(request,reply,false);if(s)return repository.findConversationReply(s.user.id,s.token,request.params.id,request.params.templateId);});
}
module.exports={registerReplies};
