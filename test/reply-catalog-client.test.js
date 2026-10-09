'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm'),crypto=require('crypto').webcrypto;
function fixture(){const elements=new Map(),doc={activeElement:null,hidden:false,addEventListener(){},createElement:()=>({value:'',textContent:'',append(){}}),getElementById(id){if(!elements.has(id))elements.set(id,{id,value:'',textContent:'',children:[],handlers:{},checked:true,hidden:false,disabled:false,readOnly:false,addEventListener(n,f){this.handlers[n]=f;},setAttribute(){},querySelectorAll(){return[];},replaceChildren(){this.children=[];},append(c){this.children.push(c);},closest(){return null;},focus(){doc.activeElement=this;},reset(){for(const id of ['title','text','department'])doc.getElementById('reply-'+id).value='';}});return elements.get(id);}};
 let role='admin',lost=false,conflict=false;const calls=[],stored={id:4,departmentId:null,departmentName:null,title:'Atual fictício',text:'Atual do servidor',active:true,version:2};
 const context=vm.createContext({document:doc,window:{addEventListener(){}},crypto,Uint8Array,AbortSignal,AbortController,fetch:async(url,options)=>{calls.push({url,method:options.method,body:options.body});let status=200,data={};
 if(url==='/api/auth/me')data={user:{id:7,name:'Admin fictício',role},csrfToken:'a'.repeat(64),capabilities:{replies:true}};
 else if(url.startsWith('/api/team/departments'))data={departments:[],total:0};
 else if(options.method){if(lost){lost=false;throw Error('Controlled lost response');}if(conflict){status=409;conflict=false;}else data={template:stored};}
 else if(url==='/api/replies/templates/4')data={template:stored};else data={templates:[stored],total:1};
 return{ok:status===200,status,json:async()=>data};}});
 const source=fs.readFileSync('public/reply-catalog.js','utf8').replace(/replyCatalog\.run\(async\(\)=>\{await replyCatalog\.profile\(\);await replyCatalog\.departments\(\);await replyCatalog\.list\(\);replyCatalog\.el\('feedback'\)\.textContent='Catálogo pronto\. Cadastre ou selecione um modelo\.';\}\);\s*$/,'');vm.runInContext(source,context);
 const run=s=>vm.runInContext(s,context);return{run,doc,calls,el:id=>doc.getElementById('reply-'+id),lost:()=>lost=true,conflict:()=>conflict=true,role:v=>role=v};}
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
