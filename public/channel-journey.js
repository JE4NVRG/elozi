import './locales-telegram-account.js';
import { t, txt } from './i18n.js';
import './locales-channel-journey.js';
import { createPoller, channelHealth, channelTransport } from './channel-connect-flow.js';
import { normalizeChannelValidation, channelValidatedForUse } from './channel-validation-view.js';

const definitions = {
  whatsapp: { kind: 'whatsapp_qr', transport: 'baileys', name: 'WhatsApp QR', description: 'Números e grupos selecionados, com a origem de cada conversa preservada.', setup: 'Conectar o número', setupDetail: 'Abra o QR desta conexão no celular do número correto. Depois, escolha os grupos que a equipe pode acompanhar.', validation: 'Receba uma mensagem autorizada e confira o número de origem no Atendimento.' },
  telegram_user: {kind:'telegram_user',transport:'telegram-user',name:'Telegram pessoal',description:'Sua conta Telegram na caixa de atendimento, com chats selecionados.',setup:'Autenticar a conta Telegram',setupDetail:'Use o formulário privado para configurar seu app Telegram e autenticar por QR ou código. Escolha quais conversas entram na Elozi.',validation:'Confirme recebimento e resposta em um chat selecionado. O uso por IA depende do consentimento específico dos participantes.'},
  telegram: { kind: 'telegram', transport: 'telegram-bot', name: 'Telegram', description: 'Seu bot para conversas privadas, grupos e tópicos.', setup: 'Conectar o bot', setupDetail: 'Cadastre o token do BotFather no formulário privado. O contato precisa iniciar a conversa; grupos dependem das permissões do bot.', validation: 'Confira uma conversa iniciada com o bot e selecione os grupos que a equipe pode acompanhar.' },
  webchat: { kind: 'webchat', transport: 'elozi-webchat', name: 'Webchat', description: 'Atendimento dentro do seu site ou SaaS, na mesma caixa da equipe.', setup: 'Autorizar o site e instalar', setupDetail: 'Cadastre as origens exatas e copie o código deste canal para o seu site ou aplicativo.', validation: 'Abra o widget em uma origem autorizada e confira a conversa no Atendimento.' },
  instagram: { kind: 'instagram', transport: 'meta-instagram', name: 'Instagram', description: 'Mensagens da conta profissional, com configuração pelo app Meta.', setup: 'Configurar conta e webhook', setupDetail: 'Use a conta profissional e as credenciais autorizadas no formulário. Cadastre o webhook deste canal no app Meta.', validation: 'Valide conta, permissões e webhook no app Meta. Confira a chegada de uma mensagem e a janela de resposta no Atendimento.' },
  messenger: { kind: 'messenger', transport: 'meta-messenger', name: 'Facebook Messenger', description: 'Conversas da Página do Facebook, com a identidade do canal preservada.', setup: 'Configurar Página e webhook', setupDetail: 'Use a Página e as credenciais autorizadas no formulário. Cadastre o webhook deste canal no app Meta.', validation: 'Valide Página, permissões e webhook no app Meta. Confira a chegada de uma mensagem e a janela de resposta no Atendimento.' },
  email: { kind: 'email', transport: 'mepmail-channel', name: 'E-mail de atendimento', description: 'Respostas por MepMail e entrada por um relay assinado.', setup: 'Configurar endereço e entrada', setupDetail: 'Cadastre o endereço e o segredo do relay no formulário privado. A caixa postal e o relay de entrada precisam estar disponíveis.', validation: 'Valide o recebimento e a resposta separadamente. Este canal usa texto; a configuração não conecta uma caixa IMAP.' }
};

export const CHANNEL_JOURNEY_IDS = Object.freeze(Object.keys(definitions));
const states = new Set(['disconnected', 'starting', 'qr', 'connecting', 'reconnecting', 'connected', 'logged_out', 'wrong_number', 'failed', 'configured', 'planned', 'sandbox', 'error']);
const attentionStates = new Set(['failed', 'error', 'wrong_number', 'logged_out', 'reconnecting']);
const string = (value, limit) => typeof value === 'string' && value.length <= limit && !/\p{Cc}/u.test(value) ? value : '';
const count = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000 ? value : 0;
const configurationFields = { webchat: 'webchat', instagram: 'meta', messenger: 'meta', email: 'email' };

export const DURABLE_CHANNEL_KINDS = Object.freeze(['whatsapp_qr', 'telegram', 'webchat']);

/** Accept only the scoped public proof. Message bodies, addresses and extra fields never leave this projection. */
export function channelValidationDTO(value, { tenantId, channelId } = {}) {
  try { return normalizeChannelValidation(value, { tenantId, channelId }); } catch { return null; }
}

