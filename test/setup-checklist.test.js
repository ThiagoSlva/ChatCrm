'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){const elements=new Map(),events={},calls=[];let lost=0;
 const doc={body:{},activeElement:null,getElementById(id){if(!elements.has(id))elements.set(id,{textContent:'',children:[],hidden:true,attributes:{},handlers:{},_disabled:false,
 get disabled(){return this._disabled;},set disabled(v){this._disabled=v;if(v&&doc.activeElement===this)doc.activeElement=doc.body;},
 append(...items){this.children.push(...items);},replaceChildren(){this.children=[];},setAttribute(n,v){this.attributes[n]=v;},addEventListener(n,f){this.handlers[n]=f;},focus(){doc.activeElement=this;}});return elements.get(id);},createElement(tag){const e=this.getElementById('node-'+elements.size);e.tag=tag;return e;}};
 let profile={user:{role:'admin'},capabilities:{departments:true,chat:true,replies:false}},handler=async url=>({status:200,data:url==='/api/auth/me'?profile:{departments:[]}});
 const context=vm.createContext({document:doc,window:{addEventListener(n,f){events[n]=f;}},AbortController,AbortSignal,fetch:async(url,options)=>{calls.push({url,options});const r=await handler(url);return{ok:r.status===200,status:r.status,json:async()=>r.data};}});
 vm.runInContext(fs.readFileSync('public/setup-checklist.js','utf8'),context);const module=context.window.ClSetupChecklist;module.init(()=>lost++);
 return{module,doc,calls,el:s=>doc.getElementById('setup-checklist-'+s),get profile(){return profile;},profile:p=>profile=p,handler:f=>handler=f,lost:()=>lost,fire:(n,e={})=>events[n](e),rows:()=>doc.getElementById('setup-checklist-list').children.map(li=>li.children.map(c=>c.textContent).join(' '))};}
const admin=capabilities=>({user:{role:'admin'},capabilities});
test('checklist distinguishes schema preparation from disabled public entry without changing settings',async()=>{
 const f=fixture();await f.module.update(admin({departments:true,chat:true,replies:false}));
 assert.equal(f.el('panel').hidden,false);assert(f.rows()[2].includes('Nenhuma área habilitada'));assert(f.rows()[3].includes('Preparação pendente'));
 assert.deepEqual(f.calls.map(c=>c.url),['/api/chat/public/departments']);assert(f.calls.every(c=>!c.options.method&&c.options.cache==='no-store'));
 f.calls.length=0;await f.module.update(admin({departments:true,chat:false}));assert.equal(f.calls.length,0);assert(f.rows()[1].includes('Preparação pendente'));
});
test('explicit refresh checks the current profile, updates public state and retains focus without writing',async()=>{
 const f=fixture();await f.module.update(admin({departments:true,chat:true}));f.el('refresh').focus();
 f.handler(async url=>({status:200,data:url==='/api/auth/me'?admin({departments:true,chat:true,replies:true}):{departments:[{id:3,name:'Fictício'}]}}));
 await f.el('refresh').handlers.click();assert.equal(f.calls.at(-2).url,'/api/auth/me');assert(f.rows()[2].includes('1 área pode receber'));assert(f.rows()[3].includes('Preparados'));
 assert.equal(f.doc.activeElement,f.el('refresh'));assert(f.calls.every(c=>!c.options.method));
});
test('operators and lost sessions cannot retain checklist state or trigger admin reads',async()=>{
 const f=fixture();await f.module.update({user:{role:'operator'}});assert(f.el('panel').hidden);assert.equal(f.calls.length,0);
 await f.module.update(admin({departments:true,chat:true}));f.handler(async()=>({status:401,data:{}}));await f.el('refresh').handlers.click();
 assert(f.el('panel').hidden);assert.equal(f.el('list').children.length,0);assert.equal(f.lost(),1);
});
test('role revoked during refresh clears the checklist and asks the access screen to revalidate',async()=>{
 const f=fixture();await f.module.update(admin({departments:true,chat:true}));f.handler(async()=>({status:200,data:{user:{role:'operator'}}}));
 await f.el('refresh').handlers.click();assert(f.el('panel').hidden);assert.equal(f.lost(),1);assert.equal(f.el('list').children.length,0);
});
test('unexpected HTTP/data and network errors are unconfirmed instead of available or disabled',async()=>{
 const f=fixture();for(const result of [{status:500,data:{departments:[{id:1,name:'False'}]}},{status:200,data:{departments:['bad']}},{status:200,data:{departments:[{id:1,name:'A'},{id:1,name:'B'}]}}]){
 f.handler(async()=>result);await f.module.update(admin({departments:true,chat:true}));assert(f.rows()[2].includes('Não confirmado'));assert.match(f.el('status').textContent,/parcial/);}
 f.handler(async()=>{throw Error('Network');});await f.el('refresh').handlers.click();assert.equal(f.el('refresh').disabled,false);assert.equal(f.el('list').children.length,0);assert.match(f.el('status').textContent,/confirmar seu acesso/);
});
test('page departure clears states and a late public response cannot rebuild the old checklist',async()=>{
 const f=fixture();let finish;f.handler(()=>new Promise(resolve=>{finish=resolve;}));const pending=f.module.update(admin({departments:true,chat:true}));
 f.fire('pagehide');finish({status:200,data:{departments:[{id:1,name:'Late'}]}});await pending;assert(f.el('panel').hidden);assert.equal(f.el('list').children.length,0);
 const count=f.calls.length;await f.module.update(admin({departments:true,chat:true}));assert.equal(f.calls.length,count);assert(f.el('panel').hidden);
 f.fire('pageshow',{persisted:true});assert.equal(f.lost(),1);assert(f.calls.every(c=>!c.options.method));
});
