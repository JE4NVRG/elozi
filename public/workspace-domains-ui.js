import { t as i18nT, html as i18nHtml, txt as i18nTxt, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError } from './i18n.js';
import './locales-management.js';
import './locales-settings.js';
const fallbackEscape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const stamp = value => instant(value) ? new Date(value).toLocaleString(getLocale()) : i18nT('Não confirmado');
const states = i18nLabels({ pending: 'DNS pendente', verified: 'Propriedade verificada', active: 'Endereço ativo', disabled: 'Endereço desativado' });
const domainRequirementLabels = i18nLabels({
  'TXT de propriedade conferido e destino CNAME canônico; com DNS oculto pelo proxy, rota HTTPS assinada pelo servidor.': 'TXT de propriedade conferido e destino CNAME canônico; com DNS oculto pelo proxy, rota HTTPS assinada pelo servidor.',
  'Proxy configurado para este hostname e para a aplicação Elozi.': 'Proxy configurado para este hostname e para a aplicação do painel.',
  'HTTPS com certificado válido para o hostname, verificado por inspeção técnica da plataforma.': 'HTTPS com certificado válido para o hostname, verificado por inspeção técnica da plataforma.',
});
const privateSuffixes = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'arpa', 'test', 'invalid', 'example', 'onion', 'alt'];
function hostname(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 253 || /[\s\p{Cc}\\/:@?#*\[\]%]/u.test(value)) throw new Error('Informe um hostname público, sem https://, porta, caminho ou curinga.');
  let host;
  try { host = new URL(`https://${value.replace(/\.$/, '')}`).hostname; } catch { throw new Error('Informe um hostname público válido.'); }
  const labels = host.split('.');
  if (!host || host.length > 253 || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels.at(-1)) || privateSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) throw new Error('Informe um hostname público válido.');
  return host;
}

