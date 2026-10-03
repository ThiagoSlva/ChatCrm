'use strict';
const portal = {
 account:null,csrf:null,ready:false,confirmed:false,busy:false,generation:0,controller:null,timer:null,disposed:false,automatic:false,pane:'login',kits:{register:null,recover:null},
 el:id=>document.getElementById('portal-'+id),
 error(status){return ({400:'Confira os dados informados.',401:'Acesso ou credencial inválidos. Entre novamente.',403:'Ação não autorizada.',404:'Atendimento ou área indisponível. Seu texto foi preservado.',409:'O acesso ou atendimento mudou. Verifique antes de continuar.',429:'Muitas tentativas. Aguarde antes de tentar novamente.',503:'O portal aguarda preparação pela empresa.'})[status]||'Não foi possível confirmar a operação.';},
 invalid(){throw new Error('Resposta incompleta. Verifique seu acesso antes de continuar.');},
 async api(url,options={}){
  const generation=this.generation,controller=this.controller;
  const response=await fetch(url,{...options,credentials:'same-origin',cache:'no-store',signal:AbortSignal.any([controller.signal,AbortSignal.timeout(10000)])});
  const data=await response.json();
  if(generation!==this.generation||controller!==this.controller||controller.signal.aborted||this.disposed){const e=new Error();e.name='AbortError';throw e;}
  if(!response.ok){const e=new Error(this.error(response.status));e.status=response.status;throw e;}return data;
 },
 headers(csrf=this.csrf){return {'Content-Type':'application/json','X-CSRF-Token':csrf};},
 random(size){return [...crypto.getRandomValues(new Uint8Array(size))].map(v=>v.toString(16).padStart(2,'0')).join('');},
 controls(){
  document.querySelectorAll('.portal-main button,.portal-main input,.portal-main select').forEach(el=>{el.disabled=this.busy||!this.ready;});this.el('refresh').disabled=this.busy;
  for(const kind of ['register','recover']){const kit=this.kits[kind];for(const field of (kind==='register'?['password','confirmation']:['id','code','password','confirmation']))this.el(kind+'-'+field).readOnly=Boolean(kit);
   this.el(kind+'-prepare').disabled=this.busy||!this.ready||Boolean(kit?.attempted);this.el(kind+'-prepare').textContent=kit?'Revisar dados preparados':(kind==='register'?'Preparar meu acesso':'Preparar novo código');
   this.el(kind+'-submit').disabled=this.busy||!this.ready||!kit||Boolean(kit.attempted);
  }this.el('space').setAttribute('aria-busy',String(this.busy));if(typeof portalChat!=='undefined')portalChat.controls();if(typeof portalSubscription!=='undefined')portalSubscription.controls();
 },
 paneShow(kind){this.pane=kind;for(const name of ['login','register','recover']){this.el(name).hidden=name!==kind;this.el('tab-'+name).setAttribute('aria-pressed',String(name===kind));}},
 clearIdentity(){this.account=null;this.csrf=null;this.confirmed=false;this.el('space').hidden=true;this.el('name').textContent='';this.el('access-id').textContent='';if(typeof portalChat!=='undefined')portalChat.clear();if(typeof portalSubscription!=='undefined')portalSubscription.clear();},
 eraseKits(kinds=['register','recover']){for(const kind of kinds){this.kits[kind]=null;this.el(kind).reset();this.el(kind+'-kit').hidden=true;this.el(kind+'-access').textContent='';this.el(kind==='register'?'register-code':'recover-new-code').textContent='';}this.el('login-password').value='';},
 async profile(){
  const data=await this.api('/api/portal/me');if(!data.account||typeof data.account.name!=='string'||data.account.name.length>100||typeof data.account.accessId!=='string'||typeof data.csrfToken!=='string'||!/^[a-f0-9]{24}$/.test(data.account.accessId||'')||!/^[a-f0-9]{64}$/.test(data.csrfToken||''))this.invalid();
  if(this.account?.accessId!==data.account.accessId)this.clearIdentity();this.account=data.account;this.csrf=data.csrfToken;this.confirmed=true;this.ready=true;
  if(typeof portalSubscription!=='undefined')await portalSubscription.refresh();
  this.el('name').textContent=data.account.name;this.el('access-id').textContent='Identificador: '+data.account.accessId;this.el('auth').hidden=true;this.el('space').hidden=false;
  const registration=this.kits.register, recovery=this.kits.recover;
  if(registration?.payload.accessId===data.account.accessId)this.eraseKits(['register']);if(recovery?.confirmed&&recovery.payload.accessId===data.account.accessId)this.eraseKits(['recover']);return data;
 },
 async revalidate(){const expected=this.account?.accessId;await this.profile();if(expected!==this.account.accessId){const e=new Error('Seu acesso mudou em outra aba. Verifique antes de continuar.');e.status=401;throw e;}},
 schedule(delay=5000){clearTimeout(this.timer);if(!this.account||this.disposed||document.hidden||this.busy||!this.ready)return;this.timer=setTimeout(()=>this.run(async()=>{await this.profile();await portalChat.refresh();},true),delay);},
 async run(work,automatic=false,focusId=null){
  if(this.busy||this.disposed||(automatic&&document.hidden))return;clearTimeout(this.timer);this.busy=true;this.automatic=automatic;this.controller=new AbortController();const generation=this.generation,focus=document.activeElement?.id;this.controls();let failed=false;
  try{await work();}catch(e){if(generation!==this.generation||this.disposed||(automatic&&e.name==='AbortError'))return;failed=true;if(this.account){this.confirmed=false;if(e.status===401){this.clearIdentity();this.el('auth').hidden=false;this.paneShow('login');}}if(e.status===503)this.ready=false;this.el('feedback').textContent=e.status?e.message:(e.message||'A conexão falhou. A operação não foi confirmada.');}
  finally{if(generation===this.generation){this.busy=false;this.automatic=false;this.controls();if(!automatic){const target=document.getElementById(focusId||focus);if(target&&!target.disabled&&!target.closest('[hidden]'))target.focus();}this.schedule(failed?15000:5000);}}
 },
 initialize(){return this.run(async()=>{this.confirmed=false;this.el('space').hidden=true;this.el('auth').hidden=true;this.el('feedback').textContent='Verificando seu acesso…';try{await this.profile();await portalChat.refresh();this.el('feedback').textContent='Seu histórico está disponível.';}catch(e){if(e.status!==401)throw e;this.clearIdentity();this.ready=true;this.el('auth').hidden=false;this.paneShow(this.pane);this.el('feedback').textContent='Entre no portal ou crie acesso a partir do seu visitante atual.';}});},
 fields(kind){const values={};for(const id of (kind==='register'?['password','confirmation']:['id','code','password','confirmation'])){const el=this.el(kind+'-'+id);if(!el.checkValidity()){el.reportValidity();return null;}values[id]=el.value;}if(values.password!==values.confirmation){this.el('feedback').textContent='As senhas devem ser iguais.';this.el(kind+'-confirmation').focus();return null;}return values;},
 download(kind){const kit=this.kits[kind];if(!kit)return;const code=kind==='register'?kit.payload.recoveryCode:kit.payload.newRecoveryCode;const data='Conversa Livre — acesso ao portal\nSite: '+location.origin+'/portal\nIdentificador: '+kit.payload.accessId+'\nCódigo de recuperação: '+code+'\nGuarde em lugar privado. Quem possui este código pode trocar sua senha.\n';const url=URL.createObjectURL(new Blob([data],{type:'text/plain;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='meu-acesso-conversa-livre.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);},
 async prepare(kind){
  const current=this.kits[kind];if(current){if(current.attempted)return;this.kits[kind]=null;this.el(kind+'-kit').hidden=true;this.controls();this.el(kind+'-password').focus();return;}const values=this.fields(kind);if(!values)return;
  await this.run(async()=>{let payload,csrf;
   if(kind==='register'){let guest;try{guest=await this.api('/api/chat/visitor/me');}catch(e){if(e.status===401){this.el('guest-note').textContent='Você precisa de uma sessão atual em Novo visitante para guardar esse histórico.';return;}throw e;}if(!guest.visitor||typeof guest.visitor.name!=='string'||!/^[a-f0-9]{64}$/.test(guest.csrfToken||''))this.invalid();csrf=guest.csrfToken;this.el('guest-note').textContent='Você guardará o histórico do visitante: '+guest.visitor.name+'.';payload={accessId:this.random(12),password:values.password,confirmation:values.confirmation,recoveryCode:this.random(32)};
   }else{let code;do{code=this.random(32);}while(code===values.code);payload={accessId:values.id,recoveryCode:values.code,newPassword:values.password,confirmation:values.confirmation,newRecoveryCode:code};}
   this.kits[kind]={payload:Object.freeze(payload),csrf,attempted:false};this.el(kind+'-saved').checked=false;this.el(kind+'-access').textContent=payload.accessId;this.el(kind==='register'?'register-code':'recover-new-code').textContent=kind==='register'?payload.recoveryCode:payload.newRecoveryCode;this.el(kind+'-kit').hidden=false;this.el('feedback').textContent='Guarde os dados de acesso antes de confirmar.';
  },false,'portal-'+kind+'-download');
 },
 submitKit(kind){const kit=this.kits[kind];if(!kit||kit.attempted||!this.el(kind+'-saved').checked)return;
  return this.run(async()=>{kit.attempted=true;try{const data=await this.api('/api/portal/'+(kind==='register'?'register':'recover'),{method:'POST',headers:this.headers(kit.csrf),body:JSON.stringify(kit.payload)});if(kind==='register'?data.created!==true||data.account?.accessId!==kit.payload.accessId:data.recovered!==true||data.authenticated!==false)this.invalid();if(kind==='recover'){kit.confirmed=true;this.clearIdentity();}this.el('feedback').textContent=kind==='register'?'Acesso criado. Entre com o identificador guardado e sua senha.':'Recuperação confirmada. Use a nova senha; o código anterior e as sessões antigas foram encerrados.';
   }catch(e){if([400,401,403,429].includes(e.status)){kit.attempted=false;throw e;}this.el('feedback').textContent='O resultado não foi confirmado. Seus dados preparados continuam nesta aba. Entre com o identificador e a '+(kind==='register'?'senha preparada':'nova senha')+' para verificar. Não repita esta operação.';}
   this.el('login-id').value=kit.payload.accessId;this.el('login-password').value='';this.paneShow('login');
  },false,'portal-login-password');
 }
};
for(const kind of ['login','register','recover'])portal.el('tab-'+kind).addEventListener('click',()=>{portal.paneShow(kind);portal.el('feedback').textContent='';});
for(const kind of ['register','recover']){portal.el(kind+'-prepare').addEventListener('click',()=>portal.prepare(kind));portal.el(kind+'-download').addEventListener('click',()=>portal.download(kind));portal.el(kind).addEventListener('submit',e=>{e.preventDefault();portal.submitKit(kind);});}
portal.el('login').addEventListener('submit',e=>{e.preventDefault();const body={accessId:portal.el('login-id').value,password:portal.el('login-password').value};portal.run(async()=>{
 // Confirm a potentially lost login response before requesting another session.
 try{await portal.profile();}catch(error){if(error.status!==401)throw error;const data=await portal.api('/api/portal/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});if(data.authenticated!==true)portal.invalid();const recovery=portal.kits.recover;if(recovery?.attempted&&recovery.payload.accessId===body.accessId&&recovery.payload.newPassword===body.password)recovery.confirmed=true;await portal.profile();}
 await portalChat.refresh();portal.el('login-password').value='';portal.el('feedback').textContent=portal.account.accessId===body.accessId?'Seu histórico está disponível.':'Outro acesso já estava aberto neste navegador. Saia dele antes de entrar com outro identificador.';if(portal.kits.recover?.attempted&&!portal.kits.recover.confirmed)portal.el('feedback').textContent='Seu histórico está disponível, mas a recuperação ainda não foi confirmada com a nova senha. O novo código preparado permanece nesta aba.';
},false,'portal-conversation-title');});
portal.el('logout').addEventListener('click',()=>portal.run(async()=>{const data=await portal.api('/api/portal/logout',{method:'POST',headers:portal.headers(),body:'{}'});if(data.authenticated!==false)portal.invalid();portal.clearIdentity();portal.eraseKits();portal.el('auth').hidden=false;portal.paneShow('login');portal.el('feedback').textContent='Você saiu do portal. Seu histórico continua guardado.';},false,'portal-login-id'));
portal.el('refresh').addEventListener('click',()=>portal.initialize());
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(portal.timer);if(portal.automatic)portal.controller?.abort();}else portal.schedule(0);});
window.addEventListener('pagehide',()=>{portal.disposed=true;portal.generation++;clearTimeout(portal.timer);portal.controller?.abort();portal.clearIdentity();portal.eraseKits();});
window.addEventListener('pageshow',e=>{if(e.persisted){portal.disposed=false;portal.busy=false;portal.initialize();}});
