'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),crypto=require('crypto').webcrypto;
function fixture(){const elements=new Map(),doc={activeElement:null,hidden:false,addEventListener(){},createElement:()=>({value:'',textContent:'',append(){},addEventListener(){}}),getElementById(id){if(!elements.has(id))elements.set(id,{id,value:'',textContent:'',children:[],handlers:{},checked:true,hidden:false,disabled:false,readOnly:false,addEventListener(n,f){this.handlers[n]=f;},setAttribute(){},querySelectorAll(){return[];},replaceChildren(){this.children=[];},append(c){this.children.push(c);},closest(){return null;},focus(){doc.activeElement=this;},reset(){for(const id of ['title','text','department'])doc.getElementById('reply-'+id).value='';}});return elements.get(id);}};
 let role='admin',lost=false,conflict=false,offline=false,hold=false,release,holdProfile=false,releaseProfile;const events={},calls=[],stored={id:4,departmentId:null,departmentName:null,title:'Atual fictício',text:'Atual do servidor',active:true,version:2};
 const context=vm.createContext({document:doc,window:{addEventListener(n,f){events[n]=f;}},crypto,Uint8Array,AbortSignal,AbortController,fetch:async(url,options)=>{calls.push({url,method:options.method,body:options.body});let status=200,data={};
 if(url==='/api/auth/me'&&offline){offline=false;throw Error('Controlled offline profile');}
 if(url==='/api/auth/me'&&holdProfile){holdProfile=false;await new Promise(resolve=>{releaseProfile=resolve;});}
 if(options.method&&hold){hold=false;await new Promise(resolve=>{release=resolve;});}
 if(url==='/api/auth/me')data={user:{id:7,name:'Admin fictício',role},csrfToken:'a'.repeat(64),capabilities:{replies:true}};
 else if(url.startsWith('/api/team/departments'))data={departments:[],total:0};
 else if(options.method){if(lost){lost=false;throw Error('Controlled lost response');}if(conflict){status=409;conflict=false;}else data={template:stored};}
 else if(url==='/api/replies/templates/4')data={template:stored};else data={templates:[stored],total:1};
 return{ok:status===200,status,json:async()=>data};}});
 const source=fs.readFileSync('public/reply-catalog.js','utf8').replace(/replyCatalog\.run\(async\(\)=>\{await replyCatalog\.profile\(\);await replyCatalog\.departments\(\);await replyCatalog\.list\(\);replyCatalog\.el\('feedback'\)\.textContent='Catálogo pronto\. Cadastre ou selecione um modelo\.';\}\);\s*$/,'');vm.runInContext(source,context);
 const run=s=>vm.runInContext(s,context);return{run,doc,calls,el:id=>doc.getElementById('reply-'+id),lost:()=>lost=true,conflict:()=>conflict=true,role:v=>role=v,fire:(name,event={})=>events[name]?.(event),offline:()=>offline=true,hold:()=>hold=true,release:()=>release(),holdProfile:()=>holdProfile=true,releaseProfile:()=>releaseProfile()};}
test('admin lost creation preserves exact body/key and locks fields until same request confirmed',async()=>{
 const f=fixture();await f.run('replyCatalog.run(()=>replyCatalog.profile())');f.run('replyCatalog.pending={id:null,body:{title:"Proposta",text:"Texto preservado",departmentId:null,active:true,clientKey:"b".repeat(32)}};replyCatalog.el("text").value="Texto preservado";');f.lost();await f.run('replyCatalog.send()');
 const first=f.calls.find(c=>c.method==='POST').body;assert.equal(f.el('text').value,'Texto preservado');assert(f.el('text').readOnly);assert.equal(f.el('retry').hidden,false);
 await f.run('replyCatalog.send()');assert.equal(f.calls.filter(c=>c.method==='POST')[1].body,first);assert.equal(f.run('replyCatalog.pending'),null);assert.equal(f.el('retry').hidden,true);
});
test('admin conflict compares current server version without replacing proposal; explicit adoption keeps fields',async()=>{
 const f=fixture();await f.run('replyCatalog.run(()=>replyCatalog.profile())');f.run('replyCatalog.edit({id:4,departmentId:null,departmentName:null,title:"Antigo",text:"Antigo",active:true,version:1});replyCatalog.el("text").value="Minha proposta";replyCatalog.pending={id:4,body:{title:"Antigo",text:"Minha proposta",departmentId:null,active:true,version:1}};');f.conflict();await f.run('replyCatalog.send()');
 assert.equal(f.el('text').value,'Minha proposta');assert.equal(f.el('review-text').textContent,'Atual do servidor');assert.equal(f.el('save').disabled,true);f.el('adopt').handlers.click();assert.equal(f.run('replyCatalog.selected.version'),2);assert.equal(f.el('text').value,'Minha proposta');assert.equal(f.el('save').disabled,false);
});
test('admin role revocation clears private fields, catalogue, comparison and pending request',async()=>{
 const f=fixture();await f.run('replyCatalog.run(()=>replyCatalog.profile())');f.run('replyCatalog.el("text").value="privado";replyCatalog.el("review-title").textContent="privado";replyCatalog.el("review-scope").textContent="privado";replyCatalog.pending={body:{text:"privado"}};');f.role('operator');await f.run('replyCatalog.run(()=>replyCatalog.profile())');
 for(const id of ['text','review-title','review-scope','review-text','identity'])assert.equal(f.el(id).value||f.el(id).textContent,'');assert.equal(f.run('replyCatalog.pending'),null);assert(f.el('work').hidden);assert.equal(f.el('access').hidden,false);
});