/** Connection and operational validation have separate next actions. Unknown proof always remains pending. */
export function channelNextAction(channel, proof = null) {
  const transport = channelTransport(channel), health = channelHealth(channel);
  if (!transport) return { step: 'connect', label: t('Integração pendente'), detail: t('Confira os requisitos deste canal.'), complete: false };
  if (health === 'problem' || proof?.state === 'stale' && !proof.channelAvailable) return { step: 'connect', label: t('Reconectar'), detail: t('A conexão precisa de atenção. Reconecte antes de validar.'), complete: false };
  if (health !== 'ok' || configurationFields[channel.kind] && channel[configurationFields[channel.kind]]?.enabled !== true) return { step: 'connect', label: t(transport === 'connector' || transport === 'account' ? 'Continuar configuração' : 'Conectar'), detail: t('Conclua a configuração deste canal.'), complete: false };
  if (channelValidatedForUse(proof)) return { step: 'test', label: t('Ver validação'), detail: t('Entrada, resposta e destino confirmados.'), complete: true };
  const detail = proof?.state === 'waiting_reply' ? t('Mensagem recebida. Responda pelo Atendimento.')
    : proof?.state === 'waiting_confirmation' ? t('Resposta registrada. Confirme o recebimento no destino.')
      : proof?.state === 'waiting_incoming' ? t('Teste em andamento. Aguardando uma nova mensagem.')
        : proof?.state === 'stale' ? t('A configuração mudou. Faça um novo teste de ida e volta.') : t('Conexão salva. O teste de ida e volta está pendente.');
  return { step: 'test', label: t(proof && proof.state !== 'not_started' ? 'Continuar teste' : 'Testar agora'), detail, complete: false };
}

/** Read/resume the server proof; only explicit start and checked confirmation may write. */
export function createChannelValidation({ request, tenantId, channelId, active = () => true, onChange = () => {}, document: doc = globalThis.document,
  timers = globalThis, now = () => Date.now(), interval = 3000, timeBudget = 120000 } = {}) {
  if (typeof request !== 'function') throw new TypeError('createChannelValidation needs request()');
  const path = `/api/tenants/${encodeURIComponent(tenantId)}/channels/${encodeURIComponent(channelId)}/onboarding`;
  let dto = null, error = null, busy = false, stopped = false, generation = 0, requestToken = 0, budgetAt = now(), paused = false, poller = null, hiddenRequest = false;
  const available = () => !stopped && active() && doc?.visibilityState !== 'hidden';
  const emit = () => onChange({ dto, error, busy, paused });
  const accept = value => {
    const next = channelValidationDTO(value, { tenantId, channelId });
    if (!next || dto && next.version < dto.version) throw Object.assign(new Error('Invalid channel validation proof'), { status: 502 });
    dto = next; error = null; emit(); return next;
  };
  const current = (epoch, token) => available() && epoch === generation && token === requestToken;
  async function boundedRequest(options = {}) {
    let timeout;
    const abort = typeof AbortController === 'function' ? new AbortController() : null;
    try { return await Promise.race([request(path, { ...options, ...(abort ? { signal: abort.signal } : {}) }), new Promise((_, reject) => {
      timeout = timers.setTimeout(() => { abort?.abort(); reject(Object.assign(new Error('Channel validation timed out'), { status: 0 })); }, Math.min(20000, timeBudget));
    })]); } finally { if (timeout !== undefined) timers.clearTimeout(timeout); }
  }
  async function read() {
    if (!available() || busy) return false;
    const epoch = generation, token = ++requestToken;
    try { const value = await boundedRequest(); if (!current(epoch, token)) return false; accept(value); }
    catch (failure) { if (!current(epoch, token)) return false; error = failure; dto = null; emit(); if ([401, 403, 404].includes(failure?.status)) return false; }
    return Boolean(dto && ['waiting_incoming', 'waiting_reply'].includes(dto.state)) || Boolean(error && ![401, 403, 404].includes(error.status));
  }
  function watch({ immediate = false } = {}) {
    poller?.stop();
    poller = createPoller({ interval, document: doc, timers, active: () => !stopped && active(), tick: async () => {
      if (now() - budgetAt >= timeBudget) { paused = true; emit(); return false; }
      return read();
    } }).start({ immediate });
  }
  async function refresh() {
    if (!available() || busy) return;
    paused = false; budgetAt = now(); poller?.stop();
    if (await read()) watch();
  }
  async function mutate(action, checked = false) {
    if (!available() || busy || !dto || error || action === 'confirm' && (!checked || dto.state !== 'waiting_confirmation' || !dto.startedAt || !dto.conversationId || !dto.incomingRecorded || !dto.replyRecorded || !dto.channelAvailable)) return false;
    poller?.stop(); const epoch = generation, token = ++requestToken;
    busy = true; error = null; paused = false; emit();
    try {
      const result = await boundedRequest({ method: 'POST', body: JSON.stringify({ action, version: dto.version }) });
      if (!current(epoch, token)) return false;
      accept(result);
    } catch (failure) {
      if (!current(epoch, token)) return false;
      error = failure; if ([401, 403, 404].includes(failure?.status)) dto = null; emit();
      // An uncertain write is reconciled by a read, never by repeating the POST.
      if (![401, 403, 404].includes(failure?.status)) {
        try { const value = await boundedRequest(); if (!current(epoch, token)) return false; accept(value); }
        catch (readFailure) { if (current(epoch, token)) { error = readFailure; dto = null; emit(); } }
      }
    } finally { if (!stopped && epoch === generation && token === requestToken) { busy = false; if (available()) { emit(); budgetAt = now(); if (!error && dto && ['waiting_incoming', 'waiting_reply'].includes(dto.state)) watch(); } } }
    return current(epoch, token) && !error;
  }
  const visibility = () => {
    if (stopped || !active()) return;
    if (doc?.visibilityState === 'hidden') { hiddenRequest = true; requestToken++; busy = false; poller?.stop(); }
    else if (hiddenRequest) { hiddenRequest = false; void refresh(); }
  };
  doc?.addEventListener?.('visibilitychange', visibility);
  return { open: refresh, refresh, start: () => mutate('start'), confirm: checked => mutate('confirm', checked), stop() { stopped = true; generation++; requestToken++; poller?.stop(); doc?.removeEventListener?.('visibilitychange', visibility); },
    get dto() { return dto; }, get busy() { return busy; }, get running() { return Boolean(poller?.running); }, get paused() { return paused || Boolean(poller?.paused); } };
}

