import {t as i18nText, txt as i18nTemplate, html as i18nHtml, markup as i18nMarkup, labels as i18nLabels, getLocale, translateError, translateCopy} from './i18n.js';
import './locales-operations.js';
import './locales-live.js';
import { provideAppServices } from './channel-connect-flow.js';
import { renderWidgetDesigner, mountWidgetDesigner } from './widget-designer.js';
import { formatHash } from './router.js';
import { WEBCHAT_INSTALL_STEPS, WEBCHAT_INSTALL_PLATFORMS, renderWebchatInstallGuide, renderWebchatInstallation, renderWebchatValidation, renderWebchatServiceChoices, webchatInstallReadiness, copyWebchatInstallCode } from './webchat-install-guide.js';

const names = Object.freeze({get webchat() { return i18nText('Webchat'); }, get email() { return i18nText('E-mail de atendimento'); }, get instagram() { return i18nText('Instagram'); }, get messenger() { return i18nText('Facebook Messenger'); }});
const privateFields = ['ingressSecret', 'accessToken', 'appSecret', 'verifyToken'];
const fallbackEscape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 120 && value === value.trim() && !/\p{Cc}/u.test(value);
const localHost = hostname => ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
const safeURL = value => {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash && (url.protocol === 'https:' || url.protocol === 'http:' && localHost(url.hostname)) ? url : null; } catch { return null; }
};
const origin = value => { const url = safeURL(value); if (!url || url.hostname.includes('*') || url.origin !== value || value.length > 240) throw new Error(i18nText('Use origens HTTPS exatas, sem caminho; HTTP só no computador local.')); return url.origin; };
const email = value => typeof value === 'string' && value.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(value)
  && !value.startsWith('.') && !value.split('@')[0].endsWith('.') && !value.includes('..');