test('persisted navigation restores catalogue through fresh reads, without recovering or resending erased private fields', async () => {
 const f=fixture();await f.run('replyCatalog.run(async()=>{await replyCatalog.profile();await replyCatalog.list();})');
 f.run('replyCatalog.el("text").value="privado";replyCatalog.pending={id:null,body:{text:"privado",clientKey:"b".repeat(32)}};');
 await f.fire('pagehide',{persisted:true});assert.equal(f.el('text').value,'');assert.equal(f.run('replyCatalog.pending'),null);
 const before=f.calls.length;await f.fire('pageshow',{persisted:true});
 assert.equal(f.run('replyCatalog.disposed'),false);assert.equal(f.run('replyCatalog.ready'),true);assert.equal(f.el('work').hidden,false);
 assert.equal(f.el('list').children.length,1);assert.equal(f.el('text').value,'');assert(f.calls.slice(before).every(c=>!c.method));
 const restored=f.calls.length;await f.fire('pageshow',{persisted:false});assert.equal(f.calls.length,restored);
});

test('persisted navigation revalidates the current role and keeps private controls blocked after revocation', async () => {
 const f=fixture();await f.run('replyCatalog.run(()=>replyCatalog.profile())');await f.fire('pagehide',{persisted:true});f.role('operator');
 await f.fire('pageshow',{persisted:true});assert.equal(f.run('replyCatalog.disposed'),false);assert.equal(f.run('replyCatalog.ready'),false);
 assert(f.el('work').hidden);assert.equal(f.el('access').hidden,false);assert.equal(f.el('list').children.length,0);assert(f.el('save').disabled);
 assert(f.calls.every(c=>!c.method));
});

test('late write response from the departed page cannot overwrite a freshly restored catalogue', async () => {
 const f=fixture();await f.run('replyCatalog.run(()=>replyCatalog.profile())');f.hold();
 f.run('replyCatalog.pending={id:null,body:{title:"Antigo privado",text:"Antigo privado",departmentId:null,active:true,clientKey:"b".repeat(32)}};');
 const writing=f.run('replyCatalog.send()');await new Promise(setImmediate);assert(f.calls.some(c=>c.method==='POST'));
 await f.fire('pagehide',{persisted:true});await f.fire('pageshow',{persisted:true});f.release();await writing;
 assert.equal(f.run('replyCatalog.ready'),true);assert.equal(f.run('replyCatalog.busy'),false);assert.equal(f.run('replyCatalog.pending'),null);
 assert.equal(f.el('text').value,'');assert.equal(f.run('replyCatalog.selected'),null);assert.equal(f.calls.filter(c=>c.method==='POST').length,1);
});

test('offline restore remains blocked and an explicit refresh can revalidate without writes', async () => {
 const f=fixture();await f.run('replyCatalog.run(()=>replyCatalog.profile())');f.el('access-note').textContent='Aviso da sessão anterior';await f.fire('pagehide',{persisted:true});f.offline();
 await f.fire('pageshow',{persisted:true});assert.equal(f.run('replyCatalog.ready'),false);assert(f.el('work').hidden);assert(f.el('save').disabled);
 assert.equal(f.el('access-note').textContent,'');assert(f.el('access').hidden);assert.equal(f.el('feedback').textContent,'Não foi possível revalidar seu acesso e catálogo. Verifique novamente.');
 assert.equal(f.el('refresh').disabled,false);await f.el('refresh').handlers.click();assert.equal(f.run('replyCatalog.ready'),true);
 assert.equal(f.el('list').children.length,1);assert(f.calls.every(c=>!c.method));
});

test('restoration shows loading and blocks stale controls until the current profile is confirmed', async () => {
 const f=fixture();await f.run('replyCatalog.run(()=>replyCatalog.profile())');await f.fire('pagehide',{persisted:true});f.holdProfile();
 const restoring=f.fire('pageshow',{persisted:true});assert.equal(f.run('replyCatalog.busy'),true);assert.equal(f.run('replyCatalog.ready'),false);
 assert(f.el('work').hidden);assert(f.el('save').disabled);assert(f.el('refresh').disabled);assert.equal(f.el('feedback').textContent,'Revalidando seu acesso e catálogo…');
 f.releaseProfile();await restoring;assert.equal(f.run('replyCatalog.ready'),true);assert.equal(f.el('refresh').disabled,false);
 assert.equal(f.doc.activeElement.id,'reply-refresh');assert(f.calls.every(c=>!c.method));
});
