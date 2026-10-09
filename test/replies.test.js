'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildServer}=require('../src/server'),{digest}=require('../src/security'),{normalizeReply}=require('../src/reply-input');
const origin='https://catalogue.example.test',token='a'.repeat(64),input={departmentId:null,title:'Guia fictício',text:'Olá, {{visitante}}!',active:true,clientKey:'b'.repeat(32)};
function fixture(t){let role='admin',enabled=true,live=true,calls=[];
 const dto={id:1,departmentId:null,departmentName:null,title:input.title,text:input.text,active:true,version:1};
 const repo={close:async()=>{},session:async value=>value===token&&live?{id:7,name:'Equipe fictícia',role}:null,capabilities:async()=>({schemaVersion:enabled?10:9,replies:enabled}),
 listReplyTemplates:async(...a)=>{calls.push(a);return{templates:[dto],page:a[2],limit:a[3],total:1};},findReplyTemplate:async()=>dto,
 createReplyTemplate:async(...a)=>{normalizeReply(a[2]);calls.push(a);return{template:dto,created:true};},updateReplyTemplate:async(...a)=>{normalizeReply(a[3]);calls.push(a);if(a[3].version!==1)throw Object.assign(Error(),{statusCode:409});return{template:dto};},
 listConversationReplies:async(...a)=>{calls.push(a);if(a[2]!==11)throw Object.assign(Error(),{statusCode:404});return{templates:[dto],total:1,page:a[3],limit:a[4]};},findConversationReply:async(...a)=>{calls.push(a);return{template:dto};}};
 const app=buildServer({repository:repo,env:{APP_URL:origin,NODE_ENV:'production'}});t.after(()=>app.close());
 const headers={cookie:'__Host-cl_session='+token,origin,'x-csrf-token':digest('csrf:'+token)};
 return{app,headers,calls,role:v=>role=v,enabled:v=>enabled=v,live:v=>live=v};
}
test('normalization bounds, variable grammar and original types reject ambiguous writes',()=>{
 assert.deepEqual(normalizeReply({...input,title:'  cafe\u0301  ',text:'\nOlá\n'}),{departmentId:null,title:'café',text:'Olá',active:true});
 for(const data of [{...input,active:'true'},{...input,departmentId:'1'},{...input,departmentId:0},{...input,title:' '},{...input,text:'{{senha}}'},{...input,text:'{{ visitante }}'},{...input,text:'X\u202e'},{...input,text:'X'.repeat(2001)},{...input,title:'X'.repeat(101)},{...input,secret:'unexpected'}])assert.throws(()=>normalizeReply(data),{statusCode:400});
 assert.equal(normalizeReply({...input,text:'<img> {{area}} {{operador}}'}).text,'<img> {{area}} {{operador}}');
});
test('private catalogue routes require session, admin, origin and CSRF before persistence',async t=>{
 const f=fixture(t);assert.equal((await f.app.inject('/api/replies/templates')).statusCode,401);
 f.role('operator');assert.equal((await f.app.inject({url:'/api/replies/templates',headers:f.headers})).statusCode,403);
 assert.equal((await f.app.inject({url:'/api/chat/team/conversations/11/replies',headers:f.headers})).statusCode,200);f.calls.length=0;f.role('admin');
 for(const headers of [{...f.headers,origin:'https://foreign.example.test'},{...f.headers,'x-csrf-token':'bad'},{origin}])assert([401,403].includes((await f.app.inject({method:'POST',url:'/api/replies/templates',headers,payload:input})).statusCode));
 assert.equal(f.calls.length,0);f.live(false);assert.equal((await f.app.inject({url:'/api/replies/templates',headers:f.headers})).statusCode,401);
});
test('API keeps schema9 operational and refuses catalogue until explicit migration',async t=>{
 const f=fixture(t);f.enabled(false);for(const url of ['/api/replies/templates','/api/chat/team/conversations/11/replies'])assert.equal((await f.app.inject({url,headers:f.headers})).statusCode,503);
 assert.equal((await f.app.inject('/health')).statusCode,200);assert.equal(f.calls.length,0);
});
test('strict schema refuses coerced bodies, injected fields, arrays, malformed keys and unbounded filters',async t=>{
 const f=fixture(t);for(const payload of [{...input,active:1},{...input,departmentId:'3'},{...input,text:3},{...input,clientKey:'x'.repeat(32)},{...input,createdBy:9},[input]])assert.equal((await f.app.inject({method:'POST',url:'/api/replies/templates',headers:f.headers,payload})).statusCode,400);
 for(const query of ['?page=0','?limit=51','?page=10001','?q=a&q=b','?unknown=x'])assert.equal((await f.app.inject({url:'/api/replies/templates'+query,headers:f.headers})).statusCode,400);
 assert.equal(f.calls.length,0);
});
test('create/detail/pagination and CAS conflicts have bounded responses without request hashes',async t=>{
 const f=fixture(t),r=await f.app.inject({method:'POST',url:'/api/replies/templates',headers:f.headers,payload:input});assert.equal(r.statusCode,201);assert.deepEqual(Object.keys(r.json().template).sort(),['active','departmentId','departmentName','id','text','title','version']);
 assert.equal((await f.app.inject({method:'PUT',url:'/api/replies/templates/1',headers:f.headers,payload:{departmentId:null,title:input.title,text:input.text,active:false,version:2}})).statusCode,409);
 assert.equal((await f.app.inject({url:'/api/chat/team/conversations/12/replies',headers:f.headers})).statusCode,404);
 await f.app.inject({url:'/api/replies/templates?page=2&limit=10&q=%25_',headers:f.headers});assert.deepEqual(f.calls.at(-1).slice(2),[2,10,'%_']);
});
