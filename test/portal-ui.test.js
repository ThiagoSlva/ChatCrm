'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),test=require('node:test');
class Element {
  constructor(tag='div',document){this.tagName=tag.toUpperCase();this.doc=document;this.children=[];this.attributes={};this.listeners={};this.parentElement=null;this.hidden=false;this.disabled=false;this.readOnly=false;this.value='';this.textContent='';this.scrollHeight=200;this.clientHeight=180;this.scrollTop=0;this.id='';}
  set id(value){this._id=value;if(value&&this.doc)this.doc.ids.set(value,this);}
  get id(){return this._id;}
  append(...items){for(const item of items){item.parentElement=this;this.children.push(item);}}
  replaceChildren(...items){for(const child of this.children){child.parentElement=null;this.doc?.unregister(child);}this.children=[];this.append(...items);}
  insertBefore(child,before){const previous=this.children.indexOf(child);if(previous>=0)this.children.splice(previous,1);const index=before?this.children.indexOf(before):-1;child.parentElement=this;if(index<0)this.children.push(child);else this.children.splice(index,0,child);}
  remove(){if(this.parentElement){const parent=this.parentElement;parent.children=parent.children.filter(child=>child!==this);this.parentElement=null;this.doc.unregister(this);}}
  setAttribute(name,value){this.attributes[name]=String(value);}
  getAttribute(name){return this.attributes[name]??null;}
  querySelectorAll(selector){const tags=selector.split(',').map(value=>value.trim().toUpperCase()),result=[];const scan=node=>{for(const child of node.children){if(tags.includes(child.tagName))result.push(child);scan(child);}};scan(this);return result;}
  querySelector(selector){return this.querySelectorAll(selector)[0]??null;}
  closest(selector){let node=this;while(node){if(selector==='[hidden]'?node.hidden:node.tagName===selector.toUpperCase())return node;node=node.parentElement;}return null;}
  addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);}
  fire(type,props={}){const event={currentTarget:this,target:this,defaultPrevented:false,preventDefault(){this.defaultPrevented=true;},...props};for(const fn of this.listeners[type]??[])fn(event);return event;}
  checkValidity(){const min=Number(this.attributes.minlength||0),max=Number(this.attributes.maxlength||Infinity),pattern=this.attributes.pattern;return (!Object.hasOwn(this.attributes,'required')||Boolean(this.value)||this.checked) && this.value.length>=min && this.value.length<=max && (!pattern||new RegExp('^(?:'+pattern+')$').test(this.value));}
  reportValidity(){return this.checkValidity();}
  reset(){this.querySelectorAll('input,select,textarea').forEach(el=>{el.value='';el.checked=false;});}
  focus(){this.doc.activeElement=this;}
  requestSubmit(button){if(button?.disabled)return;this.submitCount=(this.submitCount??0)+1;this.fire('submit',{submitter:button});}
}
function dom(html){
  const document={ids:new Map(),listeners:{},hidden:false,activeElement:null,getElementById(id){return this.ids.get(id)??null;},createElement(tag){return new Element(tag,this);},addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);},fire(type,props={}){for(const fn of this.listeners[type]??[])fn(props);},unregister(node){if(node.id)this.ids.delete(node.id);for(const child of node.children)this.unregister(child);}};
  const root=new Element('body',document),stack=[root],voids=new Set(['meta','link','input','br','hr']);
  for(const match of html.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/gi)){
    const closing=match[1],tag=match[2].toLowerCase();
    if(closing){for(let i=stack.length-1;i>0;i--)if(stack[i].tagName===tag.toUpperCase()){stack.length=i;break;}continue;}
    const element=new Element(tag,document);
    for(const attr of match[3].matchAll(/([\w:-]+)(?:="([^"]*)")?/g)){const name=attr[1],value=attr[2]??'';element.setAttribute(name,value);if(name==='id')element.id=value;if(name==='name')element.name=value;if(name==='value')element.value=value;if(name==='hidden')element.hidden=true;if(name==='disabled')element.disabled=true;}
    stack.at(-1).append(element);
    if(tag==='option'){const select=element.closest('select');if(select&&(!select.value||element.attributes.selected!==undefined))select.value=element.value;}
    if(!voids.has(tag))stack.push(element);
  }
  const window={listeners:{},addEventListener(type,fn){(this.listeners[type]??=[]).push(fn);},fire(type,props={}){for(const fn of this.listeners[type]??[])fn(props);}};
  class FormDataMock{constructor(form){this.data=new Map(form.querySelectorAll('input,select,textarea').filter(field=>field.name&&!field.disabled).map(field=>[field.name,field.value]));}get(name){return this.data.get(name)??null;}[Symbol.iterator](){return this.data[Symbol.iterator]();}}
  document.querySelectorAll=selector=>root.querySelectorAll(selector.replace(/\.portal-main /g,''));
  return {document,window,FormDataMock};
}
function fixture(){
 const {document,window}=dom(fs.readFileSync('public/portal.html','utf8')),timers=new Map(),requests=[];let n=0,depth=0,max=0;
 const accessId='a'.repeat(24),secondId='b'.repeat(24),code='c'.repeat(64),stamp='2026-10-02T22:00:00.000Z';
 const state={signed:false,guest:true,accountId:accessId,registration:null,recovery:null,loseRegistration:false,loseRecovery:false,loseMessage:false,badProfile:false,badList:false,closed:false,messages:[]};
 const row=()=>({id:100,departmentName:'Área de suporte sintético com nome longo para revisão',status:state.closed?'closed':'open',updatedAt:stamp});
 async function router(url,o){
  const method=o.method||'GET',payload=o.body?JSON.parse(o.body):null;requests.push({url,method,payload});
  if(url==='/api/portal/me')return state.signed?{status:200,body:state.badProfile?{}:{account:{accessId:state.accountId,name:'Cliente sintético'},csrfToken:code}}:{status:401,body:{}};
  if(url==='/api/chat/visitor/me')return state.guest?{status:200,body:{visitor:{id:11,name:'Visitante sintético'},csrfToken:code}}:{status:401,body:{}};
  if(url==='/api/portal/register'){state.registration=payload;state.accountId=payload.accessId;state.guest=false;if(state.loseRegistration)throw Error('Conexão perdida');return {status:201,body:{created:true,account:{accessId:payload.accessId,name:'Visitante sintético'}}};}
  if(url==='/api/portal/recover'){state.recovery=payload;state.accountId=payload.accessId;state.signed=false;if(state.loseRecovery)throw Error('Conexão perdida');return {status:200,body:{recovered:true,authenticated:false}};}
  if(url==='/api/portal/login'){state.signed=true;state.accountId=payload.accessId;return {status:200,body:{authenticated:true}};}
  if(url==='/api/portal/logout'){state.signed=false;return {status:200,body:{authenticated:false}};}
  if(url==='/api/chat/public/departments')return {status:200,body:{departments:[{id:10,name:'Suporte'}]}};
  if(url==='/api/portal/conversations')return {status:200,body:state.badList?{}:{conversations:[row()]}};
  if(url.includes('/messages?')){const after=Number(new URL(url,'https://example.test').searchParams.get('after')),msgs=state.messages.filter(m=>m.sequence>after);return {status:200,body:{messages:msgs,cursor:msgs.at(-1)?.sequence??after,hasMore:false}};}
  if(url.endsWith('/messages')&&method==='POST'){let message=state.messages.find(m=>m.key===payload.clientKey);if(!message){message={sequence:state.messages.length+1,text:payload.text,sender:'visitor',createdAt:stamp,key:payload.clientKey};state.messages.push(message);}if(state.loseMessage)return {status:201,body:{}};return {status:200,body:{message}};}
  throw Error('Unexpected route '+url);
 }
 const context=vm.createContext({document,window,AbortController,AbortSignal,URL,Blob,location:{origin:'https://example.test'},crypto:require('node:crypto').webcrypto,Uint8Array,Date,Map,Promise,setTimeout(fn,ms){const id=++n;timers.set(id,{fn,ms});return id;},clearTimeout(id){timers.delete(id);},async fetch(url,o={}){depth++;max=Math.max(max,depth);try{await Promise.resolve();const r=await router(url,o);return {ok:r.status<400,status:r.status,json:async()=>r.body};}finally{depth--;}}});
 vm.runInContext(fs.readFileSync('public/polling.js','utf8'),context);vm.runInContext(fs.readFileSync('public/portal.js','utf8'),context);vm.runInContext(fs.readFileSync('public/portal-chat.js','utf8').replace(/portal.initialize\(\);\s*$/,''),context);
 const run=code=>vm.runInContext(code,context),get=id=>document.getElementById('portal-'+id);
 const idle=async()=>{for(let i=0;i<100;i++){await new Promise(setImmediate);if(!run('portal.busy')&&!depth)return;}throw Error('UI did not finish');};
 const init=async()=>{run('portal.initialize()');await idle();};
 return {state,requests,document,window,timers,run,get,idle,init,max:()=>max,accessId,secondId};
}