export function createChannelConnectorsUI({ state, api, openModal, escape: e = fallbackEscape, toast = () => {}, getModal = () => globalThis.document?.querySelector('#modal'), onUpdate = () => {}, onTestJourney } = {}) {
  let view = null, sequence = 0, renderSequence = 0, readController = null, writing = false, disposeDesigner = () => {};
  const pending = new Map();
  // The only P7 factory app.js gives its services to: Canais, Visão geral and #setup read them through
  // appServices() (channel-connect-flow.js) until the integrator passes them explicitly.
  if (state && typeof api === 'function') provideAppServices({ state, api, openModal, toast, getModal, refresh: onUpdate });
  const publicEndpointOrigin = () => origin(Object.hasOwn(state.boot || {}, 'canonicalPublicOrigin') ? state.boot.canonicalPublicOrigin : state.boot?.publicOrigin);
  const context = () => {
    const session = state.boot?.session || {};
    return { workspaceId: state.workspaceId || session.resellerId || '', tenantId: state.tenant?.id || '', userId: session.userId || '',
      authority: state.boot?.csrfToken || session.csrfToken || '', role: session.role, support: state.supportGrantId || session.supportGrantId || null,
      service: session.kind === 'service', permissions: session.permissions, scopeRules: session.scopeRules, route: state.view || '',
      platform: Boolean(session.platformOwner || session.platformAdmin), workspaces: (state.boot?.workspaces || []).map(item => [item.id, item.supportGrantId || null]),
      tenants: (state.boot?.tenants || []).map(item => item.id),
      origins: [state.boot?.publicOrigin, Object.hasOwn(state.boot || {}, 'canonicalPublicOrigin'), state.boot?.canonicalPublicOrigin] };
  };
  const key = () => { const c = context(); return JSON.stringify([c.workspaceId, c.tenantId, c.userId, c.authority, c.role, c.support, c.service, c.permissions, c.scopeRules, c.route, c.platform, c.workspaces, c.tenants, c.origins]); };
  const allowed = () => { const c = context(); return identity(c.workspaceId) && identity(c.tenantId) && identity(c.userId) && c.role === 'reseller' && !c.support && !c.service
    && (!state.tenant?.resellerId || state.tenant.resellerId === c.workspaceId); };
  const current = record => allowed() && record?.key === key() && state.tenant?.channels?.some(channel => channel.id === record.channelId && channel.kind === record.kind);
  const panel = () => getModal()?.querySelector?.('[data-connector-panel]');
  const shown = record => view === record && current(record) && getModal()?.open !== false && panel()?.dataset.connectorToken === record.token;
  const headers = record => ({ 'X-Elozi-Workspace': record.workspaceId, ...(typeof record.authority === 'string' && record.authority ? { 'X-CSRF-Token': record.authority } : {}) });
  const endpoint = record => `/api/tenants/${encodeURIComponent(record.tenantId)}/channels/${encodeURIComponent(record.channelId)}/configuration`;
  const pendingKey = record => JSON.stringify([record.key, record.channelId]);
  const button = (record, action, label) => `<button class="button" type="button" data-connector-action="${action}" data-connector-token="${record.token}" style="min-height:44px">${label}</button>`;
  const feedback = message => { const target = panel()?.querySelector?.('.form-error'); if (target) target.textContent = message; };
  const inputs = () => panel()?.querySelectorAll?.('input[type="password"]') || [];
  const scrub = () => { for (const input of inputs()) input.value = ''; const secret=panel()?.querySelector?.('[data-identity-secret]');if(secret)secret.value=''; };
  function closeOwn() { disposeDesigner();disposeDesigner=()=>{};if (view && panel()?.dataset.connectorToken === view.token) { scrub(); getModal()?.close?.(); } view = null; }
  function reset() { sequence++; readController?.abort(); readController = null; pending.clear(); closeOwn(); }
  getModal()?.addEventListener?.('close', () => { if (getModal()?.open === true) return; disposeDesigner();disposeDesigner=()=>{};scrub(); view = null; sequence++; readController?.abort(); });
  const field = (label, name, value = '', attrs = '') => `<label>${label}<input name="${name}" value="${e(value)}" ${attrs}/></label>`;
  const password = (label, name, max = 8192) => i18nHtml`<label>${label}<input type="password" name="${name}" value="" autocomplete="new-password" maxlength="${max}"/><small>Deixe em branco para manter um valor já guardado.</small></label>`;
  function dto(result, record) {
    if (!result || result.kind !== record.kind || result.channelId !== record.channelId || result.tenantId !== record.tenantId
      || !Number.isSafeInteger(result.version) || result.version < 0 || typeof result.enabled !== 'boolean'
      || !['planned', 'configured', 'connected', 'disconnected', 'error'].includes(result.state)) throw new Error(i18nText('O servidor não confirmou a configuração deste canal.'));
    const value = { kind: result.kind, channelId: result.channelId, tenantId: result.tenantId, version: result.version, enabled: result.enabled, state: result.state,
      configured: result.configured === true, mediaSupported: result.mediaSupported === true, inboundMediaSupported: result.inboundMediaSupported === true, ingressConfigured: result.ingressConfigured === true, mailboxConnected: result.mailboxConnected === true };
    if (record.kind === 'webchat') {
      if (!Array.isArray(result.origins) || result.origins.length > 8) throw new Error(i18nText('O servidor não confirmou as origens do webchat.'));
      value.origins = result.origins.map(origin);
      const script = safeURL(result.install?.scriptUrl);
      if (script) {
        const canonical = publicEndpointOrigin();
        if (script.pathname !== '/widget.js' || script.origin !== canonical) throw new Error(i18nText('O código de instalação precisa usar o widget canônico.'));
        const snippet = `<script type="module" src="${script.href}" data-tenant-id="${fallbackEscape(record.tenantId)}" data-channel-id="${fallbackEscape(record.channelId)}"></script>`;
        if (result.install.embedSnippet !== undefined) {
          const match = typeof result.install.embedSnippet === 'string' && /^<script\s+([^>]*)>\s*<\/script>$/.exec(result.install.embedSnippet);
          const attributes = match ? [...match[1].matchAll(/([a-z-]+)="([^"]*)"/g)] : [];
          const values = Object.fromEntries(attributes.map(attribute => [attribute[1], attribute[2]]));
          if (!match || match[1].replace(/([a-z-]+)="([^"]*)"/g, '').trim() || attributes.length !== 4 || Object.keys(values).length !== 4
            || values.type !== 'module' || values.src !== script.href || values['data-tenant-id'] !== fallbackEscape(record.tenantId) || values['data-channel-id'] !== fallbackEscape(record.channelId)) throw new Error(i18nText('O servidor não confirmou o código de instalação deste canal.'));
        }
        if(result.install.authenticatedSnippet!==undefined&&(typeof result.install.authenticatedSnippet!=='string'||!result.install.authenticatedSnippet||result.install.authenticatedSnippet.length>8192))throw new Error(i18nText('O servidor não confirmou o código de instalação deste canal.'));
        value.install = { scriptUrl: script.href, embedSnippet: result.install.embedSnippet ?? snippet, ...(result.install.authenticatedSnippet?{authenticatedSnippet:result.install.authenticatedSnippet}: {}) };
      } else if (result.install) throw new Error(i18nText('O servidor não confirmou uma URL segura para instalar o widget.'));
    } else if (record.kind === 'email') {
      if (result.address !== null && result.address !== undefined && !email(result.address)) throw new Error(i18nText('O servidor não confirmou o endereço do canal.'));
      value.address = result.address || '';
    } else {
      if (result.resourceId !== null && result.resourceId !== undefined && (typeof result.resourceId !== 'string' || !/^\d{1,40}$/.test(result.resourceId))) throw new Error(i18nText('O servidor não confirmou o recurso Meta.'));
      if (result.apiVersion !== null && result.apiVersion !== undefined && (typeof result.apiVersion !== 'string' || !/^v[1-9]\d{0,2}\.0$/.test(result.apiVersion))) throw new Error(i18nText('O servidor não confirmou a versão da API Meta.'));
      value.resourceId = result.resourceId || ''; value.apiVersion = result.apiVersion || ''; value.lastWebhookAt = typeof result.lastWebhookAt === 'string' && Number.isFinite(Date.parse(result.lastWebhookAt)) ? result.lastWebhookAt : null;
    }
    if (result.webhookUrl !== undefined && result.webhookUrl !== null) {
      const url = safeURL(result.webhookUrl), expected = `/api/webhooks/${record.kind === 'email' ? 'email' : 'meta'}/${encodeURIComponent(record.tenantId)}/${encodeURIComponent(record.channelId)}`;
      const canonical = publicEndpointOrigin();
      if (!url || url.pathname !== expected || url.origin !== canonical) throw new Error(i18nText('O servidor não confirmou o endpoint público deste canal.'));
      value.webhookUrl = url.href;
    }
    return value;
  }
  function summary(value) {
    const rows = [[i18nText('Revisão no servidor'), value.version], [i18nText('Recepção'), value.enabled ? i18nText('Habilitada') : i18nText('Desativada')]];
    if (value.kind === 'webchat') rows.push([i18nText('Origens'), value.origins.join(', ') || i18nText('Nenhuma')]);
    else if (value.kind === 'email') rows.push([i18nText('Endereço'), value.address || i18nText('Não cadastrado')]);
    else rows.push([i18nText('Recurso Meta'), value.resourceId || i18nText('Não cadastrado')], [i18nText('Versão da API'), value.apiVersion || i18nText('Não cadastrada')], [i18nText('Mídia recebida'), value.inboundMediaSupported ? i18nText('Captura privada · validar com sua conta') : i18nText('Ainda indisponível')], [i18nText('Envio de arquivos'), value.mediaSupported ? i18nText('Disponível · validar com sua conta') : i18nText('Ainda indisponível')]);
    return `<dl class="accounts-review">${rows.map(([name, text]) => `<div><dt>${name}</dt><dd>${e(text)}</dd></div>`).join('')}</dl>`;
  }
  // Drafts belong only to this guarded modal lifetime. Private identity keys are never captured.
  const draftFields = name => name === 'configuration' ? ['origins', 'enabled'] : ['displayName','openButtonLabel','avatarUrl','logoUrl','radius','theme','handoffNotificationEmail','assistantInstructions','emailPrompt','attachmentsEnabled','voiceEnabled','feedbackEnabled','creditVisible','creditText', ...Object.keys(paletteNames).flatMap(key => [`colors-${key}`, `lightColors-${key}`]), ...['greeting','verifiedGreeting','handoffMessage','awaitingMessage'].flatMap(key => [`${key}-pt-BR`, `${key}-en`])];
  function captureDraft(record) {
    if (!shown(record) || record.kind !== 'webchat') return;
    const form = panel()?.querySelector?.('form[data-connector-form]'), name = form?.dataset?.connectorForm;
    if (!['configuration','widget-settings'].includes(name) || form.dataset.connectorToken !== record.token) return;
    const allowedNames = draftFields(name), fields = Array.from(form.elements || []);
    const values = fields.filter(field => allowedNames.includes(field.name)).map(field => ({ name: field.name, type: field.type, value: String(field.value ?? ''), checked: field.checked === true }));
    if (values.length) {
      if (record.formBaseline?.name === name && JSON.stringify(record.formBaseline.values) === JSON.stringify(values)) delete record.drafts[name];
      else record.drafts[name] = values;
    }
  }
  function restoreDraft(record) {
    const form = panel()?.querySelector?.('form[data-connector-form]'), values = record.drafts?.[form?.dataset?.connectorForm];
    if (!shown(record) || !form || !values) return;
    for (const field of Array.from(form.elements || [])) {
      const saved = values.find(item => item.name === field.name && (field.type !== 'radio' || item.value === field.value));
      if (!saved) continue;
      if (['checkbox','radio'].includes(field.type)) field.checked = saved.checked;
      else field.value = saved.value;
    }
  }
  const guide = (record, content) => renderWebchatInstallGuide({ step: record.guideStep || 'authorize', status: record.status, token: record.token, content, text: i18nText, escape: e, hasDraft: Object.keys(record.drafts || {}).length > 0 });
  function show(record, markup) {
    if (!current(record)) return;
    sequence++;
    disposeDesigner();disposeDesigner=()=>{};
    const oldToken = record.token; record.token = String(++renderSequence);
    markup = markup.replaceAll(`data-connector-token="${oldToken}"`, `data-connector-token="${record.token}"`);
    openModal(record.adminSection==='widget'&&!record.guided?i18nText('Personalizar chat'):record.kind==='webchat'&&record.guided?i18nText('Instalação do webchat'):i18nTemplate`Configurar ${names[record.kind]}`, state.tenant?.name || i18nText('Canal da empresa selecionada'), `<div class="accounts-dialog dialog-detail" data-connector-panel data-connector-token="${record.token}">${markup}</div>`);
    const form = panel()?.querySelector?.('form[data-connector-form]'), name = form?.dataset?.connectorForm;
    record.formBaseline = form && ['configuration','widget-settings'].includes(name) ? { name, values: Array.from(form.elements || []).filter(field => draftFields(name).includes(field.name)).map(field => ({name:field.name,type:field.type,value:String(field.value??''),checked:field.checked===true})) } : null;
    restoreDraft(record);
    if (shown(record)) panel()?.querySelector?.('[data-webchat-guide-heading]')?.focus?.({ preventScroll: true });
  }
  function editor(record, notice = '') {
    const value = record.status;
    if (record.kind === 'webchat' && record.guided) {
      record.adminSection = null;
      if (record.guideStep === 'install' || record.guideStep === 'validate') {
        const content = record.guideStep === 'install' ? renderWebchatInstallation({ status: value, token: record.token, platform: record.installPlatform, text: i18nText, escape: e, notice: translateCopy(notice) }) : renderWebchatValidation({ status: value, token: record.token, text: i18nText, escape: e, notice: translateCopy(notice) });
        show(record, guide(record, `${content}${renderWebchatServiceChoices({token:record.token,text:i18nText,escape:e})}`)); return;
      }
      const fields = i18nHtml`<label>Origens autorizadas<textarea name="origins" rows="4" maxlength="2000" placeholder="https://seusite.com">${e(value.origins.join('\n'))}</textarea><small>Uma origem exata por linha, até oito. Caminhos e curingas não são aceitos.</small></label>`;
      const form = `<form data-connector-form="configuration" data-connector-token="${record.token}" autocomplete="off"><fieldset class="person-scope"><legend>${i18nText('Configuração do canal')}</legend>${fields}${check(i18nText('Habilitar este canal'),'enabled',value.enabled)}</fieldset><p class="form-error" role="alert">${e(translateCopy(notice))}</p><div data-connector-server-current></div><div class="modal-actions">${button(record,'refresh',i18nText('Atualizar configuração'))}<button class="button primary" type="submit">${i18nText('Salvar e personalizar')}</button></div></form>`;
      show(record, guide(record, `<div class="webchat-install__authorization">${form}<aside>${summary(value)}<div class="modal-actions">${button(record,'identity-settings',i18nText('Identidade verificada'))}</div></aside></div>`)); return;
    }
    let fields = '';
    if (record.kind === 'webchat') fields = i18nHtml`<label>Origens autorizadas<textarea name="origins" rows="4" maxlength="2000" placeholder="https://seusite.com">${e(value.origins.join('\n'))}</textarea><small>Uma origem exata por linha, até oito. Caminhos e curingas não são aceitos.</small></label>`;
    else if (record.kind === 'email') fields = `${field(i18nText('Endereço do atendimento'), 'address', value.address, 'type="email" maxlength="254" required autocomplete="off"')}${password(i18nText('Segredo do relay de entrada'), 'ingressSecret', 512)}`;
    else fields = `${field(record.kind === 'messenger' ? i18nText('ID da Página do Facebook') : i18nText('ID da conta profissional do Instagram'), 'resourceId', value.resourceId, 'inputmode="numeric" maxlength="40" required autocomplete="off"')}${field(i18nText('Versão explícita da API Meta'), 'apiVersion', value.apiVersion, 'placeholder="vN.0" maxlength="7" required autocomplete="off"')}${password(i18nText('Token de acesso'), 'accessToken')}${password(i18nText('Segredo do app Meta'), 'appSecret')}${password(i18nText('Token de verificação do webhook'), 'verifyToken')}`;
    const help = record.kind === 'webchat' ? i18nMarkup('<p>O visitante conversa neste canal. Instale o widget somente nas origens cadastradas e teste a conversa com a equipe.</p>')
      : record.kind === 'email' ? i18nMarkup('<p>Este é o e-mail de atendimento, separado dos convites e recuperação da conta. O envio usa MepMail; a entrada precisa de caixa postal e relay externo assinado. O canal trabalha com texto. Configurar o relay não conecta uma caixa IMAP.</p>')
      : i18nHtml`<p>${record.kind === 'instagram' ? i18nText('Use uma conta profissional e a permissão instagram_business_manage_messages.') : i18nText('Use uma Página e a permissão pages_messaging.')} Cadastre as credenciais pelo formulário e configure o webhook no app Meta. A resposta exige uma mensagem do contato nas últimas 24 horas.</p><p>Salvar estes campos não comprova o aceite da conta, das permissões ou a entrega de uma resposta real.</p>`;
    const install = value.install ? i18nHtml`<fieldset class="person-scope"><legend>Instalar no seu site</legend><label>Código deste canal<textarea readonly rows="4" aria-label="Código de instalação do webchat" style="overflow-wrap:anywhere">${e(value.install.embedSnippet)}</textarea></label><small>Copie o código para o site autorizado. A instalação ainda precisa ser testada com um visitante real.</small></fieldset>` : '';
    const webhook = value.webhookUrl ? i18nHtml`<fieldset class="person-scope"><legend>${record.kind === 'email' ? i18nText('Relay de entrada') : i18nText('Webhook público')}</legend><label>URL deste canal<input readonly value="${e(value.webhookUrl)}" aria-label="URL de entrada do canal"/></label><small>${record.kind === 'email' ? i18nText('O relay precisa enviar o corpo original com timestamp e assinatura. A chave permanece privada no canal.') : i18nText('No app Meta, use esta URL e o token de verificação cadastrado. Os eventos precisam da assinatura do segredo do app.')}</small></fieldset>` : '';
    const widgetActions=record.kind==='webchat'?`<div class="modal-actions">${button(record,'widget-settings',i18nText('Personalizar chat'))}${button(record,'identity-settings',i18nText('Identidade verificada'))}</div>`:'';
    show(record, i18nHtml`${help}${summary(value)}<form data-connector-form="configuration" data-connector-token="${record.token}" autocomplete="off"><fieldset class="person-scope"><legend>Configuração do canal</legend>${fields}<label class="checkbox-label"><input type="checkbox" name="enabled" value="yes" ${value.enabled ? 'checked' : ''}/>Habilitar este canal</label></fieldset><p class="form-error" role="alert">${e(translateCopy(notice))}</p><div data-connector-server-current></div><div class="modal-actions">${button(record, 'refresh', i18nText('Atualizar configuração'))}<button class="button primary" type="submit" style="min-height:44px">Salvar configuração</button></div></form>${widgetActions}${webhook}${install}`);
  }
  function uncertain(record) {
    scrub();
    const content = i18nHtml`<p>A confirmação da gravação não chegou. Consulte o servidor antes de fazer outra alteração. Esta verificação não envia as credenciais novamente.</p>${button(record, 'verify', i18nText('Verificar configuração no servidor'))}<p class="form-error" role="alert"></p>`;
    show(record, record.guided ? guide(record, content) : content);
  }
  const paletteNames={panel:'Fundo do painel',header:'Cabeçalho',field:'Campos',border:'Bordas',text:'Texto',muted:'Texto secundário',primary:'Botão primário',primaryText:'Texto do botão',accent:'Destaque e foco'};
  const adminEndpoint=(record,section)=>endpoint(record).replace(/configuration$/,section==='widget'?'widget-configuration':'identity/status');
  const word=(value,max=600)=>typeof value==='string'&&!/[\x00-\x1f\x7f]/.test(value)?value.slice(0,max):'';
  const colorMap=value=>Object.fromEntries(Object.keys(paletteNames).filter(name=>/^#[0-9a-f]{6}$/i.test(value?.[name])).map(name=>[name,value[name]]));
  function adminDto(result,record,section){
    if(!result||!Number.isSafeInteger(result.version)||result.version<0||result.tenantId!==undefined&&result.tenantId!==record.tenantId||result.channelId!==undefined&&result.channelId!==record.channelId)throw Error(i18nText('O servidor não confirmou a revisão deste painel.'));
    if(section==='widget'){
      const source=result.widget;if(!source||typeof source!=='object'||Array.isArray(source))throw Error(i18nText('O servidor não confirmou a configuração do widget.'));
      const widget={};for(const name of ['displayName','openButtonLabel','avatarUrl','logoUrl','handoffNotificationEmail'])widget[name]=word(source[name],name.endsWith('Url')?1000:254);
      widget.theme=source.theme==='dark'?'dark':'light';widget.radius=Number.isInteger(source.radius)&&source.radius>=0&&source.radius<=24?source.radius:16;widget.colors=colorMap(source.colors);widget.lightColors=colorMap(source.lightColors);
      widget.credit={visible:source.credit?.visible!==false,text:word(source.credit?.text,120)};
      for(const name of ['greeting','verifiedGreeting','handoffMessage','awaitingMessage'])widget[name]={'pt-BR':word(source[name]?.['pt-BR']),en:word(source[name]?.en)};
      for(const name of ['emailPrompt','feedbackEnabled'])widget[name]=source[name]===true;for(const name of ['attachmentsEnabled','voiceEnabled'])widget[name]=source[name]!==false;
      widget.assistantInstructions=typeof source.assistantInstructions==='string'?source.assistantInstructions.slice(0,4000):'';return {version:result.version,widget};
    }
    if(result.tenantId!==record.tenantId||result.channelId!==record.channelId||typeof result.enabled!=='boolean'||!Array.isArray(result.keys)||result.keys.length>64)throw Error(i18nText('O servidor não confirmou a identidade deste canal.'));
    if(result.scope!==undefined&&!['user','account-user'].includes(result.scope))throw Error(i18nText('O servidor não confirmou a identidade deste canal.'));
    return {version:result.version,enabled:result.enabled,scope:result.scope||'user',issuer:word(result.issuer,240),externalIdPrefix:word(result.externalIdPrefix,32),audience:word(result.audience,160),keys:result.keys.map(item=>{if(!identity(item.kid)||!['active','expired','revoked'].includes(item.state))throw Error(i18nText('Metadados da chave inválidos.'));return {kid:item.kid,state:item.state,current:item.current===true,validUntil:Number.isSafeInteger(item.validUntil)?item.validUntil:null};})};
  }
  const check=(label,name,enabled)=>`<label class="checkbox-label"><input type="checkbox" name="${name}" value="yes" ${enabled?'checked':''}/>${e(label)}</label>`;
  const adminForm=(record,name,body)=>`<form data-connector-form="${name}" data-connector-token="${record.token}" autocomplete="off">${body}</form>`;
  function adminEditor(record,section,notice=''){
    scrub();record.adminSection=section;
    const footer=`<p class="form-error" role="alert">${e(notice)}</p><div data-connector-server-current></div><div class="modal-actions">${button(record,'admin-refresh',i18nText('Consultar estado no servidor'))}${button(record,'back-configuration',i18nText('Voltar ao canal'))}</div>`;
    if(section==='widget'){
      if (record.guided) record.guideStep = 'appearance';
      const value=record.widgetStatus.widget;
      const basics=field(i18nText('Nome exibido'),'displayName',value.displayName,'maxlength="80"')+field(i18nText('Texto do botão de abrir'),'openButtonLabel',value.openButtonLabel,'maxlength="80"')+field(i18nText('Avatar HTTPS público'),'avatarUrl',value.avatarUrl,'type="url" maxlength="1000"')+field(i18nText('Logo HTTPS público'),'logoUrl',value.logoUrl,'type="url" maxlength="1000"')+field(i18nText('Raio dos cantos (0–24 px)'),'radius',value.radius,'type="number" min="0" max="24"');
      const theme=`<fieldset class="person-scope"><legend>${i18nText('Tema')}</legend>${['light','dark'].map(name=>`<label class="checkbox-label"><input type="radio" name="theme" value="${name}" ${value.theme===name?'checked':''}/>${i18nText(name==='light'?'Claro':'Escuro')}</label>`).join('')}</fieldset>`;
      const palette=['colors','lightColors'].map(group=>`<details><summary>${i18nText(group==='colors'?'Paleta do widget':'Paleta clara opcional')}</summary><div class="widget-designer__colors">${Object.entries(paletteNames).map(([name,label])=>`<label>${i18nText(label)}<span class="widget-designer__color"><input type="color" value="${e(value[group][name]||'#000000')}" data-widget-preview-color="${group}-${name}" aria-label="${e(i18nText(label))}"/><input name="${group}-${name}" value="${e(value[group][name]||'')}" maxlength="7" placeholder="#000000" spellcheck="false"/></span></label>`).join('')}<small>${i18nText('Use cores hexadecimais com seis dígitos. Campos vazios usam o tema padrão.')}</small></div></details>`).join('');
      const messages=['greeting','verifiedGreeting','handoffMessage','awaitingMessage'].map(name=>`<fieldset class="person-scope"><legend>${i18nText(name==='greeting'?'Saudação ao abrir':name==='verifiedGreeting'?'Saudação para contato verificado':name==='awaitingMessage'?'Aviso enquanto ninguém respondeu (opcional)':'Mensagem ao chamar uma pessoa')}</legend>${['pt-BR','en'].map(locale=>`<label>${locale}<textarea name="${name}-${locale}" rows="2" maxlength="600">${e(value[name][locale])}</textarea></label>`).join('')}</fieldset>`).join('');
      const options=check(i18nText('Pedir e-mail opcional e contato de retorno'),'emailPrompt',value.emailPrompt)+check(i18nText('Permitir anexos'),'attachmentsEnabled',value.attachmentsEnabled)+check(i18nText('Permitir gravação de áudio'),'voiceEnabled',value.voiceEnabled)+check(i18nText('Pedir avaliação ao encerrar'),'feedbackEnabled',value.feedbackEnabled)+check(i18nText('Mostrar crédito'),'creditVisible',value.credit.visible)+field(i18nText('Texto do crédito'),'creditText',value.credit.text,'maxlength="120"');
      const privateFields=field(i18nText('E-mail para aviso de transferência'),'handoffNotificationEmail',value.handoffNotificationEmail,'type="email" maxlength="254"')+`<label>${i18nText('Instruções do assistente neste canal')}<textarea name="assistantInstructions" rows="6" maxlength="4000">${e(value.assistantInstructions)}</textarea><small>${i18nText('Estas instruções e o destino do aviso permanecem privados. Não alteram os outros canais.')}</small></label>`;
      const hermes=`<p>${i18nText('O Hermes responde com o perfil e as fontes autorizadas para esta operação. Estas orientações são específicas deste canal.')}</p>${privateFields}<a class="button" href="#agents">${i18nText('Configurar perfil, conhecimento e memória')}</a><p>${i18nText('Para usar arquivos e memória nativa do seu Hermes, conecte seu agente por MCP. A memória revisada da Elozi continua separada.')}</p><a class="button" href="#agents/connect">${i18nText('Conectar meu Hermes')}</a>`;
      const designer=renderWidgetDesigner({sections:{appearance:`${basics}${theme}${palette}`,copy:`<p>${i18nText('A aparência vale antes e depois de abrir. A saudação não cria conversa; use {firstName} para o contato verificado.')}</p>${messages}`,behavior:options,hermes},widget:value,locale:getLocale(),text:i18nText,escape:e});
      const content = `${adminForm(record,'widget-settings',`${designer}<div class="widget-designer__save"><span>${i18nText('A prévia não envia mensagens. Salvar aplica as alterações somente neste canal.')}</span><button class="button primary" type="submit" style="min-height:44px">${i18nText('Salvar aparência e atendimento')}</button></div>`)}${record.guided ? renderWebchatServiceChoices({token:record.token,text:i18nText,escape:e}) : ''}${footer}`;
      show(record, record.guided ? guide(record, content) : content);
      disposeDesigner=mountWidgetDesigner(panel(),{widget:value,locale:getLocale(),text:i18nText,guard:()=>shown(record)&&record.adminSection==='widget'&&!writing&&!record.adminConflict&&!record.adminUncertain});return;
    }
    const value=record.identityStatus,active=value.keys.filter(item=>item.state==='active');
    const configure=adminForm(record,'identity-configure',`${field(i18nText('Origem emissora autorizada'),'issuer',value.issuer,'type="url" maxlength="240" required')}${field(i18nText('Prefixo estável da identidade'),'externalIdPrefix',value.externalIdPrefix,'maxlength="32" required')}${check(i18nText('Habilitar identidade verificada'),'enabled',value.enabled)}${check(i18nText('Separar histórico por conta e usuário (JWT v2)'),'accountUser',value.scope==='account-user')}<p>${i18nText('Ative após publicar o JWT v2 no SaaS. O histórico antigo permanece separado; sessões anteriores precisam entrar novamente.')}</p><button class="button primary" type="submit" style="min-height:44px">${i18nText('Salvar identidade')}</button>`);
    const keyForm=(action,label,kid='')=>adminForm(record,`identity-${action}`,`${kid?`<input type="hidden" name="kid" value="${e(kid)}"/>`:''}${check(i18nText('Confirmo esta alteração de chave neste canal'),'confirmKey',false)}<button class="button" type="submit" style="min-height:44px">${label}</button>`);
    const keys=value.keys.map(item=>`<li><code>${e(item.kid)}</code> · ${i18nText(item.state==='active'?'Ativa':item.state==='revoked'?'Revogada':'Expirada')}${item.validUntil?` · ${e(new Date(item.validUntil).toISOString())}`:''}${item.state==='active'?keyForm('revoke-key',i18nText('Revogar esta chave'),item.kid):''}</li>`).join('');
    show(record,`<p>${i18nText('O servidor do produto assina o JWT. O segredo nunca vai para o navegador do visitante, prompt, URL ou configuração pública.')}</p><p>${i18nText('Criar ou rotacionar gera um segredo novo, mostrado uma única vez. Entregue-o pelo canal privado autorizado e preserve o perfil do agente.')}</p><p><strong>aud</strong> <code>${e(value.audience)}</code> · HS256 · ${i18nText('Validade máxima de 10 minutos')}</p>${configure}<ul>${keys}</ul>${active.length===0?keyForm('create-key',i18nText('Criar chave de assinatura')):active.length===1?keyForm('rotate-key',i18nText('Rotacionar chave de assinatura')):`<p>${i18nText('A chave anterior continua válida durante a rotação. Aguarde o prazo ou revogue-a explicitamente.')}</p>`}<label>${i18nText('Segredo mostrado uma única vez')}<input type="password" readonly value="" autocomplete="off" data-identity-secret aria-label="${i18nText('Segredo de assinatura privado')}"/></label><div class="modal-actions">${button(record,'show-identity-secret',i18nText('Mostrar ou ocultar segredo'))}${button(record,'copy-identity-secret',i18nText('Copiar segredo'))}</div>${footer}`);
  }
  async function readAdmin(record,section){
    if(!shown(record)||record.kind!=='webchat')return false;scrub();readController?.abort();const controller=new AbortController();readController=controller;const ticket=++sequence;
    try{const result=await api(adminEndpoint(record,section),{method:'GET',headers:headers(record),signal:controller.signal});if(!shown(record)||ticket!==sequence){if(view===record&&!current(record))closeOwn();return false;}const value=adminDto(result,record,section);record[section==='widget'?'widgetStatus':'identityStatus']=value;const uncertain=record.adminUncertain;record.adminUncertain=false;
      if(record.adminConflict&&record.adminSection===section){record.adminConflict=false;feedback(i18nText('Revisão atual consultada. Seus campos foram mantidos; revise antes de salvar.'));setSubmitDisabled(false);}else adminEditor(record,section,uncertain?i18nText('Estado consultado sem repetir a alteração. Segredos anteriores não são recuperáveis; qualquer rotação exige uma nova decisão explícita.'):'');return true;
    }catch(failure){if(shown(record)&&ticket===sequence&&failure.name!=='AbortError'){if([401,403,404].includes(failure.status)){closeOwn();toast(messageFor(failure),true);}else feedback(messageFor(failure));}return false;}
  }
  function widgetBody(form,record){
    const values=new FormData(form),get=name=>String(values.get(name)||'').trim(),widget={};
    for(const name of ['displayName','openButtonLabel','avatarUrl','logoUrl','handoffNotificationEmail'])widget[name]=get(name);
    if(widget.displayName.length>80||widget.openButtonLabel.length>80)throw Error(i18nText('Use até 80 caracteres para nome e botão.'));
    for(const name of ['avatarUrl','logoUrl'])if(widget[name]){let url;try{url=new URL(widget[name]);}catch{throw Error(i18nText('Use uma imagem HTTPS pública.'));}if(url.protocol!=='https:'||url.username||url.password||url.hash||widget[name].length>1000)throw Error(i18nText('Use uma imagem HTTPS pública.'));}
    widget.theme=get('theme');widget.radius=Number(get('radius'));if(!['light','dark'].includes(widget.theme)||!Number.isInteger(widget.radius)||widget.radius<0||widget.radius>24)throw Error(i18nText('Confira o tema e o raio de 0 a 24 px.'));
    for(const group of ['colors','lightColors']){widget[group]={};for(const name of Object.keys(paletteNames)){const value=get(`${group}-${name}`);if(value&&!/^#[0-9a-f]{6}$/i.test(value))throw Error(i18nText('Use cores hexadecimais com seis dígitos.'));if(value)widget[group][name]=value;}}
    for(const name of ['greeting','verifiedGreeting','handoffMessage','awaitingMessage']){widget[name]={};for(const locale of ['pt-BR','en']){const value=get(`${name}-${locale}`);if(value.length>600||/[\x00-\x1f\x7f]/.test(value))throw Error(i18nText('Use mensagens de até 600 caracteres, sem quebras de linha.'));widget[name][locale]=value;}}
    for(const name of ['emailPrompt','attachmentsEnabled','voiceEnabled','feedbackEnabled'])widget[name]=values.get(name)!==null;widget.credit={visible:values.get('creditVisible')!==null,text:get('creditText')};
    widget.assistantInstructions=String(values.get('assistantInstructions')||'').trim();if(widget.assistantInstructions.length>4000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(widget.assistantInstructions))throw Error(i18nText('Use instruções de até 4.000 caracteres.'));if(widget.handoffNotificationEmail&&!email(widget.handoffNotificationEmail))throw Error(i18nText('Informe um e-mail de aviso válido.'));
    return {version:record.widgetStatus.version,widget};
  }
  async function submitAdmin(form,record){
    const name=form.dataset.connectorForm,section=name==='widget-settings'?'widget':'identity';if(!record[section==='widget'?'widgetStatus':'identityStatus']||record.adminConflict||record.adminUncertain)throw Error(i18nText('Consulte o estado atual antes de salvar novamente.'));if(writing)return true;
    const values=new FormData(form);let body,path=adminEndpoint(record,section);if(section==='widget')body=widgetBody(form,record);else{body={version:record.identityStatus.version};const action=name.slice(9);path=path.replace(/status$/,action);
      if(action==='configure'){body.enabled=values.get('enabled')!==null;body.scope=values.get('accountUser')!==null?'account-user':'user';body.issuer=origin(String(values.get('issuer')||'').trim());body.externalIdPrefix=String(values.get('externalIdPrefix')||'').trim();if(!/^[a-z][a-z0-9_-]{0,31}$/.test(body.externalIdPrefix)||!record.status.origins.includes(body.issuer))throw Error(i18nText('Use uma origem autorizada e um prefixo estável em letras minúsculas.'));}
      else{if(values.get('confirmKey')===null)throw Error(i18nText('Confirme explicitamente a alteração de chave.'));if(action==='revoke-key'){body.kid=String(values.get('kid')||'');if(!record.identityStatus.keys.some(item=>item.kid===body.kid&&item.state==='active'))throw Error(i18nText('Consulte a chave ativa antes de revogar.'));}}
    }
    sequence++;readController?.abort();writing=true;setSubmitDisabled(true);scrub();let result,accepted=false;
    try{result=await api(path,{method:'POST',headers:headers(record),body:JSON.stringify(body)});if(!shown(record)){if(view===record&&!current(record))closeOwn();return true;}const value=adminDto(result,record,section);if(value.version!==body.version+1)throw Error(i18nText('A alteração ainda não foi confirmada.'));record[section==='widget'?'widgetStatus':'identityStatus']=value;if(section==='widget')delete record.drafts['widget-settings'];adminEditor(record,section,i18nText('Configuração salva.'));
      if(section==='identity'&&['identity-create-key','identity-rotate-key'].includes(name)){if(typeof result.secret!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(result.secret)||!value.keys.some(item=>item.kid===result.kid&&item.state==='active'))throw Error(i18nText('O servidor não confirmou o segredo desta chave.'));const input=panel()?.querySelector?.('[data-identity-secret]');if(input&&shown(record))input.value=result.secret;}
      accepted=true;result=null;await onUpdate(value);if(!current(record))closeOwn();
    }catch(failure){if(!shown(record)){if(view===record&&!current(record))closeOwn();return true;}if(accepted&&![401,403,404].includes(failure.status)){feedback(i18nText('Configuração salva; atualize a tela para conferir os dados.'));}else{scrub();if([401,403,404].includes(failure.status)){closeOwn();toast(messageFor(failure),true);}else if([400,409,413,422,429].includes(failure.status)){record.adminConflict=failure.status===409;feedback(messageFor(failure));}else{record.adminUncertain=true;feedback(i18nText('Confirmação pendente. Consulte o estado no servidor; não repita automaticamente uma alteração de chave.'));}}}
    finally{body=null;result=null;writing=false;if(shown(record))setSubmitDisabled(Boolean(record.adminConflict||record.adminUncertain));}return true;
  }
  const messageFor = failure => failure.code === 'DEMO_COMPANY' ? failure.message : failure.status === 409 ? i18nText('A configuração mudou no servidor. Suas alterações foram mantidas. Atualize os dados antes de salvar novamente.')
    : [401, 403].includes(failure.status) ? i18nText('Seu acesso mudou. Entre novamente e abra este canal no acesso autorizado.')
      : failure.status === 404 ? i18nText('Este canal não está disponível na empresa selecionada.') : i18nText('Não foi possível concluir esta configuração. Revise os campos e o acesso ao canal.');
  function setSubmitDisabled(disabled) { panel()?.querySelectorAll?.('[type="submit"]').forEach(node => { node.disabled = disabled; }); }
  function publicExpected(body, kind) { return { enabled: body.enabled, ...(kind === 'webchat' ? { origins: [...body.origins] } : kind === 'email' ? { address: body.address } : { resourceId: body.resourceId, apiVersion: body.apiVersion }) }; }
  function matches(value, expected) { return Object.entries(expected).every(([name, item]) => Array.isArray(item) ? JSON.stringify(value[name]) === JSON.stringify(item) : value[name] === item); }

  async function read(record, { preserve = false, verify = false } = {}) {
    if (!shown(record)) return false;
    readController?.abort(); readController = new AbortController(); const controller = readController, ticket = ++sequence;
    try {
      const result = await api(endpoint(record), { method: 'GET', headers: headers(record), signal: controller.signal });
      if (!shown(record) || ticket !== sequence) { if (view === record && !current(record)) closeOwn(); return false; }
      const value = dto(result, record); record.status = value;
      if (verify) {
        const intent = pending.get(pendingKey(record));
        pending.delete(pendingKey(record)); record.uncertain = false;
        const confirmed = intent && value.version === intent.version + 1 && matches(value, intent.expected);
        const notice = confirmed ? intent.hasSecrets ? i18nText('A configuração pública corresponde à tentativa. Valores privados não são devolvidos; confirme as credenciais na jornada real do canal.') : i18nText('A configuração enviada foi confirmada no servidor.')
          : intent && value.version === intent.version ? i18nText('O servidor mantém a revisão anterior. Revise os campos e salve explicitamente se ainda quiser alterar.') : i18nText('O servidor mostra outra revisão. Confira os dados atuais antes de fazer uma nova alteração.');
        editor(record, notice);
        if (current(record)) { try { await onUpdate(value); } catch { if (shown(record)) toast(i18nText('Configuração consultada; atualize a tela para conferir os dados.'), true); } }
      } else if (preserve) {
        record.conflict = false; feedback(i18nText('Dados atuais consultados. Suas alterações foram mantidas; confira a revisão abaixo antes de salvar.'));
        const slot = panel()?.querySelector?.('[data-connector-server-current]'); if (slot) slot.innerHTML = summary(value);
        setSubmitDisabled(false);
      } else editor(record);
      return true;
    } catch (failure) {
      if (!shown(record) || ticket !== sequence || failure.name === 'AbortError') return false;
      if ([401, 403, 404].includes(failure.status)) { closeOwn(); toast(messageFor(failure), true); }
      else feedback(failure.status ? messageFor(failure) : i18nText('A consulta não confirmou a configuração. Tente verificar novamente.'));
      return false;
    }
  }

  async function open(channel, { step = 'authorize', guided = true } = {}) {
    if (!channel || !Object.hasOwn(names, channel.kind)) return false;
    if (!allowed() || !state.tenant?.channels?.some(item => item.id === channel.id && item.kind === channel.kind)) { toast(i18nText('A configuração de canais pertence ao administrador desta empresa.'), true); return false; }
    readController?.abort(); scrub();
    const c = context(), record = { key: key(), token: String(++sequence), workspaceId: c.workspaceId, authority: c.authority, tenantId: c.tenantId,
      channelId: channel.id, kind: channel.kind, status: null, conflict: false, uncertain: pending.has(JSON.stringify([key(), channel.id])),
      guided: channel.kind === 'webchat' && guided !== false, guideStep: step === 'install' || step === 'validate' ? step : 'authorize', installPlatform: 'html', drafts: {} };
    view = record;
    show(record, i18nHtml`<p role="status">Consultando configuração deste canal…</p><p class="form-error" role="alert"></p>${button(record, 'refresh', i18nText('Tentar novamente'))}`);
    const opened = await read(record, { verify: record.uncertain });
    if (opened && shown(record) && record.guided && step === 'appearance') return readAdmin(record, 'widget');
    return opened;
  }

  async function openWidget(channel) {
    if(channel?.kind!=='webchat')return false;
    const opened=await open(channel,{guided:false}),record=view;
    if(!opened||!record||record.channelId!==channel.id||!shown(record))return false;
    return readAdmin(record,'widget');
  }

  async function action(node) {
    const action = node?.dataset?.connectorAction;
    const guideActions = [...WEBCHAT_INSTALL_STEPS.map(step => `webchat-step-${step}`), ...WEBCHAT_INSTALL_PLATFORMS.map(platform => `webchat-platform-${platform}`), 'copy-webchat-code','test-journey','webchat-open-team','webchat-open-agents','webchat-open-connect'];
    if (!['refresh','verify','widget-settings','identity-settings','admin-refresh','back-configuration','show-identity-secret','copy-identity-secret',...guideActions].includes(action)) return false;
    const record = view;
    if (!record || node.dataset.connectorToken !== record.token || !shown(record)) { if (!current(record)) closeOwn(); return true; }
    if (writing) { feedback(i18nText('Aguarde a gravação atual antes de consultar outra revisão.')); return true; }
    if (guideActions.includes(action)) {
      if (record.kind !== 'webchat' || !record.guided) return true;
      if (record.conflict || record.uncertain || record.adminConflict || record.adminUncertain) { feedback(i18nText('Salve ou consulte a revisão atual antes de mudar de etapa.')); return true; }
      if (action === 'copy-webchat-code') {
        if (record.guideStep !== 'install' || record.adminSection || record.copying || !webchatInstallReadiness(record.status)) return true;
        const token = record.token, valid = () => shown(record) && record.token === token && record.guideStep === 'install' && !record.adminSection;
        record.copying = true; node.disabled = true;
        const notice = message => { const target = panel()?.querySelector?.('[data-webchat-copy-status]'); if (target) target.textContent = message; else feedback(message); };
        try { await copyWebchatInstallCode({ snippet: record.installPlatform==='saas'?record.status.install.authenticatedSnippet:record.status.install.embedSnippet, guard: valid,
          onSuccess: () => notice(i18nText('Código copiado. Publique no site autorizado e valide a conversa.')),
          onFailure: () => notice(i18nText('Não foi possível copiar. Selecione o código acima e copie manualmente.')) }); }
        finally { record.copying = false; if (valid()) node.disabled = false; }
        return true;
      }
      if (action === 'test-journey') {
        if (record.guideStep !== 'validate' || record.adminSection || !webchatInstallReadiness(record.status)) return true;
        const target = { channelId: record.channelId, tenantId: record.tenantId, workspaceId: record.workspaceId };
        if (!shown(record)) return true;
        closeOwn();
        if (typeof onTestJourney === 'function') await onTestJourney(target);
        else if (globalThis.location) globalThis.location.hash = formatHash({ section: 'channels', params: { channelId: target.channelId, tab: 'test' } });
        return true;
      }
      if (action.startsWith('webchat-open-')) {
        const target = { 'webchat-open-team':'#settings/team', 'webchat-open-agents':'#agents', 'webchat-open-connect':'#agents/connect' }[action];
        if (target && shown(record)) { closeOwn(); if (globalThis.location) globalThis.location.hash = target; } return true;
      }
      captureDraft(record); scrub();
      if (action.startsWith('webchat-platform-')) { if(record.guideStep!=='install'||record.adminSection)return true;record.installPlatform = action.slice('webchat-platform-'.length); editor(record); return true; }
      const step = action.slice('webchat-step-'.length);
      if (step === 'appearance') {
        if (record.widgetStatus) adminEditor(record, 'widget'); else await readAdmin(record, 'widget');
      } else { record.guideStep = step; record.adminSection = null; editor(record); }
      return true;
    }
    if(!['refresh','verify'].includes(action)){
      if(record.kind!=='webchat')return true;
      if(action==='widget-settings'||action==='identity-settings'){captureDraft(record);await readAdmin(record,action==='widget-settings'?'widget':'identity');return true;}
      if(action==='admin-refresh'){captureDraft(record);await readAdmin(record,record.adminSection||'widget');return true;}
      if(action==='back-configuration'){captureDraft(record);scrub();record.adminSection=null;record.adminConflict=false;record.adminUncertain=false;if(record.guided)record.guideStep='authorize';editor(record);return true;}
      const input=panel()?.querySelector?.('[data-identity-secret]');if(!input?.value)return true;
      if(action==='show-identity-secret'){input.type=input.type==='password'?'text':'password';return true;}
      let secret=input.value;try{if(!globalThis.navigator?.clipboard?.writeText)throw Error();await globalThis.navigator.clipboard.writeText(secret);if(shown(record))feedback(i18nText('Segredo copiado por sua solicitação. Entregue somente pelo canal privado autorizado.'));}catch{if(shown(record))feedback(i18nText('Não foi possível copiar. Selecione o segredo no formulário privado.'));}finally{secret=null;}return true;
    }
    captureDraft(record);
    await read(record, { verify: record.uncertain || action === 'verify', preserve: record.conflict });
    return true;
  }

  function bodyFor(form, record) {
    const values = new FormData(form), body = { version: record.status.version, enabled: values.get('enabled') !== null };
    if (record.kind === 'webchat') {
      const lines = String(values.get('origins') || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean);
      if (lines.length > 8 || body.enabled && !lines.length) throw new Error(i18nText('Informe de uma a oito origens para habilitar o webchat.'));
      body.origins = [...new Set(lines.map(origin))];
    } else if (record.kind === 'email') {
      body.address = String(values.get('address') || '').trim().toLowerCase();
      if (!email(body.address)) throw new Error(i18nText('Informe um endereço de atendimento válido.'));
      const secret = String(values.get('ingressSecret') || '');
      if (secret && !/^[A-Za-z0-9_-]{32,512}$/.test(secret)) throw new Error(i18nText('Use um segredo de relay com 32 a 512 letras, números, hífen ou sublinhado.'));
      if (secret) body.ingressSecret = secret;
      if (body.enabled && record.status.version === 0 && !secret) throw new Error(i18nText('Cadastre o segredo do relay para habilitar a entrada.'));
    } else {
      body.resourceId = String(values.get('resourceId') || '').trim(); body.apiVersion = String(values.get('apiVersion') || '').trim();
      if (!/^\d{1,40}$/.test(body.resourceId) || !/^v[1-9]\d{0,2}\.0$/.test(body.apiVersion)) throw new Error(i18nText('Informe o ID numérico do recurso e uma versão explícita da API, no formato vN.0.'));
      for (const name of ['accessToken', 'appSecret', 'verifyToken']) {
        const value = String(values.get(name) || '');
        if (value && (value.length < 8 || value.length > 8192 || value !== value.trim() || /\p{Cc}/u.test(value))) throw new Error(i18nText('Revise os campos privados do app Meta.'));
        if (value) body[name] = value;
        if (record.status.version === 0 && !value) throw new Error(i18nText('Cadastre os três valores privados para configurar este canal Meta.'));
      }
    }
    return body;
  }

  async function submit(form) {
    const formName=form?.dataset?.connectorForm,adminForms=['widget-settings','identity-configure','identity-create-key','identity-rotate-key','identity-revoke-key'];
    if (formName !== 'configuration'&&!adminForms.includes(formName)) return false;
    const record = view;
    if (!record || form.dataset.connectorToken !== record.token || !shown(record) || !record.status) { if (!current(record)) closeOwn(); throw new Error(i18nText('Abra a configuração deste canal novamente antes de salvar.')); }
    if(adminForms.includes(formName)){if(record.kind!=='webchat')return true;return submitAdmin(form,record);}
    if (record.uncertain || record.conflict) throw new Error(i18nText('Consulte a configuração atual antes de salvar novamente.'));
    if (writing) return true;
    let body;
    try { body = bodyFor(form, record); } catch (failure) { feedback(translateError(failure.message)); throw failure; }
    const intent = { version: record.status.version, expected: publicExpected(body, record.kind), hasSecrets: privateFields.some(name => Object.hasOwn(body, name)) };
    sequence++;readController?.abort();writing = true; setSubmitDisabled(true); let accepted = false;
    try {
      const result = await api(endpoint(record), { method: 'POST', headers: headers(record), body: JSON.stringify(body) });
      if (!shown(record)) { if (view === record && !current(record)) closeOwn(); return true; }
      const value = dto(result, record);
      if (value.version !== intent.version + 1 || !matches(value, intent.expected)) throw new Error(i18nText('A configuração enviada ainda não foi confirmada.'));
      accepted = true; scrub(); record.status = value; pending.delete(pendingKey(record));delete record.drafts.configuration;
      await onUpdate(value);
      if (shown(record)) {
        if (record.kind === 'webchat' && record.guided) {
          if (webchatInstallReadiness(value)) await readAdmin(record, 'widget');
          else { record.guideStep = 'authorize'; editor(record, i18nText('Confira e salve a origem para seguir com a configuração ativa.')); }
          if (shown(record)) toast(i18nText('Configuração salva.'));
        } else { closeOwn(); toast(i18nText('Configuração salva.')); }
      }
    } catch (failure) {
      if (!shown(record)) { if (view === record && !current(record)) closeOwn(); return true; }
      if (accepted) { if(record.kind==='webchat'&&record.guided)editor(record,i18nText('Configuração salva; atualize a tela para conferir os dados.'));else closeOwn();toast(i18nText('Configuração salva; atualize a tela para conferir os dados.'), true); }
      else if ([400, 401, 403, 404, 409, 413, 422, 429].includes(failure.status)) {
        if ([401, 403, 404].includes(failure.status)) { closeOwn(); toast(messageFor(failure), true); }
        else { record.conflict = failure.status === 409; feedback(messageFor(failure)); }
      } else {
        pending.set(pendingKey(record), intent); record.uncertain = true; uncertain(record);
      }
    } finally {
      body = null; writing = false;
      if (shown(record)) setSubmitDisabled(record.conflict || record.uncertain);
    }
    return true;
  }

  return { open, openWidget, action, submit, reset };
}
