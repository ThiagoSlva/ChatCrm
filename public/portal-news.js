'use strict';

const portalNews={
 page:1,total:0,loaded:false,items:new Map(),
 el:id=>document.getElementById('portal-news-'+id),
 clear(){this.page=1;this.total=0;this.loaded=false;this.items.clear();this.el('list').replaceChildren();this.el('status').textContent='Verificando novidades…';},
 controls(){const lock=portal.busy||!portal.ready||!portal.confirmed||!this.loaded;this.el('refresh').disabled=portal.busy||!portal.account;this.el('previous').disabled=lock||!this.loaded||this.page===1;this.el('next').disabled=lock||!this.loaded||this.page*20>=this.total;for(const item of this.items.values())item.button.disabled=lock||Boolean(item.readAt);},
 valid(x){return x&&Number.isInteger(x.id)&&x.id>0&&typeof x.title==='string'&&x.title.length<=120&&typeof x.text==='string'&&x.text.length<=4000&&typeof x.deliveredAt==='string'&&(x.readAt===null||typeof x.readAt==='string');},
 async refresh(){
  try{
   const data=await portal.api('/api/portal/news?page='+this.page+'&limit=20');
   if(!Array.isArray(data.news)||data.news.some(x=>!this.valid(x))||!Number.isInteger(data.total)||data.total<0)portal.invalid();
   this.total=data.total;this.loaded=true;const present=new Set();
   for(const news of data.news){
    present.add(news.id);let item=this.items.get(news.id);
    if(!item){const li=document.createElement('li'),heading=document.createElement('h3'),text=document.createElement('p'),status=document.createElement('p'),button=document.createElement('button');
     li.className='portal-news-item';text.className='campaign-message';status.className='field-note';button.type='button';button.id='portal-news-read-'+news.id;button.textContent='Marcar como lida';
     button.addEventListener('click',()=>portal.run(async()=>{await portal.revalidate();const result=await portal.api('/api/portal/news/'+news.id+'/read',{method:'POST',headers:portal.headers(),body:'{}'});if(result.read!==true)portal.invalid();await this.refresh();},false,'portal-news-refresh'));
     li.append(heading,text,status,button);item={li,heading,text,status,button,readAt:null};this.items.set(news.id,item);
    }
    item.heading.textContent=news.title;item.text.textContent=news.text;item.readAt=news.readAt;item.status.textContent=news.readAt?'Marcada como lida pela sua conta.':'Novidade entregue no seu portal.';item.button.hidden=Boolean(news.readAt);
    if(item.li.parentNode!==this.el('list'))this.el('list').append(item.li);
   }
   for(const [id,item]of this.items)if(!present.has(id)){item.li.remove();this.items.delete(id);}
   // Append existing nodes in server order; keeps their identity and drafts elsewhere.
   const active=document.activeElement;
   data.news.forEach((news,i)=>{const node=this.items.get(news.id).li;if(this.el('list').children[i]!==node)this.el('list').insertBefore(node,this.el('list').children[i]||null);});
   if(active?.id&&present.size&&this.el('list').contains(active)&&!active.disabled)active.focus();
   this.el('status').textContent=this.total?'Página '+this.page+' · '+this.total+' novidades.':'Nenhuma novidade recebida. Seus atendimentos continuam disponíveis.';
  }catch(e){this.loaded=false;if(e.status===401)throw e;this.el('status').textContent=e.status===503?'A caixa de novidades estará disponível após a preparação pela empresa.':'Não foi possível verificar as novidades. Use Atualizar novidades para conferir novamente.';}
  this.controls();
 }
};
portalNews.el('refresh').addEventListener('click',()=>portal.run(async()=>{await portal.revalidate();await portalNews.refresh();},false,'portal-news-refresh'));
for(const [name,delta]of [['previous',-1],['next',1]])portalNews.el(name).addEventListener('click',()=>portal.run(async()=>{portalNews.page+=delta;await portal.revalidate();await portalNews.refresh();},false,'portal-news-refresh'));
