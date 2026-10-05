'use strict';

const campaigns={
 user:null,csrf:null,ready:false,busy:false,disposed:false,generation:0,controller:null,
 preview:null,pending:null,selected:null,page:1,total:0,
 el:id=>document.getElementById('campaign-'+id),
 error:status=>({400:'Confira o título e a mensagem.',401:'Entre com sua conta da equipe.',403:'Somente a administração gerencia campanhas.',404:'A campanha não está disponível.',409:'O público ou o pedido mudou. Confira o resultado antes de preparar outra campanha.',413:'A mensagem excedeu o limite da instalação.',429:'O limite de campanhas foi atingido.',503:'As campanhas aguardam preparação da instalação.'})[status]||'O resultado não foi confirmado. Seu pedido foi preservado.',
 random:()=>[...crypto.getRandomValues(new Uint8Array(16))].map(x=>x.toString(16).padStart(2,'0')).join(''),
 invalid(){throw Error('A resposta não pôde ser confirmada.');},
 async api(url,options={}){
  const generation=this.generation,controller=this.controller;
  try{const r=await fetch(url,{...options,credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
  const data=await r.json();if(generation!==this.generation||controller!==this.controller||this.disposed||controller.signal.aborted)throw Object.assign(Error(),{name:'AbortError'});
  if(!r.ok)throw Object.assign(Error(this.error(r.status)),{status:r.status});return data;
  }catch(e){if(e.status||e.name==='AbortError'||controller.signal.aborted||generation!==this.generation||this.disposed)throw e;throw Error('A conexão falhou ou a resposta está incompleta. Seus dados continuam nesta aba. Verifique antes de reenviar.');}
 },
 headers(){return {'Content-Type':'application/json','X-CSRF-Token':this.csrf};},
 clear(){
  this.rejectedKey=null;this.user=null;this.csrf=null;this.ready=false;this.preview=null;this.pending=null;this.selected=null;this.total=0;this.page=1;
  this.el('compose').reset();this.el('preview').hidden=true;this.el('detail').hidden=true;this.el('list').replaceChildren();this.el('work').hidden=true;
  this.el('detail-text').textContent='';this.el('preview-text').textContent='';this.el('identity').textContent='';
 },
 controls(){
  this.el('refresh').disabled=this.busy;this.el('retry').hidden=!this.pending;this.el('retry').disabled=this.busy||!this.ready;
  const locked=this.busy||!this.ready||Boolean(this.pending);
  for(const id of ['title','text'])this.el(id).readOnly=locked;
  this.el('preview-button').disabled=locked;this.el('reviewed').disabled=locked;
  this.el('create').disabled=locked||!this.preview||this.preview.recipientCount===0||!this.el('reviewed').checked;
  this.el('process').disabled=locked||!this.selected||this.selected.state!=='queued'||this.selected.counts.pending===0;
  this.el('cancel').disabled=locked||!this.selected||this.selected.state!=='queued'||this.selected.counts.pending===0;
  this.el('previous').disabled=this.busy||!this.ready||this.page===1;this.el('next').disabled=this.busy||!this.ready||this.page*20>=this.total;
  this.el('work').setAttribute('aria-busy',String(this.busy));
 },
 async profile(){
  const data=await this.api('/api/auth/me');
  if(!data.user||!Number.isInteger(data.user.id)||typeof data.csrfToken!=='string'||!/^[a-f0-9]{64}$/.test(data.csrfToken))this.invalid();
  if(this.user&&this.user.id!==data.user.id){this.clear();throw Object.assign(Error('O acesso mudou em outra aba. Verifique novamente.'),{status:401});}
  this.user=data.user;this.csrf=data.csrfToken;
  if(data.user.role!=='admin')throw Object.assign(Error(this.error(403)),{status:403});
  if(data.capabilities?.campaigns!==true)throw Object.assign(Error(this.error(503)),{status:503});
  this.ready=true;this.el('identity').textContent='Administração: '+data.user.name;this.el('access').hidden=true;this.el('work').hidden=false;
 },
 valid(c){return c&&Number.isInteger(c.id)&&c.id>0&&typeof c.title==='string'&&['queued','cancelled'].includes(c.state)&&c.counts&&['pending','delivered','skipped','cancelled'].every(k=>Number.isInteger(c.counts[k])&&c.counts[k]>=0);},
 detail(c){
  if(!this.valid(c)||typeof c.text!=='string')this.invalid();this.selected=c;
  this.el('detail').hidden=false;this.el('detail-title').textContent=c.title;this.el('detail-text').textContent=c.text;
  this.el('detail-state').textContent=c.state==='cancelled'?'Entregas pendentes canceladas. Novidades já entregues continuam no portal.':(c.counts.pending?'Fila pronta para entrega.':'Fila concluída.');
  this.el('counts').replaceChildren();for(const [k,label]of Object.entries({pending:'Pendentes',delivered:'Entregues no portal',skipped:'Não elegíveis na entrega',cancelled:'Canceladas'})){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=String(c.counts[k]);this.el('counts').append(dt,dd);}
 },
 async refresh(){
  await this.profile();const data=await this.api('/api/campaigns?page='+this.page+'&limit=20');
  if(!Array.isArray(data.campaigns)||!Number.isInteger(data.total)||data.campaigns.some(c=>!this.valid(c)))this.invalid();
  this.total=data.total;this.el('list').replaceChildren();this.el('empty').hidden=data.campaigns.length>0;this.el('empty').textContent='Nenhuma campanha nesta página. Prepare uma novidade para seus inscritos.';
  for(const c of data.campaigns){const li=document.createElement('li'),button=document.createElement('button');button.type='button';button.className='conversation-select';button.textContent=c.title+' · '+c.counts.delivered+'/'+c.total+' entregues';button.addEventListener('click',()=>this.run(async()=>{const d=await this.api('/api/campaigns/'+c.id);this.detail(d.campaign);},'campaign-detail-title'));button.disabled=this.busy;li.append(button);this.el('list').append(li);}
  this.el('page').textContent='Página '+this.page+' · '+this.total+' campanhas';
  if(this.selected){const d=await this.api('/api/campaigns/'+this.selected.id);this.detail(d.campaign);}
  if(this.pending?.kind==='create'){
    try{const d=await this.api('/api/campaigns/request/'+this.pending.body.clientKey);this.detail(d.campaign);this.pending=null;this.preview=null;this.el('preview').hidden=true;this.el('compose').reset();this.el('feedback').textContent='A criação foi confirmada no servidor. A fila não foi duplicada.';}catch(e){if(e.status!==404)throw e;}
  }
 },
 async run(work,focusId){
  if(this.busy||this.disposed)return;this.busy=true;this.controller=new AbortController();const generation=this.generation,focus=document.activeElement?.id;this.controls();
  try{await work();}catch(e){if(e.name==='AbortError'||generation!==this.generation)return;
    if([401,403,503].includes(e.status)){if(e.status!==503)this.clear();this.ready=false;this.el('access').hidden=false;this.el('access-note').textContent=e.message;this.el('work').hidden=true;}
    this.el('feedback').textContent=e.message||this.error(e.status);
  }finally{if(generation===this.generation){this.busy=false;this.controls();this.el('list').querySelectorAll('button').forEach(b=>b.disabled=!this.ready);const target=document.getElementById(focusId||focus);if(target&&!target.disabled&&!target.closest('[hidden]'))target.focus();}}
 },
 send(){
  const p=this.pending;if(!p)return;
  return this.run(async()=>{
    await this.profile();
    if(p.kind==='create'){
      // A confirmed request read resolves a previously lost creation response.
      try{const d=await this.api('/api/campaigns/request/'+p.body.clientKey);this.detail(d.campaign);this.pending=null;this.preview=null;this.el('preview').hidden=true;this.el('compose').reset();this.el('feedback').textContent='Fila confirmada. Nenhuma criação foi repetida.';await this.refresh();return;}catch(e){if(e.status!==404)throw e;}
    }
    const route=p.kind==='create'?'/api/campaigns':'/api/campaigns/'+p.id+'/'+(p.kind==='batch'?'process':'cancel');
    try{
      const d=await this.api(route,{method:'POST',headers:this.headers(),body:JSON.stringify(p.body)});
      if(p.kind==='batch'&&(!d.batch||!['delivered','skipped','remaining'].every(k=>Number.isInteger(d.batch[k])&&d.batch[k]>=0)))this.invalid();
      this.detail(d.campaign);this.pending=null;
      if(p.kind==='create'){this.preview=null;this.el('preview').hidden=true;this.el('compose').reset();}
      this.el('feedback').textContent=p.kind==='create'?'Campanha adicionada à fila. Inicie a entrega quando estiver pronto.':p.kind==='batch'?'Lote confirmado: '+d.batch.delivered+' entregues, '+d.batch.skipped+' sem inscrição válida.':'Entregas pendentes canceladas.';
      await this.refresh();
    }catch(e){
      if([400,409,413,429].includes(e.status)){
        // Keep the creation key if a fresh audience review is needed. Any late
        // success is found under the same key, never a second campaign.
        if(p.kind==='create'&&e.status===409){this.preview=null;this.pending=null;this.rejectedKey=p.body.clientKey;this.el('preview').hidden=true;}
        else if(p.kind==='batch'&&e.status===409){await this.refresh();if(this.selected.state==='cancelled'||this.selected.counts.pending===0)this.pending=null;}
        else if(e.status!==409)this.pending=null;
      }
      throw e;
    }
  },'campaign-detail-title');
 }
};
campaigns.rejectedKey=null;
campaigns.el('compose').addEventListener('input',e=>{if(['campaign-title','campaign-text'].includes(e.target.id)&&!campaigns.pending){campaigns.preview=null;campaigns.el('preview').hidden=true;campaigns.controls();}});
campaigns.el('compose').addEventListener('submit',e=>{e.preventDefault();if(campaigns.pending)return;campaigns.run(async()=>{
 await campaigns.profile();
 const d=await campaigns.api('/api/campaigns/preview',{method:'POST',headers:campaigns.headers(),body:JSON.stringify({title:campaigns.el('title').value,text:campaigns.el('text').value})});
 if(typeof d.title!=='string'||typeof d.text!=='string'||!Number.isInteger(d.recipientCount)||!/^[a-f0-9]{64}$/.test(d.audienceHash))campaigns.invalid();
 campaigns.preview=Object.freeze(d);campaigns.el('preview-heading').textContent=d.title;campaigns.el('preview-text').textContent=d.text;campaigns.el('preview-audience').textContent=d.recipientCount+' pessoas com inscrição ativa nesta prévia.';campaigns.el('reviewed').checked=false;campaigns.el('preview').hidden=false;campaigns.el('feedback').textContent='Confira a prévia antes de adicionar à fila.';
},'campaign-reviewed');});
campaigns.el('reviewed').addEventListener('change',()=>campaigns.controls());
campaigns.el('create').addEventListener('click',()=>{const d=campaigns.preview;if(!d||campaigns.pending||!campaigns.el('reviewed').checked)return;campaigns.pending={kind:'create',body:Object.freeze({title:d.title,text:d.text,audienceHash:d.audienceHash,clientKey:campaigns.rejectedKey||campaigns.random()})};campaigns.rejectedKey=null;campaigns.send();});
campaigns.el('process').addEventListener('click',()=>{if(!campaigns.selected||campaigns.pending)return;campaigns.pending={kind:'batch',id:campaigns.selected.id,body:Object.freeze({clientKey:campaigns.random()})};campaigns.send();});
campaigns.el('cancel').addEventListener('click',()=>{if(!campaigns.selected||campaigns.pending)return;campaigns.pending={kind:'cancel',id:campaigns.selected.id,body:Object.freeze({})};campaigns.send();});
campaigns.el('retry').addEventListener('click',()=>campaigns.send());
campaigns.el('refresh').addEventListener('click',()=>campaigns.run(()=>campaigns.refresh()));
for(const [name,delta]of [['previous',-1],['next',1]])campaigns.el(name).addEventListener('click',()=>campaigns.run(async()=>{campaigns.page+=delta;await campaigns.refresh();}));
window.addEventListener('pagehide',()=>{campaigns.disposed=true;campaigns.generation++;campaigns.controller?.abort();campaigns.clear();});
window.addEventListener('pageshow',e=>{if(e.persisted){campaigns.disposed=false;campaigns.busy=false;campaigns.run(()=>campaigns.refresh());}});
campaigns.run(async()=>{await campaigns.refresh();campaigns.el('feedback').textContent='Prepare uma novidade ou acompanhe sua fila.';});
