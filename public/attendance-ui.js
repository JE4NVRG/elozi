import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError} from './i18n.js';
import './locales-operations.js';

// Helpers receive only the current, authorized workspace snapshot.
export const normalizeAttendanceSearch = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const timestamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
export function selectAttendance(conversations, {userId,filter='all',channel='all',status='active',unread=false,department='all',kind='all',sort='recent',search='',contacts=[]}={}) {
 const query=normalizeAttendanceSearch(search),records=new Map(contacts.map(c=>[c.id,c]));
 const items=(Array.isArray(conversations)?conversations:[]).filter(c=>{
  if(filter==='mine'&&c.assignedUserId!==userId||filter==='queue'&&(c.assignedUserId||c.owner==='agent')||filter==='agent'&&c.owner!=='agent')return false;
  if(channel!=='all'&&c.channelId!==channel||status==='active'&&c.status==='closed'||!['all','active'].includes(status)&&c.status!==status)return false;
  if(unread&&!c.unread||department!=='all'&&(c.departmentId||'unassigned')!==department||kind==='group'&&c.conversationKind!=='group'||kind==='direct'&&c.conversationKind==='group')return false;
  if(!query)return true;
  const contact=c.contactId?records.get(c.contactId):null;
  const fields=[c.contact,c.department,...(c.tags||[]),contact?.phone,contact?.email,...(c.messages||[]).flatMap(m=>[m.text,m.authorName,m.senderName,...(m.attachments||[]).map(a=>a.name)])];
  return normalizeAttendanceSearch(fields.filter(Boolean).join(' ')).includes(query);
 });
 return items.sort((a,b)=>sort==='unread'&&(Boolean(a.unread)!==Boolean(b.unread))?Number(Boolean(b.unread))-Number(Boolean(a.unread)):((sort==='oldest'?1:-1)*(timestamp(a.updatedAt)-timestamp(b.updatedAt))||String(a.id).localeCompare(String(b.id))));
}
export function attendanceCounts(conversations,userId) {
 const items=Array.isArray(conversations)?conversations:[],active=items.filter(c=>c.status!=='closed');
 return {all:items.length,active:active.length,mine:active.filter(c=>c.assignedUserId===userId).length,queue:active.filter(c=>!c.assignedUserId&&c.owner!=='agent').length,agent:active.filter(c=>c.owner==='agent').length,unread:active.filter(c=>c.unread).length,closed:items.length-active.length};
}
export function attendanceHistory(conversation,{escape,icon}={}) {
 const names=i18nLabels({open:'Aberta',pending:'Pendente',closed:'Encerrada'});
 const events=(conversation?.attendantEvents||[]).filter(e=>['closed','reopened','status'].includes(e.type)).slice().sort((a,b)=>timestamp(b.createdAt)-timestamp(a.createdAt));
 return i18nHtml`<details class="attendance-history"><summary>${icon('clock')} Histórico do atendimento <span>${events.length}</span></summary><ol>${events.map(e=>`<li><strong>${escape(e.type==='closed'?i18nText('Atendimento encerrado'):e.type==='reopened'?i18nText('Atendimento reaberto'):'Status: '+(names[e.to?.status]||i18nText('Atualizado')))}</strong><small>${escape(e.actorName||i18nText('Equipe'))} · ${escape(new Date(e.createdAt).toLocaleString(getLocale()))}</small>${e.reason?'<p>'+escape(e.reason)+'</p>':''}</li>`).join('')||i18nMarkup('<li>Nenhuma mudança de status registrada.</li>')}</ol><small>Transferências e notas aparecem na conversa.</small></details>`;
}
export function createInternalNoteDrafts({limit=40,now=Date.now,storage=()=>globalThis.sessionStorage}={}) {
 const drafts=new Map(),storageKey='elozi:internal-note-drafts:v1',ttl=24*60*60*1000;
 let scope='',key='',tenant='',identity=null,loaded=false,persistent=false;
 const draftKey=()=>JSON.stringify([tenant,key]);
 const erase=()=>{try{storage()?.removeItem(storageKey);}catch{}persistent=false;};
 const persist=()=>{
  if(!identity)return false;
  try{
   const target=storage();if(!target)return persistent=false;
   if(!drafts.size)target.removeItem(storageKey);
   else target.setItem(storageKey,JSON.stringify({v:1,identity,entries:[...drafts]}));
   return persistent=true;
  }catch{return persistent=false;}
 };
 const prune=()=>{for(const [id,item]of drafts)if(!Number.isFinite(item.at)||item.at>now()||now()-item.at>=ttl)drafts.delete(id);};
 return {
  sync({workspaceId,tenantId,userId,authorityKey,persistenceKey,conversationId,active,allowedIds=[]}={}){
   const next=JSON.stringify([userId||null,workspaceId||null,authorityKey||null]);
   if(next!==scope){if(scope)erase();drafts.clear();scope=next;loaded=false;persistent=false;}
   // persistenceKey contains only public permission/scope metadata, NEVER CSRF or tokens.
   const nextIdentity=typeof persistenceKey==='string'&&persistenceKey&&typeof userId==='string'&&userId&&typeof workspaceId==='string'&&workspaceId?JSON.stringify([userId,workspaceId,persistenceKey]):null;
   if(identity!==nextIdentity){if(identity)erase();drafts.clear();loaded=false;identity=nextIdentity;}
   tenant=typeof tenantId==='string'?tenantId:'';
   const ids=new Set(allowedIds);
   key=active&&typeof userId==='string'&&userId&&typeof workspaceId==='string'&&workspaceId&&tenant&&typeof conversationId==='string'&&ids.has(conversationId)?conversationId:'';
   if(!loaded&&(key||identity&&tenant&&active&&typeof conversationId==='string'&&conversationId)){
    loaded=true;
    if(identity)try{
     const raw=storage()?.getItem(storageKey);
     if(raw&&raw.length<=200000){
      const saved=JSON.parse(raw);
      if(saved?.v===1&&saved.identity===identity&&Array.isArray(saved.entries)&&saved.entries.length<=limit){
       for(const row of saved.entries){
        if(!Array.isArray(row)||row.length!==2||typeof row[0]!=='string')continue;
        let pair;try{pair=JSON.parse(row[0]);}catch{continue;}
        const item=row[1];
        if(!Array.isArray(pair)||pair.length!==2||pair.some(x=>typeof x!=='string'||!x)||typeof item?.text!=='string'||!item.text||item.text.length>2000||!Number.isFinite(item.at))continue;
        drafts.set(row[0],{text:item.text,at:item.at});
       }
      }else erase();
     }else if(raw)erase();
    }catch{erase();}
   }
   prune();
   // Only this company's authorized snapshot can revoke its stored notes.
   for(const cached of drafts.keys()){const [owner,id]=JSON.parse(cached);if(owner===tenant&&!ids.has(id))drafts.delete(cached);}
   if(loaded&&identity)persist();
   return key;
  },
  save(value){
   if(!key)return false;prune();const cached=draftKey();value=String(value||'');
   if(!value){drafts.delete(cached);persist();return true;}
   if(!drafts.has(cached)&&drafts.size>=limit)return false;
   drafts.set(cached,{text:value.slice(0,2000),at:now()});persist();return true;
  },
  clear(){if(key){drafts.delete(draftKey());persist();}},
  reset(){erase();drafts.clear();scope='';key='';tenant='';identity=null;loaded=false;},
  get value(){prune();return key?drafts.get(draftKey())?.text||'':'';},get key(){return key;},get count(){prune();return drafts.size;},get persistent(){return persistent;}
 };
}
