import { t as i18nT, html as i18nHtml, txt as i18nTxt, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError } from './i18n.js';
import './locales-management.js';
import './locales-settings.js';
export function createAccountSecurityUI(ctx) {
  const {state,escape:e,icon,api,toast}=ctx;
  let revision=0,sessionRevision=0,rendered=null,passwordBusy=false,sessionsBusy=false;
  const context=()=>JSON.stringify([state.account?.user?.id||state.boot?.session?.userId||'',state.workspaceId||'',state.boot?.csrfToken||state.boot?.session?.csrfToken||'']);
  const date=value=>{const parsed=new Date(value);return value&&Number.isFinite(parsed.getTime())?parsed.toLocaleString(getLocale()):i18nT('Indisponível');};
  const sessions=()=>Array.isArray(state.securitySessions)?state.securitySessions:[];
  const feedback=(form,message,success=false)=>{const target=form?.querySelector(success?'[data-password-success]':'.form-error');if(target)target.textContent=message;};
  function sessionFeedback(message) { const target=globalThis.document?.querySelector('[data-account-security-error]');if(target)target.textContent=message; }
  function current(key) { return Boolean((state.account?.user?.id||state.boot?.session?.userId)&&key===context()); }
  // Minha conta › Segurança (FRONTEND-V2 §8.9, P8): password change and the sessions of this person.
  function markup() {
    const key=context();rendered={key,token:String(++revision)};
    return i18nHtml`<section class="pg-settings__section" aria-label="Segurança da conta"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title">${icon('shield')} Segurança da conta</h2><p class="pg-settings__muted">Atualize sua senha e acompanhe as sessões com acesso à sua conta.</p></div></div><div class="pg-settings__grid pg-settings__grid--2"><form data-account-security-form="password" data-account-security-token="${rendered.token}" class="pg-settings__form"><h3 class="pg-settings__h3">Trocar senha</h3><label class="pg-settings__field">Senha atual<input class="pg-settings__input" type="password" name="currentPassword" autocomplete="current-password" maxlength="128" required/></label><label class="pg-settings__field">Nova senha<input class="pg-settings__input" type="password" name="password" autocomplete="new-password" minlength="8" maxlength="128" required/><span class="pg-settings__hint">Use de 8 a 128 caracteres, uma letra maiúscula e um caractere especial.</span></label><label class="pg-settings__field">Confirmar nova senha<input class="pg-settings__input" type="password" name="passwordConfirm" autocomplete="new-password" minlength="8" maxlength="128" required/></label><p class="pg-settings__muted">Ao trocar a senha, as outras sessões serão encerradas. Esta sessão continuará aberta.</p><p class="form-error pg-settings__error" role="alert"></p><p class="pg-settings__status" data-password-success role="status" aria-live="polite"></p><div class="pg-settings__form-actions"><button type="submit" class="ui-btn ui-btn--primary ui-btn--md"><span class="ui-btn__label">Salvar nova senha</span></button></div></form><div class="pg-settings__stack"><div class="pg-settings__card-head"><div><h3 class="pg-settings__h3">Sessões da conta</h3><p class="pg-settings__muted">Identificações e datas registradas pelo servidor.</p></div><button type="button" class="ui-btn ui-btn--secondary ui-btn--sm" data-action="refresh-security-sessions"><span class="ui-btn__label">Atualizar sessões</span></button></div><p data-account-security-error class="form-error pg-settings__error" role="alert"></p><div data-security-sessions>${sessionsMarkup()}</div></div></div></section>`;
  }
  function sessionsMarkup() {
    return i18nHtml`<div class="pg-settings__table-wrap"><table class="pg-settings__table pg-settings__table--cards"><thead><tr><th scope="col">Sessão</th><th scope="col">Iniciada em</th><th scope="col">Válida até</th><th scope="col"><span class="sr-only">Ação</span></th></tr></thead><tbody>${sessions().map(session=>i18nHtml`<tr><th scope="row">${session.current?i18nT('Sessão atual'):i18nT('Outra sessão')}<span class="pg-settings__sub">${e(String(session.id||'').slice(-12))}</span></th><td data-label="${e(i18nT('Iniciada em'))}">${e(date(session.createdAt))}</td><td data-label="${e(i18nT('Válida até'))}">${e(date(session.expiresAt))}</td><td class="pg-settings__cell-actions">${session.current?i18nMarkup('<span class="ui-badge ui-badge--success">Atual</span>'):i18nHtml`<button type="button" class="ui-btn ui-btn--danger ui-btn--sm" data-action="revoke-security-session" data-id="${e(session.id)}"><span class="ui-btn__label">Encerrar sessão</span></button>`}</td></tr>`).join('')||i18nMarkup('<tr><td colspan="4" class="pg-settings__empty-cell"><p class="pg-settings__muted">Atualize para consultar as sessões disponíveis.</p></td></tr>')}</tbody></table></div>`;
  }
  function paintSessions(key) {
    if(!current(key))return;
    const target=globalThis.document?.querySelector('[data-security-sessions]');if(target)target.innerHTML=sessionsMarkup();
  }
  async function loadSessions(key,ticket) {
    const result=await api('/api/auth/sessions',{headers:{'X-Elozi-Workspace':state.workspaceId}});
    if(!current(key)||ticket!==sessionRevision)return false;
    if(!Array.isArray(result.sessions)||result.sessions.some(session=>!session||typeof session.id!=='string'||!session.id))throw new Error('O servidor não confirmou a lista de sessões.');
    state.securitySessions=result.sessions.map(session=>({id:session.id,createdAt:session.createdAt,expiresAt:session.expiresAt,current:Boolean(session.current)}));paintSessions(key);return true;
  }
  async function action(name,id) {
    if(!['refresh-security-sessions','revoke-security-session'].includes(name))return false;
    if(sessionsBusy)return true;
    const key=context();if(!rendered||!current(key)||rendered.key!==key){sessionFeedback(i18nT('Abra Minha conta novamente antes de gerir as sessões.'));return true;}
    if(name==='revoke-security-session') {
      const session=sessions().find(item=>item.id===id);
      if(!session||session.current){sessionFeedback(i18nT('Atualize a lista e escolha outra sessão para encerrar.'));return true;}
    }
    sessionsBusy=true;const ticket=++sessionRevision;sessionFeedback('');
    try {
      if(name==='refresh-security-sessions')await loadSessions(key,ticket);
      else {
        const result=await api(`/api/auth/sessions/${encodeURIComponent(id)}/revoke`,{method:'POST',headers:{'X-Elozi-Workspace':state.workspaceId},body:'{}'});
        if(!current(key)||ticket!==sessionRevision)return true;
        if(result.revoked!==true)throw new Error('O servidor não confirmou o encerramento da sessão.');
        if(result.current){state.securitySessions=[];paintSessions(key);toast(i18nT('Esta sessão foi encerrada. Entre novamente para continuar.'));}
        else {state.securitySessions=sessions().filter(session=>session.id!==id);paintSessions(key);toast(i18nT('Sessão encerrada.'));}
      }
    } catch(error) { if(current(key)&&ticket===sessionRevision)sessionFeedback(translateError(error.message)||i18nT('Não foi possível atualizar as sessões.')); }
    finally {sessionsBusy=false;}
    return true;
  }
  async function submit(form) {
    if(form?.dataset?.accountSecurityForm!=='password')return false;
    if(passwordBusy)return true;
    const key=context();feedback(form,'');feedback(form,'',true);
    if(!rendered||rendered.key!==key||form.dataset.accountSecurityToken!==rendered.token||!current(key)){feedback(form,i18nT('Abra Minha conta novamente antes de trocar a senha.'));return true;}
    const read=name=>form.elements.namedItem(name)?.value||'';
    if(!read('currentPassword')){feedback(form,i18nT('Informe sua senha atual.'));return true;}
    if(read('password')!==read('passwordConfirm')){feedback(form,i18nT('A confirmação não corresponde à nova senha.'));return true;}
    if(read('password').length<8||read('password').length>128||!/\p{Lu}/u.test(read('password'))||!/[^\p{L}\p{N}\s]/u.test(read('password'))){feedback(form,i18nT('Use de 8 a 128 caracteres, uma letra maiúscula e um caractere especial.'));return true;}
    passwordBusy=true;
    const submitter=form.querySelector('[type="submit"]');if(submitter)submitter.disabled=true;
    const fields=['currentPassword','password','passwordConfirm'].map(name=>form.elements.namedItem(name)).filter(Boolean),readonly=fields.map(field=>Boolean(field.readOnly));fields.forEach(field=>{field.readOnly=true;});
    try {
      const result=await api('/api/auth/password/change',{method:'POST',headers:{'X-Elozi-Workspace':state.workspaceId},body:JSON.stringify({currentPassword:read('currentPassword'),password:read('password')})});
      if(!current(key)||form.dataset.accountSecurityToken!==rendered?.token)return true;
      if(result.changed!==true)throw new Error('O servidor não confirmou a alteração da senha.');
      form.reset();sessionRevision++;state.securitySessions=sessions().filter(session=>session.current);paintSessions(key);
      const count=Number.isSafeInteger(result.revokedSessions)?result.revokedSessions:null;
      feedback(form,count===null?i18nT('Senha atualizada. As outras sessões foram encerradas.'):i18nTxt`Senha atualizada. ${count} ${count===1?i18nT('outra sessão encerrada'):i18nT('outras sessões encerradas')}.`,true);toast(i18nT('Senha atualizada.'));
    } catch(error) { if(current(key))feedback(form,translateError(error.message)||i18nT('Não foi possível alterar sua senha.')); }
    finally {passwordBusy=false;if(submitter)submitter.disabled=false;fields.forEach((field,index)=>{field.readOnly=readonly[index];});}
    return true;
  }
  function reset() {rendered=null;sessionRevision++;state.securitySessions=[];}
  return {markup,render:markup,action,submit,reset};
}