function displayState(channel, definition) {
  const state = states.has(channel.state) ? channel.state : 'disconnected';
  if (channel.transport !== definition.transport && ['connected', 'configured'].includes(state)) return 'disconnected';
  const configuration = configurationFields[definition.kind];
  if (configuration && channel[configuration]?.enabled !== true) return 'disconnected';
  // Email configuration enables a relay; it never establishes a mailbox session.
  return definition.kind === 'email' && state === 'connected' ? 'configured' : state;
}

// Only display fields leave this model. It does not read configuration secrets or make requests.
export function channelJourney(id, channels = []) {
  const definition = Object.hasOwn(definitions, id) ? definitions[id] : null;
  if (!definition) return null;
  const instances = (Array.isArray(channels) ? channels : []).filter(channel => channel && (channel.kind === definition.kind || !channel.kind && channel.transport === definition.transport)).flatMap(channel => {
    const channelId = string(channel.id, 120);
    if (!channelId || channelId !== channelId.trim()) return [];
    return [{ id: channelId, name: string(channel.name, 120) || t('Conexão sem nome'), label: string(channel.label, 240), state: displayState(channel, definition), native: channel.transport === definition.transport, enabledGroups: count(channel.enabledGroups), selectedGroups: count(channel.selectedGroups) }];
  });
  const connected = instances.filter(instance => instance.native && instance.state === 'connected').length;
  const configured = instances.filter(instance => instance.native && instance.state === 'configured').length;
  const attention = instances.filter(instance => attentionStates.has(instance.state)).length;
  const counts = { total: instances.length, connected, configured, attention };
  let text = t('Pronto para configurar'), tone = 'neutral';
  if (attention) { text = t('Conexão requer atenção'); tone = 'amber'; }
  else if (connected === instances.length && connected) { text = t('Conectado'); tone = 'green'; }
  else if (connected) { text = t('Conexão parcial'); tone = 'amber'; }
  else if (configured) { text = t('Configurado · validar'); tone = 'blue'; }
  else if (instances.length) text = t('Configuração pendente');
  const currentStep = !instances.length ? 1 : !connected && !configured ? 2 : 3;
  const detail = !instances.length ? t('Cadastre a conexão da empresa para começar.')
    : configured && !connected ? t('Configuração salva. A recepção e a resposta ainda precisam ser verificadas.')
      : txt`${connected} de ${instances.length} conexões conectadas. Valide o atendimento antes de usar na operação.`;
  return {
    id, name: t(definition.name), description: t(definition.description), instances, counts, text, tone, detail, currentStep,
    steps: [
      { number: 1, label: t('Cadastrar o canal'), detail: t('Escolha este tipo em Adicionar canal e dê um nome para a conexão.'), saved: instances.length > 0 },
      { number: 2, label: t(definition.setup), detail: t(definition.setupDetail), saved: connected + configured > 0 },
      { number: 3, label: t('Validar no Atendimento'), detail: t(definition.validation), saved: false }
    ]
  };
}

export function channelJourneyTotals(channels = []) {
  return CHANNEL_JOURNEY_IDS.reduce((total, id) => {
    const journey = channelJourney(id, channels);
    for (const key of Object.keys(total)) total[key] += journey.counts[key];
    return total;
  }, { total: 0, connected: 0, configured: 0, attention: 0 });
}