/** Domain control is commercial metadata; the browser never supplies deployment evidence. */
export function createWorkspaceDomainsUI({ state, api, openModal, escape: e = fallbackEscape, toast = () => {}, getModal = () => globalThis.document?.querySelector('#modal'), onUpdate = () => {} }) {
  let view = null, scope = '', sequence = 0, readSequence = 0, controller = null, busy = false;
  // An unanswered write stays blocked across close/reopen until a GET reconciles it.
  const pending = new Map();
  const context = () => {
    const session = state.boot?.session || {}, workspaceId = state.workspaceId || session.resellerId || '';
    return { workspaceId, person: session.userId, role: session.role, kind: session.kind, accountKind: state.boot?.reseller?.accountKind || session.accountKind, support: state.supportGrantId || session.supportGrantId || null,
      csrf: state.boot?.csrfToken || '', sessionCsrf: session.csrfToken || '', sessionWorkspace: session.resellerId || '', owner: Boolean(session.platformOwner), admin: Boolean(session.platformAdmin), route: state.view || '' };
  };
  const key = () => JSON.stringify(context());
  const allowed = () => { const c = context(); return Boolean(identity(c.workspaceId) && c.person && c.role === 'reseller' && c.kind !== 'service' && !c.support && ['platform', 'reseller', 'business'].includes(c.accountKind)); };
  const globalAuthority = () => context().owner || context().admin;
  const platformAuthority = () => globalAuthority() && context().workspaceId === (state.boot?.workspaces?.find(item => item.platformWorkspace)?.id || 'mep-demo');
  const inScope = account => globalAuthority() || account.id === context().workspaceId || ['platform', 'reseller'].includes(context().accountKind) && account.parentWorkspaceId === context().workspaceId && (context().accountKind === 'platform' || account.accountKind === 'business');
  const panel = () => getModal()?.querySelector?.('[data-domains-panel]');
  const shown = record => Boolean(record && allowed() && record.key === key() && view === record && getModal()?.open !== false && panel()?.dataset?.domainsToken === record.token);
  const intentKey = account => JSON.stringify([key(), account.id]);
  const headers = () => ({ 'X-Elozi-Workspace': context().workspaceId });
  const path = account => `/api/accounts/${encodeURIComponent(account.id)}/domain`;
  function abortRead() { readSequence++; controller?.abort(); controller = null; }
  function closeOwn() { const own = view && panel()?.dataset?.domainsToken === view.token; view = null; if (own) getModal()?.close?.(); }
  function reset() { sequence++; abortRead(); closeOwn(); scope = key(); }
  function sync() { if (scope !== key()) reset(); return allowed(); }
  // Native close events can arrive after another panel has reopened the shared dialog.
  getModal()?.addEventListener?.('close', () => { if (getModal()?.open === true) return; abortRead(); view = null; });
  function accountDTO(account) {
    if (!account || !identity(account.id) || typeof account.name !== 'string' || !account.name.trim() || account.name.length > 80 || !['platform', 'reseller', 'business'].includes(account.accountKind) || !Number.isSafeInteger(account.version) || account.version < 1 || account.parentWorkspaceId != null && !identity(account.parentWorkspaceId) || !inScope(account)) throw new Error('Abra uma conta disponível neste acesso.');
    return { id: account.id, name: account.name, accountKind: account.accountKind, parentWorkspaceId: account.parentWorkspaceId ?? null, version: account.version };
  }
  function dto(value, account, minVersion = account.version) {
    const invalid = () => { throw new Error('O servidor não confirmou o domínio desta conta.'); };
    if (!value || value.workspaceId !== account.id || !Number.isSafeInteger(value.version) || value.version < minVersion || typeof value.deploymentInspectionAvailable !== 'boolean' || typeof value.canConfirmDeployment !== 'boolean' || value.canConfirmDeployment && (!value.deploymentInspectionAvailable || !platformAuthority()) || !Array.isArray(value.activationRequirements) || !value.activationRequirements.length || value.activationRequirements.length > 8 || value.activationRequirements.some(item => typeof item !== 'string' || !item || item.length > 300 || /\p{Cc}/u.test(item))) invalid();
    if (hostname(value.canonicalHost) !== value.canonicalHost) invalid();
    let binding = null;
    if (value.binding !== null) {
      const b = value.binding;
      if (!b || hostname(b.host) !== b.host || b.host === value.canonicalHost || !Object.hasOwn(states, b.state) || typeof b.active !== 'boolean' || !/^[a-f0-9]{64}$/.test(b.challenge) || !instant(b.configuredAt) || b.verifiedAt !== null && !instant(b.verifiedAt) || !Array.isArray(b.records) || b.records.length !== 2) invalid();
      const expected = [{ type: 'TXT', name: `_elozi-verification.${b.host}`, value: `elozi-verification=${b.challenge}` }, { type: 'CNAME', name: b.host, value: value.canonicalHost }];
      if (b.records.some((record, index) => !record || Object.keys(expected[index]).some(field => record[field] !== expected[index][field]))) invalid();
      let lastCheck = null, deployment = null;
      if (b.lastCheck !== null) { const check = b.lastCheck; if (!check || typeof check.txtOwnership !== 'boolean' || typeof check.cnameTarget !== 'boolean' || check.checkedAt !== null && !instant(check.checkedAt)||check.routeVerified!==undefined&&typeof check.routeVerified!=='boolean') invalid(); lastCheck = { txtOwnership: check.txtOwnership, cnameTarget: check.cnameTarget, checkedAt: check.checkedAt,routeVerified:check.routeVerified===true }; }
      if (b.deployment !== null) {
        const proof = b.deployment;
        if (!proof || proof.host !== b.host || proof.httpsOrigin !== `https://${b.host}` || proof.canonicalHost !== value.canonicalHost || proof.tlsValid !== true || proof.proxyVerified !== true || !instant(proof.observedAt) || !instant(proof.certificateExpiresAt) || proof.sourceRevision !== undefined && !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(proof.sourceRevision)) invalid();
        deployment = { host: proof.host, httpsOrigin: proof.httpsOrigin, observedAt: proof.observedAt, certificateExpiresAt: proof.certificateExpiresAt, sourceRevision: proof.sourceRevision };
      }
      if (b.active && (b.state !== 'active' || !b.verifiedAt || !deployment) || ['verified', 'active'].includes(b.state) && !b.verifiedAt) invalid();
      binding = { host: b.host, state: b.state, active: b.active, challenge: b.challenge, configuredAt: b.configuredAt, verifiedAt: b.verifiedAt, records: expected, lastCheck, deployment };
    }
    return { workspaceId: value.workspaceId, version: value.version, canonicalHost: value.canonicalHost, binding, activationRequirements: [...value.activationRequirements], deploymentInspectionAvailable: value.deploymentInspectionAvailable, canConfirmDeployment: value.canConfirmDeployment };
  }
  const button = (name, label, extra = '', primary = false) => i18nHtml`<button type="button" class="ui-btn ui-btn--${primary ? 'primary' : 'secondary'} ui-btn--md" data-domains-action="${name}" data-domains-token="${view.token}" ${extra}><span class="ui-btn__label">${e(label)}</span></button>`;
  function show(account, data = null, type = 'detail', notice = '', intent = null) {
    view = { account, data, type, notice, intent, key: key(), token: String(++sequence) };
    let html;
    if (type === 'loading') html = i18nMarkup('<p role="status">Consultando o domínio desta conta…</p>');
    else if (type === 'pending') html = i18nHtml`<div class="pg-settings__note"><strong>Resposta da alteração pendente</strong><p>A confirmação não chegou. Consulte o estado atual antes de alterar o endereço novamente. Esta consulta não repete a gravação.</p></div><div class="pg-settings__dialog-actions">${button('close', i18nT('Fechar'))}${button('reconcile', i18nT('Consultar resultado'), '', true)}</div>`;
    else if (type === 'disable' || type === 'remove') html = i18nHtml`<div class="pg-settings__note"><strong>${type === 'remove' ? i18nT('Remover vínculo') : i18nT('Desativar endereço')}: ${e(data.binding.host)}</strong><p>${type === 'remove' ? i18nT('O hostname ficará livre para outro cadastro. Um novo vínculo exigirá outro TXT e nova verificação.') : i18nT('O hostname continuará reservado a esta conta. Para reativar, será necessário um novo TXT e verificar DNS e HTTPS novamente.')}</p><p>Esta ação afeta somente o endereço personalizado. Dados, canais e conta serão preservados.</p></div><form data-domains-form="${type}" data-domains-token="${view.token}"><div class="pg-settings__dialog-actions">${button('back', i18nT('Voltar'))}<button type="submit" class="ui-btn ui-btn--primary ui-btn--md"><span class="ui-btn__label">${type === 'remove' ? i18nT('Confirmar remoção do vínculo') : i18nT('Confirmar desativação')}</span></button></div></form>`;
    else if (type === 'error') html = i18nHtml`<p class="pg-settings__note">${e(notice)}</p><div class="pg-settings__dialog-actions">${button('close', i18nT('Fechar'))}${button('refresh', i18nT('Consultar novamente'), '', true)}</div>`;
    else html = detailMarkup();
    openModal(i18nT('Domínio personalizado'), account.name, i18nHtml`<div class="pg-settings__dialog" data-domains-panel data-domains-token="${view.token}" aria-busy="false"><div class="pg-settings__context">${e(account.name)} · endereço da conta</div>${html}<p data-domains-progress role="status"></p><p class="form-error pg-settings__error" role="alert"></p></div>`);
  }
  function detailMarkup() {
    const { data, notice } = view, b = data.binding;
    const register = !b || b.state === 'disabled';
    const expired = b?.deployment && Date.parse(b.deployment.certificateExpiresAt) <= Date.now();
    const label = b?.state === 'active' && !b.active ? expired ? i18nT('Certificado expirado · endereço inativo') : i18nT('Implantação precisa de nova inspeção · endereço inativo') : b ? states[b.state] : i18nT('Nenhum domínio cadastrado');
    const recordsHelp = b?.state === 'disabled' ? i18nT('Estes registros pertencem ao vínculo desativado. Gere um novo vínculo acima para obter o novo TXT antes de publicar e verificar novamente.') : i18nT('Copie estes valores no provedor que administra o seu domínio. Após publicar, aguarde a propagação e verifique abaixo.');
    const records = b ? i18nHtml`<section class="pg-settings__stack"><h3 class="pg-settings__h3">Registros DNS</h3><p>${recordsHelp}</p>${b.records.map((record, index) => i18nHtml`<fieldset class="pg-settings__fieldset"><legend>${record.type}</legend>${['name', 'value'].map(field => i18nHtml`<label class="pg-settings__field">${field === 'name' ? i18nT('Nome / host') : i18nT('Valor / destino')}<input class="pg-settings__input" value="${e(record[field])}" readonly aria-label="${record.type} ${field === 'name' ? i18nT('nome') : i18nT('valor')}" autocomplete="off" spellcheck="false"/></label>${button('copy', i18nTxt`Copiar ${field === 'name' ? i18nT('nome') : i18nT('valor')} ${record.type}`, `data-domains-record="${index}" data-domains-field="${field}"`)}`).join('')}</fieldset>`).join('')}${b.lastCheck ? i18nHtml`<p>Última consulta: ${e(stamp(b.lastCheck.checkedAt))}. TXT ${b.lastCheck.txtOwnership ? i18nT('confirmado') : i18nT('não confirmado')} · CNAME ${b.lastCheck.cnameTarget ? i18nT('confirmado') : b.lastCheck.routeVerified ? i18nT('oculto pelo proxy · rota HTTPS assinada confirmada') : i18nT('não confirmado')}.</p>` : ''}</section>` : '';
    return i18nHtml`${notice ? i18nHtml`<p class="pg-settings__note" role="status">${e(notice)}</p>` : ''}<span class="ui-badge ui-badge--${b?.active ? 'success' : 'warning'}">${e(label)}</span>${b ? i18nHtml`<p><strong>${e(b.host)}</strong></p><p>Propriedade DNS: ${e(stamp(b.verifiedAt))}</p>` : ''}${register ? i18nHtml`<form data-domains-form="register" data-domains-token="${view.token}"><label class="pg-settings__field">Hostname público<input class="pg-settings__input" name="host" value="${e(b?.host || '')}" maxlength="253" required autocomplete="off" spellcheck="false" placeholder="atendimento.suaempresa.com.br" ${b ? 'readonly' : ''}/></label><p>Informe somente o hostname. Cada conta possui um vínculo; o cadastro confirma disponibilidade, sem ativar o endereço.</p><button type="submit" class="ui-btn ui-btn--primary ui-btn--md"><span class="ui-btn__label">${b ? i18nT('Gerar novo vínculo e TXT') : i18nT('Cadastrar domínio')}</span></button></form>` : ''}${records}<section class="pg-settings__stack"><h3 class="pg-settings__h3">Ativação do endereço</h3><ul>${data.activationRequirements.map(requirement => i18nHtml`<li>${e(Object.hasOwn(domainRequirementLabels, requirement) ? domainRequirementLabels[requirement] : requirement)}</li>`).join('')}</ul><p>${data.deploymentInspectionAvailable ? i18nT('A plataforma inspeciona o proxy e o certificado HTTPS antes de liberar este endereço.') : i18nT('A inspeção HTTPS está indisponível. O endereço permanece inativo até a plataforma habilitar a verificação técnica.')}</p>${b?.deployment ? i18nHtml`<p>HTTPS inspecionado em ${e(stamp(b.deployment.observedAt))}. Certificado válido até ${e(stamp(b.deployment.certificateExpiresAt))}${expired ? i18nT(' · expirado') : ''}.</p>` : ''}${b?.verifiedAt && !data.canConfirmDeployment && b.state !== 'disabled' ? i18nMarkup('<p>A ativação precisa ser concluída pelo administrador da plataforma.</p>') : ''}</section><div class="pg-settings__dialog-actions">${button('close', i18nT('Fechar'))}${button('refresh', i18nT('Atualizar estado'))}${b && b.state !== 'disabled' ? button('verify', i18nT('Verificar DNS'), '', b.state === 'pending') : ''}${b?.verifiedAt && b.state !== 'disabled' && data.canConfirmDeployment ? button('activate', b.active ? i18nT('Inspecionar HTTPS novamente') : i18nT('Inspecionar HTTPS e ativar'), '', !b.active) : ''}${b && b.state !== 'disabled' ? button('disable-review', i18nT('Desativar endereço')) : ''}${b ? button('remove-review', i18nT('Remover vínculo')) : ''}</div>`;
  }
  function feedback(record, failure) {
    if (!shown(record)) return;
    if ([401, 403, 404].includes(failure.status)) { pending.delete(intentKey(record.account)); closeOwn(); toast(i18nT('Este acesso não permite consultar o domínio da conta.'), true); return; }
    const target = panel()?.querySelector?.('.form-error') || getModal()?.querySelector?.('.form-error');
    if (failure.status === 409) record.stale = true;
    if (target) target.textContent = failure.status === 409 ? i18nT('A conta mudou. Atualize o estado antes de revisar outra alteração.') : translateError(failure.message) || i18nT('Não foi possível confirmar esta operação.');
    toast(target?.textContent || translateError(failure.message), true);
  }
  async function read(record, reconcile = false) {
    if (!shown(record)) return false;
    abortRead(); const ticket = readSequence, expected = record.key;
    controller = new AbortController(); const signal = controller.signal;
    try {
      const result = await api(path(record.account), { method: 'GET', headers: headers(), signal });
      if (ticket !== readSequence || signal.aborted || expected !== key() || !shown(record)) return false;
      const data = dto(result, record.account, record.data?.version || record.account.version);
      if (reconcile) pending.delete(intentKey(record.account));
      show({ ...record.account, version: data.version }, data, 'detail', reconcile ? i18nT('Estado atual consultado. Confira abaixo antes de fazer outra alteração.') : '');
      if (reconcile) await notifyUpdate(expected);
      return true;
    } catch (failure) { if (ticket === readSequence && shown(record) && failure.name !== 'AbortError') { if (record.type === 'loading') show(record.account, null, 'error', i18nT('Não foi possível consultar o domínio desta conta.')); feedback(view, failure); } return false; }
  }
  async function notifyUpdate(expected) { if (expected === key() && allowed()) { try { await onUpdate(); } catch { if (expected === key()) toast(i18nT('Domínio confirmado. Atualize a lista de contas para consultar a revisão atual.'), true); } } }
  async function open(account) {
    if (!sync()) return false;
    try {
      const clean = accountDTO(account); abortRead(); closeOwn();
      const unresolved = pending.get(intentKey(clean));
      if (unresolved) { show(clean, null, 'pending', '', unresolved); return true; }
      show(clean, null, 'loading'); return await read(view);
    } catch (failure) { toast(translateError(failure.message), true); return false; }
  }
  function confirmed(data, intent) {
    if (data.version <= intent.version) return false;
    const b = data.binding;
    if (intent.operation === 'register') return b?.host === intent.host && b.state === 'pending' && !b.active && !b.verifiedAt;
    if (intent.operation === 'remove') return b === null;
    if (b?.host !== intent.host) return false;
    if (intent.operation === 'disable') return b.state === 'disabled' && !b.active;
    if (intent.operation === 'activate') return b.state === 'active' && b.active;
    return Boolean(b.lastCheck);
  }
  async function write(operation, host) {
    const record = view;
    if (busy || !shown(record) || !record.data || pending.has(intentKey(record.account))) return;
    if (record.stale) { feedback(record, { status: 409 }); return; }
    abortRead();
    const intent = { key: record.key, account: record.account, version: record.data.version, operation, host: host || record.data.binding?.host };
    const pendingKey = intentKey(record.account); pending.set(pendingKey, intent); busy = true;
    const busyPanel = panel(), controls = [...(busyPanel?.querySelectorAll?.('button') || [])].map(node => [node, node.disabled]);
    busyPanel?.setAttribute?.('aria-busy', 'true'); controls.forEach(([node]) => { node.disabled = true; });
    const progress = busyPanel?.querySelector?.('[data-domains-progress]');
    if (progress) progress.textContent = operation === 'verify' ? i18nT('Consultando DNS…') : operation === 'activate' ? i18nT('Inspecionando HTTPS e proxy…') : i18nT('Confirmando alteração do vínculo…');
    const payload = { version: intent.version, ...(operation === 'register' ? { host } : {}) };
    try {
      const result = await api(path(record.account) + (['register', 'remove'].includes(operation) ? '' : '/' + operation), { method: operation === 'remove' ? 'DELETE' : 'POST', headers: headers(), body: JSON.stringify(payload) });
      if (record.key !== key() || !allowed()) return;
      const data = dto(result, record.account, intent.version);
      if (!confirmed(data, intent)) throw new Error('A resposta não confirmou o resultado da alteração.');
      pending.delete(pendingKey);
      if (shown(record)) { const notice = operation === 'verify' ? data.binding.lastCheck.txtOwnership && (data.binding.lastCheck.cnameTarget || data.binding.lastCheck.routeVerified) ? i18nT('Propriedade DNS confirmada. Revise a etapa HTTPS.') : i18nT('DNS consultado. Os registros ainda não foram confirmados.') : { register: i18nT('Domínio cadastrado. Publique os registros DNS para continuar.'), activate: i18nT('HTTPS e proxy confirmados pela plataforma. Endereço ativo.'), disable: i18nT('Endereço desativado. Dados, canais e conta preservados.'), remove: i18nT('Vínculo removido. Hostname liberado; dados, canais e conta preservados.') }[operation]; show({ ...record.account, version: data.version }, data, 'detail', notice); toast(notice); }
      await notifyUpdate(intent.key);
    } catch (failure) {
      const definitive = Number.isInteger(failure.status) && failure.status >= 400 && failure.status < 500;
      if (definitive) pending.delete(pendingKey);
      if (!shown(record)) return;
      if (definitive) feedback(record, failure); else show(record.account, null, 'pending', '', intent);
    } finally { busy = false; if (shown(record)) { busyPanel?.setAttribute?.('aria-busy', 'false'); controls.forEach(([node, disabled]) => { node.disabled = disabled; }); if (progress) progress.textContent = ''; } }
  }
  async function action(node) {
    const name = node?.dataset?.domainsAction; if (!name) return false;
    if (!sync() || busy || node.disabled || !shown(view) || node.dataset.domainsToken !== view.token) return true;
    const record = view;
    try {
      if (name === 'close') { closeOwn(); abortRead(); return true; }
      if (name === 'reconcile' && record.type === 'pending') { await read(record, true); return true; }
      if (name === 'refresh' || name === 'back') { if (pending.has(intentKey(record.account))) show(record.account, null, 'pending', '', pending.get(intentKey(record.account))); else await read(record); return true; }
      if (record.type !== 'detail' || !record.data || pending.has(intentKey(record.account))) return true;
      if (record.stale && ['verify', 'activate', 'disable-review', 'remove-review'].includes(name)) { feedback(record, { status: 409 }); return true; }
      const b = record.data.binding;
      if (name === 'copy') { const index = node.dataset.domainsRecord, field = node.dataset.domainsField; if (!b || !['0', '1'].includes(index) || !['name', 'value'].includes(field)) return true; if (!globalThis.navigator?.clipboard?.writeText) throw new Error('Selecione o valor do registro e copie manualmente.'); await globalThis.navigator.clipboard.writeText(b.records[Number(index)][field]); if (shown(record)) toast(i18nT('Registro DNS copiado.')); }
      else if (name === 'verify' && b && b.state !== 'disabled') await write('verify');
      else if (name === 'activate' && b?.verifiedAt && b.state !== 'disabled' && record.data.canConfirmDeployment && platformAuthority()) await write('activate');
      else if (name === 'disable-review' && b && b.state !== 'disabled') show(record.account, record.data, 'disable');
      else if (name === 'remove-review' && b) show(record.account, record.data, 'remove');
      else return false;
    } catch (failure) { feedback(record, failure); }
    return true;
  }
  async function submit(form) {
    const type = form?.dataset?.domainsForm; if (!type) return false;
    if (!sync() || busy || !shown(view) || form.dataset.domainsToken !== view.token || pending.has(intentKey(view.account))) return true;
    const record = view, submitButton = form.querySelector?.('[type="submit"]');
    try {
      if (type === 'register' && record.type === 'detail' && (!record.data.binding || record.data.binding.state === 'disabled')) {
        const host = hostname(String(new FormData(form).get('host') || '').trim());
        if (host === record.data.canonicalHost || record.data.binding && host !== record.data.binding.host) throw new Error('Remova o vínculo anterior antes de cadastrar outro hostname.');
        if (submitButton) submitButton.disabled = true; await write('register', host);
      } else if (['disable', 'remove'].includes(type) && record.type === type && record.data.binding) { if (submitButton) submitButton.disabled = true; await write(type); }
    } catch (failure) { feedback(record, failure); }
    finally { if (submitButton) submitButton.disabled = false; }
    return true;
  }
  return { open, action, submit, reset };
}
