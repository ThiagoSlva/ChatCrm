'use strict';
const portalSubscription={
 value:null,pending:null,loaded:false,
 el:id=>document.getElementById('portal-subscription-'+id),
 clear(){this.value=null;this.pending=null;this.loaded=false;this.el('feedback').textContent='';this.el('status').textContent='Verificando sua escolha…';},
 valid(p){return p&&typeof p.subscribed==='boolean'&&Number.isInteger(p.version)&&p.version>=0&&p.version<=4294967295&&p.noticeVersion==='portal-news-v1'&&(p.updatedAt===null||typeof p.updatedAt==='string');},
 controls(){const locked=portal.busy||!portal.ready||!portal.confirmed||!this.loaded||Boolean(this.pending);this.el('join').disabled=locked||this.value?.subscribed===true;this.el('leave').disabled=locked||this.value?.subscribed!==true;this.el('verify').disabled=portal.busy||!portal.account;this.el('retry').hidden=!this.pending||!this.loaded;this.el('retry').disabled=portal.busy||!portal.confirmed||!this.loaded;},
 render(){this.el('status').textContent=this.value?.subscribed?'Inscrição ativa. Você escolheu receber novidades no portal.':'Você não está inscrito. Seus atendimentos continuam disponíveis.';this.controls();},
 async refresh(){
  try{const data=await portal.api('/api/portal/subscription');if(!this.valid(data.preference)||typeof data.notice!=='string')portal.invalid();
   this.value=data.preference;this.loaded=true;
   if(this.pending){const pending=this.pending;if(data.preference.version===pending.body.version&&data.preference.subscribed!==pending.body.subscribed){this.el('status').textContent='A alteração não foi confirmada. Você pode reenviar a mesma escolha.';return;}
    this.pending=null;this.el('feedback').textContent='Escolha atual conferida no servidor. Verifique o estado exibido antes de alterar novamente.';
   }this.render();
  }catch(e){if(e.status===503){this.loaded=false;this.el('status').textContent='As preferências de novidades estarão disponíveis após a preparação pela empresa.';return;}throw e;}
 },
 choose(subscribed){
  if(!this.loaded||!this.value||this.pending)return;
  const pending={body:Object.freeze({subscribed,version:this.value.version,noticeVersion:'portal-news-v1',clientKey:portal.random(16)})};this.pending=pending;return this.send();
 },
 send(){const pending=this.pending;if(!pending)return;return portal.run(async()=>{
  await portal.revalidate();
  try{const data=await portal.api('/api/portal/subscription',{method:'POST',headers:portal.headers(),body:JSON.stringify(pending.body)});
   if(!this.valid(data.preference)||typeof data.replayed!=='boolean'||typeof data.changed!=='boolean')portal.invalid();this.value=data.preference;this.pending=null;this.loaded=true;this.render();this.el('feedback').textContent=this.value.subscribed?'Inscrição confirmada. Você pode cancelar quando quiser.':'Descadastro confirmado. Seus atendimentos foram preservados.';
  }catch(e){if([400,401,403,409,429,503].includes(e.status)){this.pending=null;if(e.status===409){await this.refresh();this.el('feedback').textContent='Sua escolha mudou em outra aba. Confira o estado atual e escolha novamente.';return;}throw e;}
   this.loaded=false;this.el('status').textContent='Não foi possível confirmar sua escolha. Verifique antes de repetir.';this.el('feedback').textContent='A alteração pode ter sido recebida. Use Verificar escolha; nenhuma inscrição será feita automaticamente.';
  }
 },false,'portal-subscription-verify');}
};
portalSubscription.el('join').addEventListener('click',()=>portalSubscription.choose(true));
portalSubscription.el('leave').addEventListener('click',()=>portalSubscription.choose(false));
portalSubscription.el('verify').addEventListener('click',()=>portal.run(async()=>{await portal.revalidate();await portalSubscription.refresh();},false,'portal-subscription-verify'));
portalSubscription.el('retry').addEventListener('click',()=>portalSubscription.send());
