'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {buildServer}=require('../src/server');const {digest,secret,hashPassword,verifyPassword}=require('../src/security');
const origin='https://chat.example.test',password='portal-synthetic-password';let encoded;const credential=()=>encoded ||= hashPassword(password);
async function fixture(t,{version=7}={}){
 const guest=secret(),session=secret(),accessId=secret().slice(0,24),recoveryCode=secret();const accounts=new Map([[accessId,{id:1,passwordHash:await credential(),recoveryHash:digest(recoveryCode),version:1}]]),sessions=new Map([[session,accessId]]),calls=[];
 let activeGuest=true,allow=true,stale=false;const fail=statusCode=>{throw Object.assign(new Error(),{statusCode});};const dto={id:100,departmentName:'Suporte',status:'open',updatedAt:'2026-10-02T22:00:00.000Z'};
 const repo={close:async()=>{},status:async()=>'installed',capabilities:async()=>({schemaVersion:version,chat:true,...(version===7?{portal:true}:{})}),session:async()=>null,
 visitorSession:async token=>token===guest&&activeGuest?{id:11,name:'Pessoa sintética'}:null,
 portalSession:async token=>sessions.has(token)?{accessId:sessions.get(token),name:'Pessoa sintética'}:null,
 portalAttempt:async(ip,id)=>{calls.push(['attempt',ip,id]);return allow;},findPortalAccount:async id=>{calls.push(['find',id]);return accounts.has(id)?{...accounts.get(id)}:null;},
 createPortalAccount:async(token,input)=>{calls.push(['register',token,input]);if(!activeGuest||token!==guest)fail(401);if(accounts.size)fail(409);accounts.set(input.accessId,{id:2,passwordHash:input.passwordHash,recoveryHash:input.recoveryHash,version:1});activeGuest=false;return {created:true,account:{accessId:input.accessId,name:'Pessoa sintética'}};},
 createPortalSession:async(token,id,hash,version)=>{calls.push(['cas',id,hash,version]);const pair=[...accounts].find(([,a])=>a.id===id);if(stale||!pair||pair[1].passwordHash!==hash||pair[1].version!==version)return false;sessions.set(token,pair[0]);return true;},
 recoverPortalAccount:async(id,hash,version,newHash,newRecovery)=>{calls.push(['recover',id,hash,version]);const a=accounts.get(id);if(stale||!a||a.recoveryHash!==hash||a.version!==version)return false;Object.assign(a,{passwordHash:newHash,recoveryHash:newRecovery,version:version+1});sessions.clear();activeGuest=false;return true;},
 revokePortalSession:async token=>sessions.delete(token),listPortalConversations:async token=>{calls.push(['list',token]);return {conversations:[dto]};},
 createPortalConversation:async(token,id)=>{calls.push(['open',token,id]);return {created:false,conversation:dto};},
 portalMessages:async(token,id,after,limit)=>{calls.push(['history',token,id,after,limit]);return id===100?{messages:[],cursor:after,hasMore:false}:null;},
 sendPortalMessage:async(token,id,input)=>{calls.push(['send',token,id,input]);return id===100?{created:true,message:{sequence:1,text:input.text,sender:'visitor',createdAt:dto.updatedAt}}:null;}};
 const app=buildServer({repository:repo,env:{APP_URL:origin,NODE_ENV:'production'}});t.after(()=>app.close());
 const headers={origin,'content-type':'application/json',cookie:'__Host-cl_portal='+session,'x-csrf-token':digest('portal-csrf:'+session)};
 const request=(url,method='GET',payload,extra={})=>app.inject({url,method,...(payload===undefined?{}:{payload}),headers:{...headers,...extra}});
 return {repo,app,request,accessId,recoveryCode,accounts,sessions,calls,guest,session,guestHeaders:{cookie:'__Host-cl_visitor='+guest,'x-csrf-token':digest('visitor-csrf:'+guest)},allow:v=>{allow=v;},stale:v=>{stale=v;}};
}
test('portal exige schema7, cookie próprio e DTO sem credenciais',async t=>{
 const f=await fixture(t,{version:6});assert.equal((await f.request('/api/portal/me')).statusCode,503);
 const g=await fixture(t);for(const cookie of ['',g.guestHeaders.cookie,'__Host-cl_session='+g.session])assert.equal((await g.request('/api/portal/me','GET',undefined,{cookie})).statusCode,401);
 const me=await g.request('/api/portal/me');assert.equal(me.statusCode,200);assert.deepEqual(Object.keys(me.json().account).sort(),['accessId','name']);assert.equal(me.json().csrfToken,digest('portal-csrf:'+g.session));
});
test('cadastro verifica guest e CSRF, grava hashes e confirma resposta perdida com login conhecido',async t=>{
 const f=await fixture(t);f.accounts.clear();const accessId=secret().slice(0,24),recoveryCode=secret(),body={accessId,password,confirmation:password,recoveryCode};
 assert.equal((await f.request('/api/portal/register','POST',body,{cookie:''})).statusCode,401);
 assert.equal((await f.request('/api/portal/register','POST',body,{cookie:f.guestHeaders.cookie,'x-csrf-token':''})).statusCode,403);assert.equal(f.calls.length,0);
 const result=await f.request('/api/portal/register','POST',body,f.guestHeaders);assert.equal(result.statusCode,201);assert.equal(result.json().account.accessId,accessId);assert.match(result.headers['set-cookie'],/^__Host-cl_visitor=;.*Max-Age=0/);assert.equal(await f.repo.visitorSession(f.guest),null);
 const a=f.accounts.get(accessId);assert.equal(a.recoveryHash,digest(recoveryCode));assert.equal(await verifyPassword(password,a.passwordHash),true);
 const login=await f.request('/api/portal/login','POST',{accessId,password},{cookie:''});assert.equal(login.statusCode,200);assert.match(login.headers['set-cookie'],/^__Host-cl_portal=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=28800; Secure$/);
});
test('login uniforme para desconhecido ou incorreto e CAS atual após scrypt',async t=>{
 const f=await fixture(t),post=body=>f.request('/api/portal/login','POST',body,{cookie:''});const wrong=await post({accessId:f.accessId,password:'senha-sintética-incorreta'}),unknown=await post({accessId:secret().slice(0,24),password});assert.equal(wrong.statusCode,401);assert.deepEqual(wrong.json(),unknown.json());f.stale(true);assert.equal((await post({accessId:f.accessId,password})).statusCode,401);assert.equal(f.sessions.size,1);assert.equal(f.calls.filter(c=>c[0]==='attempt').length,3);
});
test('origem, tipos e extras são rejeitados antes de tentativas persistentes',async t=>{
 const f=await fixture(t),base={accessId:f.accessId,password};assert.equal((await f.request('/api/portal/login','POST',base,{cookie:'',origin:'https://foreign.example.test'})).statusCode,403);
 for(const body of [{...base,password:123456789012345},{...base,accessId:123},{...base,extra:true},{...base,password:'curta'},{...base,password:'x'.repeat(129)}])assert.equal((await f.request('/api/portal/login','POST',body,{cookie:''})).statusCode,400);
 for(const url of ['/api/portal/me?extra=1','/api/portal/conversations?extra=1','/api/portal/conversations/100/messages?after=1&after=2','/api/portal/conversations/100/messages?limit=51','/api/portal/conversations/0/messages'])assert.equal((await f.request(url)).statusCode,400,url);assert.equal(f.calls.length,0);
});
test('limite persistente recusa antes de buscar/hash e não confia em proxy arbitrário',async t=>{
 const f=await fixture(t);f.allow(false);assert.equal((await f.request('/api/portal/login','POST',{accessId:f.accessId,password},{cookie:'','x-forwarded-for':'192.0.2.1'})).statusCode,429);assert.deepEqual(f.calls,[['attempt',digest('portal-auth:127.0.0.1'),f.accessId]]);
});
test('recuperação rotaciona código, revoga sessões e não retorna segredos',async t=>{
 const f=await fixture(t),code=secret(),newPassword='nova-senha-sintética-segura',body={accessId:f.accessId,recoveryCode:f.recoveryCode,newPassword,confirmation:newPassword,newRecoveryCode:code};
 assert.equal((await f.request('/api/portal/recover','POST',{...body,newPassword:password,confirmation:password})).statusCode,400);assert.equal(f.sessions.size,1);
 assert.equal((await f.request('/api/portal/recover','POST',{...body,newRecoveryCode:f.recoveryCode})).statusCode,400);assert.equal((await f.request('/api/portal/recover','POST',{...body,recoveryCode:secret()})).statusCode,401);
 const result=await f.request('/api/portal/recover','POST',body);assert.equal(result.statusCode,200);assert.deepEqual(result.json(),{recovered:true,authenticated:false});assert.equal(result.headers['set-cookie'].length,2);assert.equal(f.sessions.size,0);assert.equal(f.accounts.get(f.accessId).recoveryHash,digest(code));assert.equal(await verifyPassword(newPassword,f.accounts.get(f.accessId).passwordHash),true);assert.equal((await f.request('/api/portal/me')).statusCode,401);assert.equal((await f.request('/api/portal/recover','POST',body)).statusCode,401);
});
test('histórico e mensagem usam sessão portal, limites, CSRF e texto seguro',async t=>{
 const f=await fixture(t);assert.equal((await f.request('/api/portal/conversations')).statusCode,200);assert.equal((await f.request('/api/portal/conversations','POST',{departmentId:10})).statusCode,200);assert.equal((await f.request('/api/portal/conversations','POST',{departmentId:'10'})).statusCode,400);
 assert.equal((await f.request('/api/portal/conversations/100/messages?after=0&limit=2')).statusCode,200);assert.equal((await f.request('/api/portal/conversations/999/messages')).statusCode,404);
 const key=secret().slice(0,32);assert.equal((await f.request('/api/portal/conversations/100/messages','POST',{text:'  Olá  ',clientKey:key})).statusCode,201);assert.deepEqual(f.calls.find(c=>c[0]==='send'),['send',f.session,100,{text:'Olá',clientKey:key}]);assert.equal((await f.request('/api/portal/conversations/100/messages','POST',{text:'Oi',clientKey:key},{'x-csrf-token':digest('visitor-csrf:'+f.session)})).statusCode,403);assert.equal((await f.request('/api/portal/conversations/100/messages','POST',{text:'x'.repeat(2001),clientKey:key})).statusCode,400);
});
test('logout revoga só sessão atual e exige CSRF',async t=>{
 const f=await fixture(t),second=secret();f.sessions.set(second,f.accessId);assert.equal((await f.request('/api/portal/logout','POST',{}, {'x-csrf-token':''})).statusCode,403);assert.equal((await f.request('/api/portal/logout','POST',{})).statusCode,200);assert.equal(f.sessions.has(second),true);assert.equal((await f.request('/api/portal/me')).statusCode,401);
});


test('gate de CPU limita duas tarefas de senha compartilhadas antes de começar a terceira',async t=>{
 const {registerAuth}=require('../src/auth');const app={get(){},post(){}};const auth=registerAuth(app,null,{APP_URL:origin});
 let release;const blocked=new Promise(resolve=>{release=resolve;});let started=0;
 const a=auth.hashWork(async()=>{started++;await blocked;}),b=auth.hashWork(async()=>{started++;await blocked;});
 await assert.rejects(auth.hashWork(async()=>{started++;}),e=>e.statusCode===429);assert.equal(started,2);release();await Promise.all([a,b]);await auth.hashWork(async()=>{started++;});assert.equal(started,3);
});
