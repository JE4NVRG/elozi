import { t as i18nT, html as i18nHtml, txt as i18nTxt, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError } from './i18n.js';
import './locales-management.js';
import './locales-settings.js';
const identifier=()=>crypto.randomUUID();
export function createAccountInvitationsUI({state,api,escape:e,openModal,getModal,toast,onUpdate}) {
  let selected=null,selectedKey=null,intent=null,generation=0,busy=false,link='',invitations=[];
  const context=()=>JSON.stringify([state.workspaceId,state.boot?.session.userId,state.supportGrantId||null,state.boot?.session.platformOwner,state.boot?.session.role,state.boot?.csrfToken||state.boot?.session.csrfToken]);
  const current=(value,key)=>value===generation&&key===context()&&state.boot?.session.role==='reseller'&&!state.supportGrantId;
  const owned=value=>Boolean(getModal().open&&getModal().querySelector(`[data-account-invitation-owner="${value}"]`));
  const show=(title,intro,html)=>openModal(title,intro,i18nHtml`<div data-account-invitation-owner="${generation}">${html}</div>`);
  const path=()=>`/api/accounts/${encodeURIComponent(selected.id)}/invitations`;
  async function open(account){
    reset();selected=account;const value=generation,key=context();selectedKey=key;
    show(i18nT('Responsável pela conta'),account.name,i18nMarkup('<div class="pg-settings__dialog" role="status"><p class="pg-settings__muted">Carregando convites…</p></div>'));
    try{
      const data=await api(path(),{signal:AbortSignal.timeout(20000)});
      if(!current(value,key)||!owned(value))return;
      invitations=data.invitations||[];
      show(i18nT('Responsável pela conta'),i18nTxt`${account.name} · O convite dá administração somente a esta conta.`,
        i18nHtml`<div class="pg-settings__dialog"><form data-account-invitation-form class="pg-settings__form"><label class="pg-settings__field">Nome (opcional)<input class="pg-settings__input" name="name" maxlength="80"></label><label class="pg-settings__field">E-mail (opcional para convite por link)<input class="pg-settings__input" name="email" type="email" maxlength="254" autocomplete="off"></label><label class="pg-settings__field">Validade<select class="pg-settings__input" name="expiresInHours"><option value="24">24 horas</option><option value="72" selected>3 dias</option><option value="168">7 dias</option></select></label><label class="pg-settings__check"><input type="checkbox" name="sendEmail" ${data.emailConfigured?'':'disabled'}>Enviar pelo MepMail</label><p class="pg-settings__muted">A pessoa escolhe a própria senha. O convite permite administrar somente a conta escolhida e não concede acesso a outras contas.</p><p class="form-error pg-settings__error" role="alert"></p><div class="pg-settings__dialog-actions"><button class="ui-btn ui-btn--secondary ui-btn--md" type="button" data-close-modal><span class="ui-btn__label">Cancelar</span></button><button class="ui-btn ui-btn--primary ui-btn--md" type="submit"><span class="ui-btn__label">Criar convite do responsável</span></button></div></form><section class="pg-settings__stack" aria-label="Convites desta conta"><h3 class="pg-settings__h3">Convites desta conta</h3><ul class="pg-settings__list">${(data.invitations||[]).map(invite=>i18nHtml`<li class="pg-settings__item"><span class="pg-settings__item-main"><strong class="pg-settings__strong">${e(invite.name||invite.email||i18nT('Convite por link'))}</strong><span class="pg-settings__sub">${e({pending:i18nT('Pendente'),accepted:i18nT('Aceito'),revoked:i18nT('Revogado'),expired:i18nT('Expirado')}[invite.state]||invite.state)} · ${e(new Date(invite.expiresAt).toLocaleString(getLocale()))}</span></span>${invite.canRevoke?i18nHtml`<button type="button" class="ui-btn ui-btn--danger ui-btn--sm" data-account-invitation-action="revoke" data-id="${e(invite.id)}"><span class="ui-btn__label">Revogar</span></button>`:''}</li>`).join('')||i18nMarkup('<li class="pg-settings__item"><span class="pg-settings__muted">Nenhum convite criado.</span></li>')}</ul></section></div>`);
    }catch(error){if(current(value,key)&&owned(value))show(i18nT('Responsável pela conta'),account.name,i18nHtml`<div class="pg-settings__dialog"><p class="pg-settings__error" role="alert">${e(translateError(error.message))}</p><div class="pg-settings__dialog-actions"><button class="ui-btn ui-btn--secondary ui-btn--md" data-close-modal><span class="ui-btn__label">Fechar</span></button></div></div>`);}
  }
  async function send(form){
    if(busy||!selected)return;
    const value=generation,key=selectedKey;if(!current(value,key)||!owned(value)||form&&(!form.isConnected||!getModal().contains(form)))return;
    if(!intent){const data=new FormData(form);intent={requestId:identifier(),name:String(data.get('name')||'').trim(),email:String(data.get('email')||'').trim(),expiresInHours:Number(data.get('expiresInHours')),sendEmail:data.get('sendEmail')==='on',role:'reseller',tenantIds:[]};}
    busy=true;form?.setAttribute('aria-busy','true');const submit=form?.querySelector('[type="submit"]');if(submit)submit.disabled=true;
    try{
      const result=await api(path(),{method:'POST',body:JSON.stringify(intent),signal:AbortSignal.timeout(20000)});
      if(!current(value,key)||!owned(value))return;
      const url=new URL(result.inviteUrl),allowed=[location.origin,state.boot.publicOrigin].filter(Boolean);
      if(!allowed.includes(url.origin)||url.username||url.password||url.search||url.pathname!=='/accept-invite'||!/^#token=[A-Za-z0-9_-]{43}$/.test(url.hash)||typeof result.invitation?.id!=='string'||!/^[A-Za-z0-9_-]{1,120}$/.test(result.invitation.id)||typeof result.invitation.expiresAt!=='string'||!Number.isFinite(Date.parse(result.invitation.expiresAt)))throw new Error('O convite não foi confirmado. Verifique a mesma solicitação.');
      intent=null;link=url.href;
      show(i18nT('Convite do responsável pronto'),selected.name,i18nHtml`<div class="pg-settings__dialog"><p class="pg-settings__text">${result.email?.queued?i18nT('Convite colocado na fila do MepMail.'):i18nT('Compartilhe este link com o responsável pela conta.')}</p><label class="pg-settings__field">Link de uso único<input class="pg-settings__input" readonly autocomplete="off" aria-label="Link de convite do responsável" value="${e(link)}" data-account-invitation-link></label><p class="pg-settings__muted">Válido até ${e(new Date(result.invitation.expiresAt).toLocaleString(getLocale()))}. O aceite habilita o painel desta conta.</p><div class="pg-settings__dialog-actions"><button type="button" class="ui-btn ui-btn--secondary ui-btn--md" data-account-invitation-action="copy"><span class="ui-btn__label">Copiar link</span></button><button class="ui-btn ui-btn--primary ui-btn--md" type="button" data-close-modal><span class="ui-btn__label">Concluir</span></button></div></div>`);onUpdate?.();
    }catch(error){
      if(!current(value,key)||!owned(value))return;
      if([400,401,403,404,409,422,429].includes(error.status)){intent=null;if([401,403].includes(error.status)){show(i18nT('Acesso indisponível'),'',i18nHtml`<div class="pg-settings__dialog"><p class="pg-settings__error" role="alert">${e(translateError(error.message))}</p><div class="pg-settings__dialog-actions"><button class="ui-btn ui-btn--secondary ui-btn--md" data-close-modal><span class="ui-btn__label">Fechar</span></button></div></div>`);selected=null;link='';}else if(form?.isConnected)form.querySelector('.form-error').textContent=translateError(error.message);else show(i18nT('Convite indisponível'),selected.name,i18nHtml`<div class="pg-settings__dialog"><p class="pg-settings__error" role="alert">${e(translateError(error.message))}</p><div class="pg-settings__dialog-actions"><button class="ui-btn ui-btn--secondary ui-btn--md" data-close-modal><span class="ui-btn__label">Fechar</span></button></div></div>`);}
      else{show(i18nT('Verificar convite'),selected.name,i18nHtml`<div class="pg-settings__dialog"><p class="pg-settings__error" role="alert">A criação ainda não foi confirmada. Verifique a mesma solicitação antes de criar outro convite.</p><div class="pg-settings__dialog-actions"><button class="ui-btn ui-btn--secondary ui-btn--md" data-close-modal><span class="ui-btn__label">Fechar</span></button><button class="ui-btn ui-btn--primary ui-btn--md" data-account-invitation-action="verify"><span class="ui-btn__label">Verificar convite</span></button></div></div>`);}
    }finally{if(value===generation)busy=false;if(form?.isConnected){form.removeAttribute('aria-busy');if(submit)submit.disabled=false;}}
  }
  async function handleAction(node){
    const action=node.dataset.accountInvitationAction;
    if(!current(generation,selectedKey)||!owned(generation)||!getModal().contains(node))return;
    if(action==='copy'&&link){await navigator.clipboard.writeText(link);toast(i18nT('Link copiado.'));return;}
    if(action==='verify'&&intent){await send(null);return;}
    if(action==='revoke'&&!busy&&selected&&invitations.some(invite=>invite.id===node.dataset.id&&invite.canRevoke)){const value=generation,key=context();busy=true;try{await api(`${path()}/${encodeURIComponent(node.dataset.id)}/revoke`,{method:'POST',body:'{}'});if(current(value,key)&&owned(value)){const account=selected;await open(account);toast(i18nT('Convite revogado.'));onUpdate?.();}}catch(error){if(current(value,key)&&owned(value))toast(translateError(error.message),true);}finally{if(value===generation)busy=false;}}
  }
  function reset(){const field=getModal()?.querySelector('[data-account-invitation-link]') || getModal()?.querySelector('[aria-label="Link de convite do responsável"]');if(field){field.value='';field.removeAttribute('value');}generation++;selected=null;selectedKey=null;intent=null;busy=false;link='';invitations=[];}
  return {open,submit:send,handleAction,reset};
}
