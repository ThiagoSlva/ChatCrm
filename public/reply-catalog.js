'use strict';
const replyCatalog={
  user:null,csrf:null,ready:false,busy:false,disposed:false,generation:0,controller:null,selected:null,pending:null,review:null,dirty:false,page:1,total:0,query:'',
  el:id=>document.getElementById('reply-'+id),
  error:s=>({400:'Confira título, texto e variáveis permitidas.',401:'Sua sessão encerrou. Entre novamente.',403:'Somente administradores gerenciam os modelos.',404:'O modelo ou a área não está disponível.',409:'O modelo mudou. Confira a versão do servidor antes de editar novamente.',413:'O texto excedeu o limite da instalação.',429:'O limite de 500 modelos foi atingido.',503:'O catálogo privado aguarda preparação da instalação.'})[s]||'O resultado não foi confirmado. Seus campos e o pedido foram preservados.',
  valid:t=>t&&Number.isInteger(t.id)&&t.id>0&&Number.isInteger(t.version)&&t.version>0&&typeof t.title==='string'&&typeof t.text==='string'&&typeof t.active==='boolean'&&(t.departmentId===null||(Number.isInteger(t.departmentId)&&t.departmentId>0)),
  async api(url,options={}) {
    const generation=this.generation,controller=this.controller;
    const response=await fetch(url,{...options,credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
    const data=await response.json();
    if(generation!==this.generation||this.disposed||controller.signal.aborted)throw Object.assign(Error(),{name:'AbortError'});
    if(!response.ok)throw Object.assign(Error(this.error(response.status)),{status:response.status});return data;
  },
  reset() {this.selected=null;this.review=null;this.dirty=false;this.el('form').reset();this.el('active').checked=true;this.el('heading').textContent='Novo modelo';this.el('version').textContent='O modelo pode atender toda a empresa ou somente uma área.';this.el('review').hidden=true;this.el('review-text').textContent='';this.el('review-title').textContent='';this.el('review-scope').textContent='';},
  clear() {this.user=null;this.csrf=null;this.pending=null;this.ready=false;this.reset();this.el('department').replaceChildren();const option=document.createElement('option');option.value='';option.textContent='Toda a empresa';this.el('department').append(option);this.el('list').replaceChildren();this.el('identity').textContent='';this.el('query').value='';this.query='';this.page=1;this.total=0;this.el('work').hidden=true;},
  controls() {
    const locked=this.busy||!this.ready||Boolean(this.pending);
    this.el('refresh').disabled=this.busy;this.el('retry').hidden=!this.pending;this.el('retry').disabled=this.busy||!this.ready;
    for(const id of ['title','text'])this.el(id).readOnly=locked;
    for(const id of ['department','active','discard','query','search-submit'])this.el(id).disabled=locked;
    this.el('save').disabled=locked||Boolean(this.review);
    this.el('save').textContent=this.selected?'Salvar alterações':'Salvar modelo';
    this.el('adopt').disabled=locked||!this.review;
    this.el('previous').disabled=locked||this.page===1;this.el('next').disabled=locked||this.page*20>=this.total;
    this.el('list').querySelectorAll('button').forEach(b=>b.disabled=locked||this.dirty||Boolean(this.review));
    this.el('work').setAttribute('aria-busy',String(this.busy));
  },
  async profile() {
    const d=await this.api('/api/auth/me');
    if(!d.user||!Number.isInteger(d.user.id)||typeof d.csrfToken!=='string'||!/^[a-f0-9]{64}$/.test(d.csrfToken))throw Error('A sessão não pôde ser confirmada.');
    if(this.user&&this.user.id!==d.user.id){this.clear();throw Object.assign(Error(this.error(401)),{status:401});}
    this.user=d.user;this.csrf=d.csrfToken;
    if(d.user.role!=='admin')throw Object.assign(Error(this.error(403)),{status:403});
    if(d.capabilities?.replies!==true)throw Object.assign(Error(this.error(503)),{status:503});
    this.ready=true;this.el('identity').textContent='Administração: '+d.user.name;this.el('access').hidden=true;this.el('work').hidden=false;
  },
  async departments() {
    const previous=this.el('department').value,areas=[];
    for(let page=1;page<=10;page++){
      const d=await this.api('/api/team/departments?page='+page+'&limit=50');
      if(!Array.isArray(d.departments)||!Number.isInteger(d.total)||d.total>500||d.departments.some(a=>!Number.isInteger(a.id)||typeof a.name!=='string'||typeof a.active!=='boolean'))throw Error('As áreas não puderam ser confirmadas.');
      areas.push(...d.departments);if(page*50>=d.total)break;
    }
    this.el('department').replaceChildren();const global=document.createElement('option');global.value='';global.textContent='Toda a empresa';this.el('department').append(global);
    for(const a of areas){const option=document.createElement('option');option.value=String(a.id);option.textContent=a.name+(a.active?'':' · área desativada');this.el('department').append(option);}
    this.el('department').value=previous;
    if(previous&&!areas.some(a=>String(a.id)===previous)){this.el('department').value='';this.el('feedback').textContent='A área anterior não está disponível. Revise o escopo antes de salvar.';this.dirty=true;}
  },
  async list() {
    const d=await this.api('/api/replies/templates?page='+this.page+'&limit=20&q='+encodeURIComponent(this.query));
    if(!Array.isArray(d.templates)||!Number.isInteger(d.total)||d.templates.some(t=>!this.valid(t)))throw Error('O catálogo não pôde ser confirmado.');
    this.total=d.total;this.el('list').replaceChildren();this.el('empty').hidden=d.templates.length>0;
    for(const t of d.templates){const li=document.createElement('li'),button=document.createElement('button');button.type='button';button.className='conversation-select';button.textContent=t.title+' · '+(t.departmentName||'Toda a empresa')+' · '+(t.active?'Disponível':'Desativado');button.addEventListener('click',()=>{if(this.dirty||this.pending||this.review)return;this.run(async()=>{await this.profile();const d=await this.api('/api/replies/templates/'+t.id);this.edit(d.template);},'reply-heading');});li.append(button);this.el('list').append(li);}
    this.el('page').textContent='Página '+this.page+' · '+this.total+' modelos';
  },
  edit(t) {if(!this.valid(t))throw Error('Modelo não confirmado.');this.selected=t;this.review=null;this.dirty=false;this.el('title').value=t.title;this.el('text').value=t.text;this.el('department').value=t.departmentId===null?'':String(t.departmentId);this.el('active').checked=t.active;this.el('heading').textContent='Editar modelo';this.el('version').textContent='Versão '+t.version+' · alterações concorrentes exigem revisão.';this.el('review').hidden=true;},
  async inspect() {
    if(!this.selected)return;const d=await this.api('/api/replies/templates/'+this.selected.id);if(!this.valid(d.template))throw Error('Versão não confirmada.');
    this.review=d.template;this.el('review').hidden=false;this.el('review-title').textContent=d.template.title+' · versão '+d.template.version;
    this.el('review-scope').textContent=(d.template.departmentName||'Toda a empresa')+' · '+(d.template.active?'Disponível':'Desativado');this.el('review-text').textContent=d.template.text;
  },
  async run(work,focusId) {
    if(this.busy||this.disposed)return;this.busy=true;this.controller=new AbortController();const generation=this.generation,focus=document.activeElement?.id;this.controls();
    try{await work();}catch(e){if(e.name==='AbortError'||generation!==this.generation)return;
      if([401,403].includes(e.status)){this.clear();this.el('access').hidden=false;this.el('access-note').textContent=this.error(e.status);}
      if(e.status===503){this.ready=false;this.el('work').hidden=true;this.el('access').hidden=false;this.el('access-note').textContent=this.error(503);}
      this.el('feedback').textContent=e.message||this.error(e.status);
    }finally{if(generation===this.generation){this.busy=false;this.controls();const target=document.getElementById(focusId||focus);if(target&&!target.disabled&&!target.closest('[hidden]'))target.focus();}}
  },
  send() {
    if(!this.pending)return;const p=this.pending;
    return this.run(async()=>{
      await this.profile();
      try {
        const d=await this.api('/api/replies/templates'+(p.id?'/'+p.id:''),{method:p.id?'PUT':'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':this.csrf},body:JSON.stringify(p.body)});
        if(!this.valid(d.template))throw Error('Modelo não confirmado.');this.pending=null;this.edit(d.template);this.el('feedback').textContent='Modelo confirmado no servidor. Nenhuma mensagem foi enviada.';await this.list();
      }catch(e){
        if([400,404,409,413,429].includes(e.status)){this.pending=null;if(e.status===409&&p.id){await this.inspect();}}
        throw e;
      }
    },'reply-heading');
  }
};
replyCatalog.el('form').addEventListener('input',()=>{replyCatalog.dirty=true;replyCatalog.controls();});
replyCatalog.el('form').addEventListener('submit',event=>{
  event.preventDefault();if(replyCatalog.busy||!replyCatalog.ready||replyCatalog.pending||replyCatalog.review)return;
  const body={title:replyCatalog.el('title').value,text:replyCatalog.el('text').value,departmentId:replyCatalog.el('department').value?Number(replyCatalog.el('department').value):null,active:replyCatalog.el('active').checked};
  if(replyCatalog.selected)body.version=replyCatalog.selected.version;else body.clientKey=[...crypto.getRandomValues(new Uint8Array(16))].map(v=>v.toString(16).padStart(2,'0')).join('');
  replyCatalog.pending={id:replyCatalog.selected?.id||null,body};replyCatalog.send();
});
replyCatalog.el('retry').addEventListener('click',()=>replyCatalog.send());
replyCatalog.el('refresh').addEventListener('click',()=>replyCatalog.run(async()=>{await replyCatalog.profile();await replyCatalog.departments();await replyCatalog.list();if(replyCatalog.selected)await replyCatalog.inspect();}));
replyCatalog.el('discard').addEventListener('click',()=>{if(replyCatalog.busy||replyCatalog.pending)return;replyCatalog.reset();replyCatalog.controls();replyCatalog.el('title').focus();});
replyCatalog.el('adopt').addEventListener('click',()=>{if(replyCatalog.busy||!replyCatalog.review||replyCatalog.pending)return;replyCatalog.selected=replyCatalog.review;replyCatalog.review=null;replyCatalog.el('review').hidden=true;replyCatalog.el('review-text').textContent='';replyCatalog.el('version').textContent='Versão '+replyCatalog.selected.version+' revisada. Seus campos continuam preservados.';replyCatalog.dirty=true;replyCatalog.controls();replyCatalog.el('title').focus();});
replyCatalog.el('search').addEventListener('submit',e=>{e.preventDefault();if(replyCatalog.busy||replyCatalog.pending)return;replyCatalog.query=replyCatalog.el('query').value;replyCatalog.page=1;replyCatalog.run(()=>replyCatalog.list());});
for(const [id,delta] of [['previous',-1],['next',1]])replyCatalog.el(id).addEventListener('click',()=>{if(replyCatalog.busy||replyCatalog.pending)return;replyCatalog.page+=delta;replyCatalog.run(()=>replyCatalog.list());});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!replyCatalog.busy)replyCatalog.run(()=>replyCatalog.profile());});
window.addEventListener('pagehide',()=>{replyCatalog.disposed=true;replyCatalog.generation++;replyCatalog.controller?.abort();replyCatalog.clear();});
replyCatalog.run(async()=>{await replyCatalog.profile();await replyCatalog.departments();await replyCatalog.list();replyCatalog.el('feedback').textContent='Catálogo pronto. Cadastre ou selecione um modelo.';});