test('portal sem sessão não cria visitante; preparação exige guest atual',async()=>{
 const f=fixture();await f.init();assert.equal(f.get('auth').hidden,false);assert.equal(f.get('space').hidden,true);assert.equal(f.requests.some(r=>r.method==='POST'),false);
 f.state.guest=false;f.get('register-password').value=f.get('register-confirmation').value='senha-sintética-segura';await f.run("portal.prepare('register')");assert.equal(f.run('portal.kits.register'),null);assert.match(f.get('guest-note').textContent,/sessão atual/);
});

test('cadastro incerto conserva kit pré-conhecido, impede repetição e login confirma',async()=>{
 const f=fixture();await f.init();f.get('register-password').value=f.get('register-confirmation').value='senha-sintética-segura';await f.run("portal.prepare('register')");
 const kit=f.run('portal.kits.register');assert.match(kit.payload.accessId,/^[a-f0-9]{24}$/);assert.match(kit.payload.recoveryCode,/^[a-f0-9]{64}$/);assert.equal(f.get('register-password').readOnly,true);
 await f.run("portal.submitKit('register')");assert.equal(f.state.registration,null);
 f.get('register-saved').checked=true;f.state.loseRegistration=true;await f.run("portal.submitKit('register')");assert.equal(f.run('portal.kits.register'),kit);assert.equal(kit.attempted,true);assert.equal(f.get('register-submit').disabled,true);assert.equal(f.get('login-id').value,kit.payload.accessId);assert.equal(f.get('register-code').textContent,kit.payload.recoveryCode);
 await f.run("portal.submitKit('register')");assert.equal(f.requests.filter(r=>r.url==='/api/portal/register').length,1);
 f.get('login-password').value=kit.payload.password;f.get('login').fire('submit');await f.idle();assert.equal(f.get('space').hidden,false);assert.equal(f.run('portal.kits.register'),null);assert.equal(f.get('register-code').textContent,'');assert.equal(f.max(),1);
});

