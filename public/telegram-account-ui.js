import { t as defaultT, getLocale } from './i18n.js';
import './locales-telegram-account.js';

const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,199}$/.test(value);
const peer = value => typeof value === 'string' && /^-?[1-9]\d{0,18}$/.test(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const STATES = new Set(['disconnected', 'connecting', 'connected', 'failed']);
const AUTH_STATES = new Set(['idle', 'connecting', 'qr', 'code', 'password', 'authenticated', 'expired', 'error']);
const PRIVATE_FIELDS = ['apiId', 'apiHash', 'phoneNumber', 'code', 'password'];
const ACTIVE_AUTH = new Set(['connecting', 'qr', 'code', 'password']);
const POLLED_AUTH = new Set(['connecting', 'qr']);
const AUTH_ERRORS = Object.freeze({
  PHONE_CODE_INVALID: 'Código inválido. Confira o código recebido no Telegram.',
  PHONE_CODE_EXPIRED: 'Código expirado. Cancele esta autenticação e inicie uma nova.',
  PASSWORD_HASH_INVALID: 'Senha incorreta. Confira a senha de verificação em duas etapas.',
  EMAIL_AUTH_UNSUPPORTED: 'A autenticação por e-mail não está disponível neste canal. Use QR.',
  AUTH_RATE_LIMITED: 'O Telegram limitou as tentativas. Aguarde antes de iniciar novamente.',
  AUTH_TIMEOUT: 'A autenticação não respondeu no prazo. Confira o estado antes de iniciar novamente.',
  AUTH_EXPIRED: 'A autenticação expirou. Inicie uma nova conexão.',
  AUTH_FAILED: 'Não foi possível autenticar esta conta. Confira o estado e inicie uma nova conexão.',
});
const LABELS = Object.freeze({ idle: 'Conexão pessoal ainda não autenticada', connecting: 'Autenticando a conta', qr: 'QR aguardando confirmação no Telegram', code: 'Código de acesso necessário', password: 'Senha de duas etapas necessária', authenticated: 'Conta autenticada', expired: 'Autenticação expirada', error: 'Não foi possível autenticar esta conta' });
const staleError = () => Object.assign(new Error(defaultT('O contexto desta conexão mudou. Abra novamente na empresa e no acesso autorizados.')), { stale: true });
const translate = options => typeof options?.i18n === 'function' ? options.i18n : options?.i18n?.t || defaultT;

/** Pure markup. Only an opaque locally-created blob URL is accepted for the private QR image. */
export function renderTelegramAccountConnection(model = {}, options = {}) {
  const t = translate(options), e = options.escape || escapeHTML;
  const status = model.status || {}, token = id(model.token) ? model.token : 'unbound';
  const authenticated = status.state === 'connected' && status.authState === 'authenticated';
  const busy = model.busy || model.loading, locked = Boolean(busy || model.uncertain || model.conflict || model.confirmDisconnect);
  const disabled = locked ? ' disabled' : '';
  const action = (name, label, primary = false, permitted = true) => `<button type="button" class="button${primary ? ' primary' : ''}" data-telegram-account-action="${name}" data-telegram-account-token="${token}"${!permitted || busy && name !== 'close' || model.confirmDisconnect && !['confirm-disconnect', 'keep', 'close'].includes(name) || locked && !['refresh', 'close', 'confirm-disconnect', 'keep'].includes(name) ? ' disabled' : ''}>${e(t(label))}</button>`;
  const formAttrs = name => `data-telegram-account-form="${name}" data-telegram-account-token="${token}" autocomplete="off" aria-busy="${Boolean(busy)}"`;
  const submit = (label, permitted = true) => `<button type="submit" class="button primary"${locked || !permitted ? ' disabled' : ''}>${e(t(label))}</button>`;
  const input = (name, label, attrs = '') => `<label for="telegram-account-${name}">${e(t(label))}<input id="telegram-account-${name}" name="${name}" value="" ${attrs}${disabled}/></label>`;
  const qrExpired = model.qrExpired === true;
  const authState = qrExpired && status.authState === 'qr' ? 'expired' : status.authState || 'idle';
  const stateLabel = status.configured && authState === 'idle' ? 'Aplicativo cadastrado · autenticação pendente' : LABELS[authState] || LABELS.error;
  const step = model.receipt ? 'history' : authenticated ? 'dialogs' : status.configured ? 'auth' : 'application';
  const steps = [['application', 'Aplicativo'], ['auth', 'Autenticação'], ['dialogs', 'Conversas'], ['history', 'Histórico']];
  const guide = `<details class="telegram-account__guide"${!status.configured ? ' open' : ''}>
    <summary>${e(t('Como obter API ID e API hash'))}</summary>
    <div class="telegram-account__guide-body">
      <p class="telegram-account__lead">${e(t('Faça este cadastro uma vez no site oficial do Telegram. Depois, volte à Elozi com as duas credenciais.'))}</p>
      <ol class="telegram-account__guide-steps">
        <li><h4>${e(t('Entre com o número da sua conta'))}</h4><p>${e(t('Abra my.telegram.org e informe o telefone com +, código do país e DDD. No Brasil, use +55 seguido do DDD e do número.'))}</p><p>${e(t('O código de confirmação chega no aplicativo Telegram, não por SMS. Digite esse código no site do Telegram.'))}</p><a href="https://my.telegram.org/auth" target="_blank" rel="noopener noreferrer">${e(t('Acessar my.telegram.org'))}</a></li>
        <li><h4>${e(t('Abra API development tools'))}</h4><p>${e(t('Depois de entrar, escolha API development tools. Se já houver um aplicativo, reutilize seu API ID e API hash: o Telegram permite um API ID por número.'))}</p><a href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer">${e(t('Abrir API development tools'))}</a></li>
        <li><h4>${e(t('Cadastre o aplicativo, se ainda não existir'))}</h4><p>${e(t('Preencha os campos do Telegram com os dados da sua integração. Os valores abaixo são exemplos.'))}</p><dl class="telegram-account__guide-fields">
          <div><dt>App title</dt><dd><span class="telegram-account__guide-example">Elozi</span><span>${e(t('Nome para identificar seu aplicativo.'))}</span></dd></div>
          <div><dt>${e(t('Nome curto (Short name)'))}</dt><dd><span class="telegram-account__guide-example">elozisuaempresa</span><span>${e(t('Use um nome alfanumérico exclusivo, com 5–32 caracteres; adapte o exemplo à sua empresa.'))}</span></dd></div>
          <div><dt>URL</dt><dd><span class="telegram-account__guide-example">https://elozi.je4ndev.com</span><span>${e(t('Endereço do produto que fará a integração.'))}</span></dd></div>
          <div><dt>${e(t('Plataforma (Platform)'))}</dt><dd><span class="telegram-account__guide-example">${e(t('Outro (Other)'))}</span><span>${e(t('A Elozi se conecta pelo servidor. Descreva essa integração no campo Description.'))}</span></dd></div>
          <div><dt>Description</dt><dd><span class="telegram-account__guide-example">${e(t('Integração da Elozi no servidor para atendimento humano das conversas e grupos escolhidos pelo responsável pela conta.'))}</span></dd></div>
        </dl><p>${e(t('Clique em Create application para concluir o cadastro e ver os campos api_id e api_hash.'))}</p></li>
        <li><h4>${e(t('Volte à Elozi para conectar'))}</h4><p>${e(t('Copie api_id para API ID e api_hash para API hash no formulário privado abaixo. Clique em Salvar aplicativo; depois escolha QR ou telefone para autenticar e selecione as conversas para atendimento.'))}</p><p class="telegram-account__guide-private">${e(t('Cole as credenciais somente neste formulário privado da Elozi. Códigos de acesso e senha de duas etapas ficam nos respectivos formulários privados de autenticação.'))}</p></li>
      </ol>
      <a class="telegram-account__guide-source" href="https://core.telegram.org/api/obtaining_api_id" target="_blank" rel="noopener noreferrer">${e(t('Consultar o guia oficial do Telegram'))}</a>
    </div>
  </details>`;
  const configuration = `<details class="telegram-account__configuration"${!status.configured && !model.loading ? ' open' : ''}><summary>${e(t('Aplicativo Telegram'))}</summary>${guide}<form ${formAttrs('configuration')}><fieldset class="telegram-account__section"${authenticated || ACTIVE_AUTH.has(status.authState) ? ' disabled' : ''}><p class="telegram-account__lead">${e(t('Use as credenciais do aplicativo Telegram criado para sua conta.'))}</p><div class="telegram-account__columns">${input('apiId', 'API ID do aplicativo', 'type="text" inputmode="numeric" maxlength="10" required autocomplete="off"')}${input('apiHash', 'API hash do aplicativo', `type="password" maxlength="32" autocomplete="new-password"${status.configured ? '' : ' required'}`)}</div>${status.configured ? `<small>${e(t('Deixe o hash vazio para manter a credencial já cadastrada.'))}</small>` : ''}<small>${e(t('Salvar o aplicativo prepara a autenticação; a conta só conecta após a confirmação no Telegram.'))}</small><div class="telegram-account__actions">${submit('Salvar aplicativo')}</div></fieldset></form></details>`;
  let authentication = '';
  if (status.configured && !authenticated && !model.loading) {
    if (authState === 'code' || authState === 'password') {
      const code = authState === 'code';
      authentication = `<form ${formAttrs('authentication')}><p>${e(t('Digite o código ou a senha somente neste formulário privado.'))}</p>${input(code ? 'code' : 'password', code ? 'Código recebido no Telegram' : 'Senha de verificação em duas etapas', code ? 'type="password" inputmode="numeric" maxlength="12" autocomplete="one-time-code" required' : 'type="password" maxlength="256" autocomplete="current-password" required')}<div class="telegram-account__actions">${submit(code ? 'Confirmar código' : 'Confirmar senha')}${action('cancel', 'Cancelar autenticação')}</div></form>`;
    } else if (authState === 'qr' && !qrExpired) {
      const qr = typeof model.qrURL === 'string' && /^blob:[A-Za-z0-9:/._-]+$/.test(model.qrURL) ? `<img src="${e(model.qrURL)}" alt="${e(t('QR privado para autenticar sua conta Telegram'))}" width="224" height="224"/>` : '';
      const expires = Number.isFinite(Date.parse(status.qrExpiresAt)) ? new Date(status.qrExpiresAt).toLocaleTimeString(options.locale || getLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      authentication = `<section class="telegram-account__qr">${qr}<p>${e(t('Use o Telegram da sua conta para confirmar este QR.'))}</p>${expires ? `<small>${e(t('Válido até {time}', { time: expires }))}</small>` : ''}<div class="telegram-account__actions">${action('refresh', 'Atualizar estado')}${action('cancel', 'Cancelar autenticação')}</div></section>`;
    } else if (authState === 'connecting') {
      authentication = `<div class="telegram-account__actions">${action('refresh', 'Atualizar estado')}${action('cancel', 'Cancelar autenticação')}</div>`;
    } else {
      authentication = `${qrExpired ? `<p>${e(t('O QR expirou. Inicie uma nova autenticação.'))}</p>` : ''}<div class="telegram-account__actions">${action('qr', 'Autenticar por QR', true)}</div><details class="telegram-account__configuration"><summary>${e(t('Autenticar por telefone'))}</summary><form ${formAttrs('phone')}>${input('phoneNumber', 'Telefone da conta, com código do país', 'type="tel" maxlength="17" autocomplete="tel" required')}<div class="telegram-account__actions">${submit('Solicitar código')}</div></form></details>`;
    }
  }
  let selection = '';
  if (authenticated) {
    const dialogs = model.dialogs;
    const rows = dialogs ? dialogs.dialogs.map(item => `<li><label class="telegram-account__dialog"><input type="checkbox" name="peerIds" value="${e(item.id)}"${item.selected ? ' checked' : ''}${disabled}/><span>${e(item.name)}<small>${e(t(item.type === 'group' ? 'Grupo' : 'Conversa individual'))}${item.canSend === false ? ` · ${e(t('Somente leitura nesta conta'))}` : ''}</small></span></label></li>`).join('') : '';
    selection = `<section class="telegram-account__section"><h3>${e(t('Escolher conversas para atendimento'))}</h3><p class="telegram-account__consent">${e(t('Conversas para atendimento humano. Uso por IA precisa de consentimento específico dos participantes.'))}</p><small>${e(t('Selecione somente as conversas que você autoriza para este atendimento. Novas conversas ficam fora da seleção.'))}</small>${dialogs ? `<form ${formAttrs('selection')}><ul class="telegram-account__dialogs" aria-label="${e(t('Conversas disponíveis'))}">${rows || `<li>${e(t('Nenhuma conversa disponível. Atualize após conferir sua conta no Telegram.'))}</li>`}</ul><div class="telegram-account__actions">${submit('Salvar conversas escolhidas')}${action('dialogs', 'Carregar conversas da conta')}</div></form>` : `${status.selectedCount ? '' : `<p>${e(t('Nenhuma conversa sincronizada até você escolher e salvar.'))}</p>`}<div class="telegram-account__actions">${action('dialogs', 'Carregar conversas da conta', true)}</div>`}<p>${e(t('Conversas escolhidas: {count}', { count: status.selectedCount || 0 }))}</p></section>`;
    if (status.selectedCount > 0) selection += `<section class="telegram-account__section"><h3>${e(t('Importar histórico limitado'))}</h3><p id="telegram-account-history-help">${e(t('Até 20 conversas por importação. O atendimento permite até 100 conversas selecionadas.'))}${status.selectedCount > 20 ? ` ${e(t('Para importar o histórico, reduza a seleção e salve até 20 conversas. A seleção atual permanece ativa para atendimento.'))}` : ''}</p><form ${formAttrs('history')} aria-describedby="telegram-account-history-help"><label for="telegram-account-limit">${e(t('Mensagens por conversa escolhida'))}<input id="telegram-account-limit" name="limitPerConversation" type="number" min="1" max="100" step="1" value="${Number.isInteger(model.historyLimit) && model.historyLimit >= 1 && model.historyLimit <= 100 ? model.historyLimit : 50}" required${disabled}/></label><small>${e(t('De 1 a 100 mensagens por conversa; a importação não envia respostas.'))}</small><div class="telegram-account__actions">${submit('Importar histórico limitado', status.selectedCount <= 20)}</div></form></section>`;
  }
  const receipt = model.receipt ? `<section class="telegram-account__section"><h3>${e(t('Recibo da importação'))}</h3><dl class="telegram-account__receipt">${[['imported', 'Mensagens importadas'], ['duplicates', 'Mensagens já existentes'], ['conversations', 'Conversas consultadas'], ['limitPerConversation', 'Limite por conversa']].map(([key, label]) => `<div><dt>${e(t(label))}</dt><dd>${count(model.receipt[key]) ? model.receipt[key] : '—'}</dd></div>`).join('')}</dl><small>${e(t('O recibo registra a importação; não comprova leitura de mídia por IA.'))}</small></section>` : '';
  const body = model.confirmDisconnect ? `<section class="telegram-account__section"><h3>${e(t('Desconectar esta conta da Elozi?'))}</h3><p>${e(t('Esta ação encerra a conexão desta conta na Elozi. As conversas salvas e os demais dispositivos Telegram são preservados.'))}</p><div class="telegram-account__actions">${action('keep', 'Manter conexão')}${action('confirm-disconnect', 'Confirmar desconexão', true)}</div></section>` : `${model.loading ? '' : configuration}${authentication}${selection}${receipt}`;
  return `<section class="telegram-account" data-telegram-account-panel data-telegram-account-token="${token}"><p class="telegram-account__lead">${e(t('Configure o aplicativo, autentique sua conta e escolha quais conversas entram no atendimento.'))}</p><ol class="telegram-account__steps" aria-label="${e(t('Telegram · Conta pessoal'))}">${steps.map(([key, label], index) => `<li${key === step ? ' aria-current="step"' : ''}>${index + 1}. ${e(t(label))}</li>`).join('')}</ol><p class="telegram-account__state" data-connected="${authenticated}" role="status" aria-live="polite">${e(t(model.loading ? 'Carregando o estado desta conta…' : stateLabel))}${authenticated && status.account?.name ? ` · ${e(status.account.name)}` : ''}</p>${body}${model.uncertain ? `<p>${e(t('A confirmação não chegou. Consulte o estado antes de repetir a ação; os campos privados foram limpos.'))}</p>` : ''}<p class="telegram-account__feedback" role="alert">${e(model.error || '')}</p><p role="status" aria-live="polite">${e(model.notice || '')}</p><footer class="telegram-account__footer"><small class="telegram-account__privacy">${e(t('Privadas: credencial do aplicativo, sessão, código e senha não aparecem no atendimento.'))}</small><div class="telegram-account__actions">${authenticated ? action('disconnect', 'Desconectar da Elozi') : ''}${action('refresh', model.uncertain ? 'Verificar resultado no servidor' : 'Atualizar estado')}${action('close', 'Fechar')}</div></footer></section>`;
}

/** Stateful controller; private form values and QR pixels never enter app state or persisted drafts. */
export function createTelegramAccountUI({ state = {}, api, company = () => state.tenant, dialog = {}, openModal, getModal, i18n, authorityGuard = () => true, onUpdate = () => {}, toast = () => {}, timers = globalThis, document: suppliedDocument } = {}) {
  const t = translate({ i18n }), dialogOpen = dialog.open || openModal, modal = dialog.get || getModal || (() => globalThis.document?.querySelector?.('#modal'));
  const documentFor = () => suppliedDocument || modal()?.ownerDocument || globalThis.document;
  const tenant = () => typeof company === 'function' ? company() : company;
  let view = null, sequence = 0, requestSequence = 0, timer = null;
  const ctx = () => {
    const session = state.boot?.session || {}, selected = tenant();
    return { workspaceId: state.workspaceId || session.resellerId || '', tenantId: selected?.id || '', userId: session.userId || '', role: session.role || '',
      authority: state.boot?.csrfToken || session.csrfToken || '', supportGrantId: state.supportGrantId || session.supportGrantId || null,
      service: session.kind === 'service', route: state.view || '', permissions: session.permissions, scopeRules: session.scopeRules, tenantIds: session.tenantIds,
      platform: Boolean(session.platformOwner || session.platformAdmin), companyOwner: selected?.resellerId || '',
      companies: (state.boot?.tenants || []).map(item => item.id), workspaces: (state.boot?.workspaces || []).map(item => [item.id, item.supportGrantId || null]) };
  };
  const contextKey = value => JSON.stringify(value);
  function authorized(value = ctx()) {
    return id(value.workspaceId) && id(value.tenantId) && id(value.userId) && value.role === 'reseller' && !value.supportGrantId && !value.service
      && (!value.companyOwner || value.companyOwner === value.workspaceId) && authorityGuard(value) === true;
  }
  const current = record => Boolean(record && view === record && authorized() && record.key === contextKey(ctx()) && tenant()?.channels?.some(item => item.id === record.channelId && item.kind === 'telegram_user' && item.transport === 'telegram-user'));
  const panel = () => modal()?.querySelector?.('[data-telegram-account-panel]');
  const ownsPanel = record => Boolean(record && panel()?.dataset.telegramAccountToken === record.token);
  const owned = record => modal()?.open !== false && ownsPanel(record);
  const shown = record => owned(record) && current(record);
  function scrub(record = view) {
    if (!ownsPanel(record)) return;
    for (const field of panel()?.querySelectorAll?.('input') || []) if (PRIVATE_FIELDS.includes(field.name)) field.value = '';
  }
  function stopPoll() { if (timer !== null) timers.clearTimeout(timer); timer = null; }
  function revokeQR(record) { if (record?.qrURL) URL.revokeObjectURL(record.qrURL); if (record) record.qrURL = null; }
  function reset() {
    const record = view; stopPoll(); requestSequence++; record?.controller?.abort(); scrub(record); revokeQR(record);
    const wasOpen = owned(record); view = null; sequence++;
    if (wasOpen) modal()?.close?.();
  }
  function guard(record) { if (!shown(record)) { if (view === record) reset(); throw staleError(); } return ctx(); }
  function headers(record) { return { 'X-Elozi-Workspace': record.workspaceId, ...(record.authority ? { 'X-CSRF-Token': record.authority } : {}) }; }
  const endpoint = (record, suffix) => `/api/tenants/${encodeURIComponent(record.tenantId)}/channels/${encodeURIComponent(record.channelId)}/telegram-account/${suffix}`;
  function safeEnvelope(result, record) {
    if (!result || result.tenantId !== record.tenantId || result.channelId !== record.channelId || !count(result.version)) throw new Error(t('O servidor não confirmou o contexto desta conexão.'));
  }
  function safeStatus(result, record) {
    safeEnvelope(result, record);
    if (!STATES.has(result.state) || !AUTH_STATES.has(result.authState) || typeof result.configured !== 'boolean' || !count(result.selectedCount)
      || result.state === 'connected' && result.authState !== 'authenticated' || result.attemptId !== undefined && result.attemptId !== null && !id(result.attemptId)) throw new Error(t('O servidor não confirmou o contexto desta conexão.'));
    const accountName = typeof result.account?.name === 'string' && result.account.name.length <= 240 && !/\p{Cc}/u.test(result.account.name) ? result.account.name : '';
    return { tenantId: record.tenantId, channelId: record.channelId, version: result.version, state: result.state, authState: result.authState,
      configured: result.configured, selectedCount: result.selectedCount, attemptId: result.attemptId || null,
      errorCode: typeof result.errorCode === 'string' && Object.hasOwn(AUTH_ERRORS, result.errorCode) ? result.errorCode : result.errorCode ? 'AUTH_FAILED' : null,
      qrExpiresAt: typeof result.qrExpiresAt === 'string' && Number.isFinite(Date.parse(result.qrExpiresAt)) ? result.qrExpiresAt : null, account: accountName ? { name: accountName } : null };
  }
  function safeDialogs(result, record) {
    safeEnvelope(result, record);
    if (result.state !== 'connected' || !Array.isArray(result.dialogs) || result.dialogs.length > 500 || !Array.isArray(result.selectedPeerIds) || result.selectedPeerIds.length > 500) throw new Error(t('O servidor não confirmou o contexto desta conexão.'));
    const unique = new Set(), selected = new Set(result.selectedPeerIds);
    if (selected.size !== result.selectedPeerIds.length || [...selected].some(value => !peer(value))) throw new Error(t('O servidor não confirmou o contexto desta conexão.'));
    const dialogs = result.dialogs.map(item => {
      if (!peer(item.id) || unique.has(item.id) || typeof item.name !== 'string' || item.name.length > 240 || /\p{Cc}/u.test(item.name) || !['private', 'group'].includes(item.type) || typeof item.canSend !== 'boolean') throw new Error(t('O servidor não confirmou o contexto desta conexão.'));
      unique.add(item.id); return { id: item.id, name: item.name, type: item.type, selected: selected.has(item.id), canSend: item.canSend };
    });
    if ([...selected].some(value => !unique.has(value))) throw new Error(t('O servidor não confirmou o contexto desta conexão.'));
    return { version: result.version, dialogs, selectedPeerIds: [...selected] };
  }
  function safeReceipt(result, record) {
    safeEnvelope(result, record);
    if (!['imported', 'duplicates', 'conversations', 'limitPerConversation'].every(key => count(result[key])) || result.limitPerConversation < 1 || result.limitPerConversation > 100 || result.attachmentsAnalyzed !== false) throw new Error(t('O servidor não confirmou o contexto desta conexão.'));
    return { version: result.version, imported: result.imported, duplicates: result.duplicates, conversations: result.conversations, limitPerConversation: result.limitPerConversation, attachmentsAnalyzed: false };
  }
  function privateQR(result, record) {
    revokeQR(record);
    if (record.status.authState !== 'qr' || qrExpired(record) || typeof result.qrDataUrl !== 'string') return;
    const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(result.qrDataUrl);
    if (!match || match[1].length > 1024 * 1024) throw new Error(t('O servidor não confirmou o contexto desta conexão.'));
    const bytes = Uint8Array.from(atob(match[1]), character => character.charCodeAt(0));
    if (bytes.length < 8 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) throw new Error(t('O servidor não confirmou o contexto desta conexão.'));
    record.qrURL = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
  }
  const qrExpired = record => record.status?.authState === 'qr' && record.status.qrExpiresAt && Date.parse(record.status.qrExpiresAt) <= (typeof timers.now === 'function' ? timers.now() : Date.now());
  function model(record = view) { return record ? { token: record.token, status: record.status, dialogs: record.dialogs, receipt: record.receipt, historyLimit: record.historyLimit, loading: record.loading, busy: record.busy, uncertain: record.uncertain, conflict: record.conflict, confirmDisconnect: record.confirmDisconnect, error: record.error, notice: record.notice, qrURL: record.qrURL, qrExpired: Boolean(qrExpired(record)) } : {}; }
  function render() { return renderTelegramAccountConnection(model(), { i18n, locale: getLocale() }); }
  function paint(record) {
    if (!shown(record)) return false;
    const active = documentFor()?.activeElement, focusName = panel()?.contains?.(active) ? active?.name : null, focusAction = panel()?.contains?.(active) ? active?.dataset?.telegramAccountAction : null;
    scrub(record);
    dialogOpen(t('Telegram · Conta pessoal'), tenant()?.name || '', render());
    if (!shown(record)) return false;
    const next = focusName ? panel()?.querySelector?.(`[name="${focusName}"]`) : focusAction ? panel()?.querySelector?.(`[data-telegram-account-action="${focusAction}"]`) : null;
    const target = next || panel()?.querySelector?.(record.confirmDisconnect ? '[data-telegram-account-action="keep"]' : record.status?.authState === 'code' ? '[name="code"]' : record.status?.authState === 'password' ? '[name="password"]' : !record.status?.configured ? '[name="apiId"]' : '[data-telegram-account-action="refresh"]');
    if (target && !target.disabled) target.focus?.({ preventScroll: true });
    return true;
  }
  function messageFor(error) {
    if ([401, 403].includes(error?.status)) return t('Sua sessão ou autorização mudou. Entre novamente e abra esta conexão.');
    if (error?.status === 409) return t('A configuração mudou. Atualize o estado antes de fazer outra alteração.');
    const code = error?.errorCode || error?.code;
    if (typeof code === 'string' && Object.hasOwn(AUTH_ERRORS, code)) return t(AUTH_ERRORS[code]);
    if (code === 'email_auth_unsupported') return t(AUTH_ERRORS.EMAIL_AUTH_UNSUPPORTED);
    return t('Não foi possível confirmar esta ação. Confira o estado e tente novamente.');
  }
  function schedule(record) {
    stopPoll();
    if (!shown(record) || record.busy || record.uncertain || record.conflict || qrExpired(record) || !POLLED_AUTH.has(record.status?.authState) || documentFor()?.visibilityState === 'hidden') return;
    timer = timers.setTimeout(() => { timer = null; if (shown(record)) void readStatus(record); }, 2000);
  }
  async function applyStatus(result, record, notify = false) {
    guard(record); const status = safeStatus(result, record);
    if (record.dialogs?.version !== status.version) record.dialogs = null;
    if (record.receipt?.version !== status.version) record.receipt = null;
    record.status = status; record.error = status.errorCode ? t(AUTH_ERRORS[status.errorCode]) : ''; privateQR(result, record);
    if (status.state !== 'connected') { record.dialogs = null; record.receipt = null; }
    if (notify) {
      guard(record);
      await onUpdate({ id: record.channelId, tenantId: record.tenantId, channelId: record.channelId, kind: 'telegram_user', transport: 'telegram-user',
        state: status.state, configured: status.configured, version: status.version, selectedCount: status.selectedCount });
      guard(record);
    }
  }
  async function readStatus(record = view) {
    if (!shown(record) || record.busy) return false;
    preserveSelection(record);
    const previous = record.status, preserveChallenge = !record.loading && !record.error && !record.uncertain && !record.conflict && ['code', 'password'].includes(previous?.authState);
    stopPoll(); record.controller?.abort(); record.controller = new AbortController(); const ticket = ++requestSequence;
    try {
      guard(record);
      const result = await api(endpoint(record, 'status'), { method: 'GET', headers: headers(record), signal: record.controller.signal });
      if (ticket !== requestSequence) return false;
      guard(record); await applyStatus(result, record); guard(record);
      record.loading = false; record.uncertain = false; record.conflict = false; record.confirmDisconnect = false;
      if (!preserveChallenge || JSON.stringify(previous) !== JSON.stringify(record.status)) paint(record);
      schedule(record); return true;
    } catch (error) {
      if (error?.stale || ticket !== requestSequence || !shown(record)) return false;
      if ([401, 403].includes(error?.status)) { toast(messageFor(error), true); reset(); return false; }
      record.loading = false; record.error = messageFor(error); paint(record); return false;
    }
  }
  function preserveSelection(record) {
    if (!shown(record)) return null;
    const fields = [...(panel()?.querySelectorAll?.('input') || [])], checks = fields.filter(field => field.name === 'peerIds');
    const limit = fields.find(field => field.name === 'limitPerConversation')?.value;
    if (/^(?:[1-9]\d?|100)$/.test(String(limit || ''))) record.historyLimit = Number(limit);
    if (!record.dialogs || !checks.length) return null;
    const selected = new Set(checks.filter(field => field.checked).map(field => String(field.value)));
    record.dialogs = { ...record.dialogs, dialogs: record.dialogs.dialogs.map(item => ({ ...item, selected: selected.has(item.id) })) };
    return [...selected];
  }
  async function loadDialogs(record = view) {
    guard(record); if (record.busy || record.uncertain || record.conflict || record.status?.state !== 'connected') return false;
    const draft = preserveSelection(record), draftVersion = record.dialogs?.version;
    record.busy = true; stopPoll(); paint(record); record.controller?.abort(); record.controller = new AbortController(); const ticket = ++requestSequence;
    try {
      guard(record); const result = await api(endpoint(record, 'dialogs'), { method: 'GET', headers: headers(record), signal: record.controller.signal });
      if (ticket !== requestSequence) return false; guard(record);
      record.dialogs = safeDialogs(result, record);
      if (draft && record.dialogs.version === draftVersion) {
        const selected = new Set(draft); record.dialogs.dialogs = record.dialogs.dialogs.map(item => ({ ...item, selected: selected.has(item.id) }));
      }
      record.status = { ...record.status, version: record.dialogs.version, selectedCount: record.dialogs.selectedPeerIds.length }; record.error = '';
      return true;
    } catch (error) {
      if (error?.stale || !shown(record)) return false;
      if ([401, 403].includes(error?.status)) { toast(messageFor(error), true); reset(); return false; }
      record.error = messageFor(error); return false;
    } finally { if (shown(record)) { record.busy = false; paint(record); } }
  }
  async function write(record, suffix, body, form) {
    guard(record);
    if (record.busy || record.uncertain || record.conflict) return false;
    record.busy = true; record.error = ''; record.notice = ''; stopPoll(); scrub(record); paint(record);
    record.controller?.abort(); record.controller = new AbortController(); const ticket = ++requestSequence;
    try {
      guard(record);
      const result = await api(endpoint(record, suffix), { method: 'POST', headers: headers(record), body: JSON.stringify(body), signal: record.controller.signal });
      if (ticket !== requestSequence) return false; guard(record);
      if (suffix === 'dialogs') {
        const selection = safeDialogs(result, record); record.dialogs = selection; record.status = { ...record.status, version: selection.version, selectedCount: selection.selectedPeerIds.length };
        record.receipt = null; record.notice = t('Conversas salvas. O histórico antigo ainda precisa de uma importação explícita.');
      } else if (suffix === 'history') {
        record.receipt = safeReceipt(result, record); record.status = { ...record.status, version: record.receipt.version };
      } else await applyStatus(result, record, true);
      record.confirmDisconnect = false;
      guard(record); return !record.status.errorCode;
    } catch (error) {
      if (error?.stale || ticket !== requestSequence || !shown(record)) return false;
      if ([401, 403].includes(error?.status)) { toast(messageFor(error), true); reset(); return false; }
      record.confirmDisconnect = false;
      record.conflict = error?.status === 409;
      record.uncertain = !Number.isInteger(error?.status) || error.status === 0 || error.status >= 500;
      record.error = messageFor(error); return false;
    } finally {
      for (const field of PRIVATE_FIELDS) if (body && Object.hasOwn(body, field)) delete body[field]; body = null;
      if (form) for (const field of form.querySelectorAll?.('input') || []) if (PRIVATE_FIELDS.includes(field.name)) field.value = '';
      if (shown(record)) { record.busy = false; paint(record); schedule(record); }
    }
  }
  async function open(channel) {
    reset(); const context = ctx();
    if (!authorized(context) || typeof api !== 'function' || typeof dialogOpen !== 'function' || !id(channel?.id) || channel.kind !== 'telegram_user' || channel.transport !== 'telegram-user'
      || !tenant()?.channels?.some(item => item.id === channel.id && item.kind === 'telegram_user' && item.transport === 'telegram-user')) return false;
    const record = { ...context, key: contextKey(context), channelId: channel.id, token: `telegram-account-${++sequence}`, loading: true, busy: false, uncertain: false, conflict: false, confirmDisconnect: false, error: '', notice: '', status: null, dialogs: null, receipt: null, qrURL: null };
    view = record; dialogOpen(t('Telegram · Conta pessoal'), tenant()?.name || '', render());
    if (!shown(record)) { reset(); return false; } return readStatus(record);
  }
  async function action(target) {
    const record = view, dataset = target?.dataset;
    if (!dataset?.telegramAccountAction || dataset.telegramAccountToken !== record?.token) return false;
    guard(record); const name = dataset.telegramAccountAction;
    if (name === 'close') { reset(); return true; }
    if (record.confirmDisconnect && !['keep', 'confirm-disconnect', 'refresh'].includes(name)) return false;
    if (name === 'refresh') return readStatus(record);
    if (name === 'dialogs') return loadDialogs(record);
    if (record.busy || record.uncertain || record.conflict || !record.status) return false;
    if (name === 'disconnect' && record.status.state === 'connected') { preserveSelection(record); record.confirmDisconnect = true; paint(record); return true; }
    if (name === 'keep' && record.confirmDisconnect) { record.confirmDisconnect = false; paint(record); return true; }
    if (name === 'confirm-disconnect' && record.confirmDisconnect && record.status.state === 'connected') return write(record, 'disconnect', { version: record.status.version });
    if (name === 'qr' && record.status.configured && (!ACTIVE_AUTH.has(record.status.authState) || qrExpired(record)) && record.status.state !== 'connected') return write(record, 'auth/start', { version: record.status.version, method: 'qr' });
    if (name === 'cancel' && record.status.attemptId && ACTIVE_AUTH.has(record.status.authState)) return write(record, 'auth/cancel', { version: record.status.version, attemptId: record.status.attemptId });
    return false;
  }
  async function submit(form) {
    const record = view;
    if (!form?.dataset?.telegramAccountForm || form.dataset.telegramAccountToken !== record?.token) return false;
    guard(record); if (record.busy || record.uncertain || record.conflict || record.confirmDisconnect || !record.status) return false;
    const values = new FormData(form), read = name => String(values.get(name) ?? ''), version = record.status.version, kind = form.dataset.telegramAccountForm;
    let suffix, body;
    if (kind === 'configuration') {
      if (ACTIVE_AUTH.has(record.status.authState) || record.status.state === 'connected') return false;
      const apiId = read('apiId'), apiHash = read('apiHash');
      if (!/^[1-9]\d{0,9}$/.test(apiId) || Number(apiId) > 2147483647 || apiHash && !/^[A-Fa-f0-9]{32}$/.test(apiHash) || !record.status.configured && !apiHash) throw new Error(t('Informe um API ID válido e o API hash de 32 caracteres.'));
      suffix = 'configuration'; body = { version, apiId: Number(apiId), ...(apiHash ? { apiHash } : {}) };
    } else if (kind === 'phone') {
      const phoneNumber = read('phoneNumber');
      if (!/^\+[1-9]\d{6,14}$/.test(phoneNumber)) throw new Error(t('Informe o telefone com código do país, no formato +5511999999999.'));
      if (!record.status.configured || ACTIVE_AUTH.has(record.status.authState) || record.status.state === 'connected') return false;
      suffix = 'auth/start'; body = { version, method: 'phone', phoneNumber };
    } else if (kind === 'authentication') {
      const code = read('code'), password = read('password');
      if (!record.status.attemptId) throw staleError();
      if (record.status.authState === 'code') { if (!/^\d{3,12}$/.test(code)) throw new Error(t('Informe o código recebido no Telegram.')); body = { version, attemptId: record.status.attemptId, code }; }
      else if (record.status.authState === 'password') { if (!password || password.length > 256 || /\p{Cc}/u.test(password)) throw new Error(t('Informe a senha de verificação em duas etapas.')); body = { version, attemptId: record.status.attemptId, password }; }
      else throw staleError();
      suffix = 'auth/submit';
    } else if (kind === 'selection') {
      if (record.status.state !== 'connected' || !record.dialogs) return false;
      const peerIds = [...new Set(values.getAll('peerIds').map(String))], available = new Set(record.dialogs.dialogs.map(item => item.id));
      if (peerIds.some(peerId => !available.has(peerId))) throw staleError();
      preserveSelection(record);
      suffix = 'dialogs'; body = { version, peerIds };
    } else if (kind === 'history') {
      const limit = read('limitPerConversation');
      if (record.status.state !== 'connected' || !record.status.selectedCount) throw new Error(t('Salve pelo menos uma conversa antes de importar seu histórico.'));
      if (record.status.selectedCount > 20) throw new Error(t('Para importar o histórico, reduza a seleção e salve até 20 conversas. A seleção atual permanece ativa para atendimento.'));
      if (!/^(?:[1-9]\d?|100)$/.test(limit)) throw new Error(t('Informe um limite inteiro entre 1 e 100.'));
      record.historyLimit = Number(limit); suffix = 'history'; body = { version, limitPerConversation: Number(limit) };
    } else return false;
    guard(record); return write(record, suffix, body, form);
  }
  function sync() { if (view && !current(view)) reset(); else if (view && !owned(view)) reset(); }
  const closed = () => { if (modal()?.open !== true && view) reset(); };
  const visibility = () => { if (documentFor()?.visibilityState === 'hidden') stopPoll(); else if (shown(view)) schedule(view); };
  modal()?.addEventListener?.('close', closed);
  documentFor()?.addEventListener?.('visibilitychange', visibility);
  function destroy() { reset(); modal()?.removeEventListener?.('close', closed); documentFor()?.removeEventListener?.('visibilitychange', visibility); }
  return { open, render, action, submit, sync, reset, destroy };
}

/** Convenience entry point; pass a persistent controller to reuse it across openings. */
export async function openTelegramAccountConnection(channel, dependencies = {}) {
  const controller = dependencies.controller || createTelegramAccountUI(dependencies);
  await controller.open(channel); return controller;
}