test('recuperação incerta preserva código novo e não repete a troca',async()=>{
 const f=fixture();await f.init();f.get('recover-id').value=f.accessId;f.get('recover-code').value='d'.repeat(64);f.get('recover-password').value=f.get('recover-confirmation').value='nova-senha-sintética';await f.run("portal.prepare('recover')");const kit=f.run('portal.kits.recover');assert.notEqual(kit.payload.recoveryCode,kit.payload.newRecoveryCode);
 f.get('recover-saved').checked=true;f.state.loseRecovery=true;await f.run("portal.submitKit('recover')");await f.run("portal.submitKit('recover')");assert.equal(f.requests.filter(r=>r.url==='/api/portal/recover').length,1);assert.equal(f.get('recover-new-code').textContent,kit.payload.newRecoveryCode);assert.equal(f.run('portal.kits.recover'),kit);assert.match(f.get('feedback').textContent,/nova senha/);
});

test('POST201 incompleto conserva chave e texto; revalidação e reenvio confirmam sem duplicação',async()=>{
 const f=fixture();f.state.signed=true;await f.init();f.get('text').value='Mensagem sintética';f.get('text').fire('input');f.state.loseMessage=true;f.get('compose').fire('submit');await f.idle();const pending=f.run('portalChat.draft().pending');assert.equal(pending.text,'Mensagem sintética');assert.equal(f.get('text').readOnly,true);assert.equal(f.get('send').disabled,true);assert.equal(f.state.messages.length,1);
 f.state.loseMessage=false;await f.init();assert.equal(f.run('portalChat.draft().pending'),pending);f.get('compose').fire('submit');await f.idle();assert.equal(f.run('portalChat.draft().pending'),null);assert.equal(f.state.messages.length,1);const posts=f.requests.filter(r=>r.method==='POST'&&r.url.endsWith('/messages'));assert.equal(posts.length,2);assert.deepEqual(posts[0].payload,posts[1].payload);
});

test('metadata inválida bloqueia preservando rascunho; revogação remove dados privados',async()=>{
 const f=fixture();f.state.signed=true;await f.init();f.get('text').value='Rascunho guardado';f.get('text').fire('input');f.state.badProfile=true;await f.init();assert.equal(f.run('portal.confirmed'),false);assert.equal(f.run('portalChat.draft(100).text'),'Rascunho guardado');assert.equal(f.get('send').disabled,true);f.state.badProfile=false;f.state.signed=false;await f.init();assert.equal(f.run('portalChat.histories.size'),0);assert.equal(f.run('portalChat.drafts.size'),0);assert.equal(f.get('text').value,'');
});

test('troca de conta entre seleção e envio não reutiliza rascunho nem faz POST',async()=>{
 const f=fixture();f.state.signed=true;await f.init();f.get('text').value='Texto da primeira conta';f.get('text').fire('input');f.state.accountId=f.secondId;f.get('compose').fire('submit');await f.idle();assert.equal(f.requests.some(r=>r.method==='POST'&&r.url.endsWith('/messages')),false);assert.equal(f.run('portalChat.drafts.size'),0);assert.equal(f.get('space').hidden,true);
});

test('sessão encerra detalhes no pagehide e BFCache revalida; CtrlEnter respeita composição',async()=>{
 const f=fixture();f.state.signed=true;await f.init();f.get('text').value='Texto';f.get('text').fire('input');f.get('text').fire('keydown',{key:'Enter',ctrlKey:true,isComposing:true});assert.equal(f.requests.some(r=>r.method==='POST'),false);f.window.fire('pagehide');assert.equal(f.get('space').hidden,true);assert.equal(f.run('portalChat.drafts.size'),0);f.state.signed=false;f.window.fire('pageshow',{persisted:true});await f.idle();assert.equal(f.get('auth').hidden,false);
});


test('sessão antiga não confirma recuperação incerta nem descarta o novo código',async()=>{
 const f=fixture();await f.init();f.get('recover-id').value=f.accessId;f.get('recover-code').value='d'.repeat(64);f.get('recover-password').value=f.get('recover-confirmation').value='nova-senha-sintética';await f.run("portal.prepare('recover')");f.get('recover-saved').checked=true;f.state.loseRecovery=true;await f.run("portal.submitKit('recover')");const kit=f.run('portal.kits.recover');f.state.signed=true;await f.run('portal.run(()=>portal.profile())');assert.equal(f.run('portal.kits.recover'),kit);assert.equal(kit.confirmed,undefined);assert.equal(f.get('recover-new-code').textContent,kit.payload.newRecoveryCode);
});
