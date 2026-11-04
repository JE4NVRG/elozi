import { t, h } from './i18n.js';
import './locales-management.js';
import { button, badge, banner, emptyState } from './ui.js';

// Plataforma › Produtos conectados › Conectar produto: six steps (product, channel, agent, events, replies, key and
// test). Steps 1–5 only collect choices; the end of step 5 makes ONE idempotent call to
// /api/platform/product-connections (src/product-connections.js), retried with the same requestId. The key and a
// generated webhook secret live only in this module's memory: shown masked, copied only to the clipboard, wiped when
// the wizard closes. Step 6 watches the product's first authenticated call, webhook delivery and first agent reply.
const CAPABILITIES = () => [['conversation.read', t('Ler as conversas do canal')], ['reply.send', t('Responder nas conversas dele')], ['conversation.manage', t('Assumir, etiquetar e encerrar')],
  ['events.read', t('Receber eventos')], ['handoff.request', t('Pedir uma pessoa da equipe')]];
const STEPS = () => [t('Produto'), t('Canal'), t('Agente e acesso'), t('Eventos'), t('Respostas'), t('Chave e teste')];
const POLL_MS = 5000, POLL_BUDGET_MS = 10 * 60000;
const masked = value => value ? `${value.slice(0, 14)}••••${value.slice(-4)}` : '';
const freshRequestId = () => `product-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const blank = () => ({ tenantId: '', newCompany: '', kind: 'assistant', channelId: '', agentName: '', capabilities: CAPABILITIES().map(([id]) => id), events: 'webhook',
  webhookUrl: '', secretMode: 'generate', perHour: 120, perMinute: 12, notice: '' });

export function createProductConnectUI({ request, onRender = () => {}, toast = () => {}, openChannels = async () => {}, onClose = () => {}, origin = () => globalThis.location?.origin || '',
  copy = value => globalThis.navigator?.clipboard?.writeText(value), now = Date.now, schedule = (fn, ms) => setInterval(fn, ms), cancel = id => clearInterval(id), visible = () => globalThis.document?.visibilityState !== 'hidden' } = {}) {
  let active = false, step = 1, busy = false, error = '', draft = blank(), companies = [], channels = null, requestId = '', result = null, token = '', secret = '', providedSecret = '', keySaved = false, live = null, timer = null, pollStarted = 0;
  const render = () => onRender();
  const stopPolling = () => { if (timer !== null) cancel(timer); timer = null; };
  const wipe = () => { token = ''; secret = ''; providedSecret = ''; keySaved = false; };
  const company = () => companies.find(item => item.tenantId === draft.tenantId);
  const channel = () => (channels || []).find(item => item.id === draft.channelId);
  async function guarded(task) {
    if (busy) return false;
    busy = true; error = ''; render();
    try { await task(); return true; } catch (failure) { error = failure?.message || t('Não foi possível concluir. Tente de novo.'); return false; } finally { busy = false; render(); }
  }
  async function loadChannels() {
    const tenant = await request(`/api/tenants/${encodeURIComponent(draft.tenantId)}?summary=1`);
    channels = (tenant?.channels || []).filter(item => item.enabled !== false).map(item => ({ id: item.id, name: item.name || '', kind: item.kind, state: item.state || '', label: item.label || '' }));
    if (!channels.some(item => item.id === draft.channelId)) draft.channelId = channels.find(item => item.state === 'connected')?.id || '';
  }
  async function poll() {
    if (!active || step !== 6 || !result) { stopPolling(); return; }
    if (now() - pollStarted > POLL_BUDGET_MS) { stopPolling(); render(); return; }
    if (!visible()) return;
    try {
      const data = await request('/api/platform/connected-products');
      const product = (data?.products || []).find(item => item.tenantId === result.tenantId);
      live = { agent: product?.agents?.find(item => item.id === result.principal?.id) || null, channel: product?.channels?.find(item => item.id === result.channelId) || null };
      render();
    } catch { /* The next tick tries again; the checklist keeps the last reading. */ }
  }
  function startPolling() { stopPolling(); pollStarted = now(); live = null; timer = schedule(() => { void poll(); }, POLL_MS); void poll(); }
  function close() { stopPolling(); wipe(); active = false; step = 1; draft = blank(); channels = null; requestId = ''; result = null; live = null; error = ''; render(); onClose(); }

  function stepsMarkup() {
    return h`<ol class="pg-settings__steps" aria-label="${t('Etapas da conexão do produto')}">${STEPS().map((label, index) => h`<li aria-current="${step === index + 1 ? 'step' : 'false'}" data-done="${index + 1 < step}"><span>${index + 1}</span>${label}</li>`)}</ol>`;
  }
  const actions = (next, { back = true } = {}) => h`<div class="pg-settings__form-actions">${back && step > 1 ? button({ label: t('Voltar'), action: 'product-connect-back', variant: 'ghost', disabled: busy }) : ''}
    ${button({ label: t('Cancelar'), action: 'product-connect-cancel', variant: 'ghost', disabled: busy })}${button({ label: next, type: 'submit', variant: 'primary', busy })}</div>`;
  const form = (name, body, next) => h`<form class="pg-settings__form" data-product-connect-form="${name}">${body}${error ? banner({ tone: 'danger', title: t('Não foi possível continuar'), body: error }) : ''}${actions(next)}</form>`;

  function productStep() {
    return form('product', h`<fieldset class="pg-settings__fieldset"><legend>${t('Qual produto vai falar com os clientes?')}</legend><div class="pg-settings__options">
      ${companies.map(item => h`<label class="pg-settings__option"><input type="radio" name="tenantId" value="${item.tenantId}" ${draft.tenantId === item.tenantId ? 'checked' : ''}/><span><strong class="pg-settings__strong">${item.name}</strong></span></label>`)}
      <label class="pg-settings__option"><input type="radio" name="tenantId" value="new" ${draft.tenantId === 'new' ? 'checked' : ''}/><span><strong class="pg-settings__strong">${t('Novo produto')}</strong><span class="pg-settings__hint">${t('Cria uma empresa nova para ele.')}</span></span></label></div>
      <label class="pg-settings__field">${t('Nome do novo produto')}<input class="pg-settings__input" name="newCompany" maxlength="80" value="${draft.newCompany}"/></label></fieldset>
      <fieldset class="pg-settings__fieldset"><legend>${t('Como o produto conversa')}</legend><div class="pg-settings__options">
      <label class="pg-settings__option"><input type="radio" name="kind" value="assistant" ${draft.kind === 'assistant' ? 'checked' : ''}/><span><strong class="pg-settings__strong">${t('Assistente do produto')}</strong><span class="pg-settings__hint">${t('A conversa é o próprio produto: limites maiores e aviso quando passar do ritmo.')}</span></span></label>
      <label class="pg-settings__option"><input type="radio" name="kind" value="attendance" ${draft.kind === 'attendance' ? 'checked' : ''}/><span><strong class="pg-settings__strong">${t('Atendimento a clientes')}</strong><span class="pg-settings__hint">${t('O agente ajuda a equipe e passa para uma pessoa quando precisa.')}</span></span></label></div></fieldset>`, t('Continuar'));
  }
  function channelStep() {
    if (channels && !channels.length) return h`<div class="pg-settings__form">${emptyState({ icon: 'link', title: t('Esta empresa ainda não tem canal'), body: t('Conecte o WhatsApp ou outro canal em Canais e volte aqui.') })}
      <div class="pg-settings__form-actions">${button({ label: t('Voltar'), action: 'product-connect-back', variant: 'ghost' })}${button({ label: t('Abrir Canais desta empresa'), action: 'product-connect-open-channels', variant: 'primary' })}</div></div>`;
    return form('channel', h`<fieldset class="pg-settings__fieldset"><legend>${t('Por onde os clientes chegam?')}</legend><div class="pg-settings__options">
      ${(channels || []).map(item => h`<label class="pg-settings__option"><input type="radio" name="channelId" value="${item.id}" ${draft.channelId === item.id ? 'checked' : ''}/><span><strong class="pg-settings__strong">${item.name}</strong><span class="pg-settings__hint">${item.label}${item.label ? ' · ' : ''}${item.state === 'connected' ? t('Conectado') : t('Ainda não conectado')}</span></span></label>`)}</div>
      <p class="pg-settings__hint">${t('Uma linha de WhatsApp entra na proteção entre linhas próprias: se outro produto nosso escrever para ela, nenhum agente responde nos dois lados.')}</p></fieldset>`, t('Continuar'));
  }
  function agentStep() {
    return form('agent', h`<label class="pg-settings__field">${t('Nome do agente')}<input class="pg-settings__input" name="agentName" maxlength="48" required value="${draft.agentName}"/></label>
      <fieldset class="pg-settings__fieldset"><legend>${t('O que o agente pode fazer')}</legend><ul class="pg-settings__checks">
      ${CAPABILITIES().map(([id, label]) => h`<li><label class="pg-settings__check"><input type="checkbox" name="capabilities" value="${id}" ${draft.capabilities.includes(id) ? 'checked' : ''} ${id === 'conversation.read' ? 'disabled' : ''}/>${label}</label></li>`)}</ul></fieldset>
      <p class="pg-settings__hint">${t('O cérebro continua no seu produto. A chave aparece uma vez no último passo: guarde no cofre do produto.')}</p>`, t('Continuar'));
  }
  function eventsStep() {
    return form('events', h`<fieldset class="pg-settings__fieldset"><legend>${t('Como o produto fica sabendo das mensagens')}</legend><div class="pg-settings__options">
      <label class="pg-settings__option"><input type="radio" name="events" value="webhook" ${draft.events === 'webhook' ? 'checked' : ''}/><span><strong class="pg-settings__strong">${t('Webhook assinado')}</strong><span class="pg-settings__hint">${t('O mais rápido. Fica desligado até o teste do último passo.')}</span></span></label>
      <label class="pg-settings__option"><input type="radio" name="events" value="wait" ${draft.events === 'wait' ? 'checked' : ''}/><span><strong class="pg-settings__strong">${t('Espera de eventos')}</strong><span class="pg-settings__hint">${t('Sem servidor público: o produto consulta os eventos.')}</span></span></label></div>
      <label class="pg-settings__field">${t('Endereço do webhook (HTTPS público)')}<input class="pg-settings__input" type="url" name="webhookUrl" placeholder="https://" value="${draft.webhookUrl}"/></label>
      <div class="pg-settings__options">
      <label class="pg-settings__option"><input type="radio" name="secretMode" value="generate" ${draft.secretMode === 'generate' ? 'checked' : ''}/><span>${t('A plataforma gera o segredo e mostra uma vez')}</span></label>
      <label class="pg-settings__option"><input type="radio" name="secretMode" value="provide" ${draft.secretMode === 'provide' ? 'checked' : ''}/><span>${t('Usar o segredo do produto')}</span></label></div>
      <label class="pg-settings__field">${t('Segredo do produto (32 a 256 caracteres; nunca é mostrado de novo)')}<input class="pg-settings__input" type="password" name="providedSecret" autocomplete="off" value=""/></label></fieldset>`, t('Continuar'));
  }
  function repliesStep() {
    const body = draft.kind === 'assistant' ? h`<div class="pg-settings__form-grid">
      <label class="pg-settings__field">${t('Respostas por hora, por conversa')}<input class="pg-settings__input" type="number" name="perHour" min="6" max="1000" required value="${draft.perHour}"/></label>
      <label class="pg-settings__field">${t('Respostas por minuto (rajada)')}<input class="pg-settings__input" type="number" name="perMinute" min="1" max="60" required value="${draft.perMinute}"/></label>
      <label class="pg-settings__field">${t('Aviso ao usuário quando passar do ritmo (opcional)')}<textarea class="pg-settings__input" name="notice" maxlength="280" rows="3">${draft.notice}</textarea><span class="pg-settings__hint">${t('Vai uma vez por janela. Não prometa resposta se o produto não responde depois.')}</span></label></div>`
      : h`<p class="pg-settings__sub">${t('Atendimento: 6 respostas por hora em cada conversa. Ao atingir, o agente transfere para a equipe.')}</p>`;
    return form('replies', h`<fieldset class="pg-settings__fieldset"><legend>${t('Ritmo das respostas')}</legend>${body}</fieldset>
      <p class="pg-settings__hint">${t('Ao continuar, a plataforma cria o agente, a chave só para o canal escolhido, o ritmo e o webhook desligado. Repetir não cria nada duplicado.')}</p>`, t('Criar a conexão'));
  }
  function check(done, label, detail, extra = '') {
    return h`<li class="pg-settings__step-row" data-complete="${done}"><span class="pg-settings__step-symbol" aria-hidden="true">${done ? '✓' : '·'}</span><div><strong class="pg-settings__strong">${label}</strong><span class="pg-settings__muted">${detail}</span>${extra}</div><span class="pg-settings__step-state">${done ? t('Feito') : t('Aguardando')}</span></li>`;
  }
  function finalStep() {
    const agent = live?.agent, webhook = agent?.webhook || result.webhook || { configured: false }, qr = channel()?.kind === 'whatsapp_qr';
    const keyBox = token ? h`<div class="pg-settings__fieldset"><strong class="pg-settings__strong">${t('Chave do produto')}</strong><code class="pg-settings__code">${masked(token)}</code>
        <div class="pg-settings__form-actions">${button({ label: t('Copiar chave'), action: 'product-connect-copy-key', variant: 'primary', icon: 'copy' })}
        <label class="pg-settings__check"><input type="checkbox" data-action="product-connect-key-saved" ${keySaved ? 'checked' : ''}/>${t('Guardei a chave no cofre do produto')}</label></div>
        <span class="pg-settings__hint">${t('Ela aparece só agora. Ao concluir, some desta tela.')}</span></div>`
      : banner({ tone: 'warning', title: t('A chave não chegou a esta tela'), body: t('Gere uma chave nova e guarde no cofre do produto.'), action: { label: t('Gerar nova chave'), action: 'product-connect-rotate-key', disabled: busy } });
    const secretBox = !result.webhook?.configured ? '' : secret ? h`<div class="pg-settings__fieldset"><strong class="pg-settings__strong">${t('Segredo do webhook')}</strong><code class="pg-settings__code">${masked(secret)}</code>
        <div class="pg-settings__form-actions">${button({ label: t('Copiar segredo'), action: 'product-connect-copy-secret', variant: 'secondary', icon: 'copy' })}</div></div>`
      : result.secretLost ? banner({ tone: 'warning', title: t('O segredo do webhook não chegou a esta tela'), body: t('Gere um segredo novo e configure no produto.'), action: { label: t('Gerar novo segredo'), action: 'product-connect-rotate-secret', disabled: busy } }) : '';
    const target = channel(), where = target ? `${target.name}${target.label ? ` (${target.label})` : ''}` : '';
    const webhookCheck = webhook.configured ? check(webhook.enabled && /^2\d\d$/.test(String(webhook.lastStatus || '')), t('Webhook ligado e entregue'), webhook.enabled ? t('Envie uma mensagem de teste; a primeira entrega aparece aqui.') : t('Ligue quando o produto estiver pronto para receber.'),
      webhook.enabled ? '' : h`<div class="pg-settings__form-actions">${button({ label: t('Ligar webhook'), action: 'product-connect-webhook-on', variant: 'secondary', disabled: busy })}</div>`) : '';
    const defaultAgent = qr ? check(Boolean(live?.channel?.defaultAgent), t('Agente padrão do canal (opcional)'), t('Conversa nova já nasce com o agente. Ligue só quando o produto estiver respondendo.'),
      live?.channel?.defaultAgent ? '' : h`<div class="pg-settings__form-actions">${button({ label: t('Ligar agente padrão'), action: 'product-connect-default-agent', variant: 'ghost', disabled: busy })}</div>`) : '';
    const expired = timer === null && now() - pollStarted > POLL_BUDGET_MS;
    return h`<div class="pg-settings__form">${keyBox}${secretBox}
      <div class="pg-settings__fieldset"><strong class="pg-settings__strong">${t('Endereços para o produto')}</strong>
        <span class="pg-settings__muted">REST <code class="pg-settings__code">${origin()}/api/service/v1</code> · MCP <code class="pg-settings__code">${origin()}/api/agent/mcp</code></span></div>
      <ul class="pg-settings__checks" aria-live="polite">
        ${check(Boolean(agent?.lastSeenAt), t('O produto usou a chave'), t('Configure a chave no produto e faça a primeira chamada.'))}
        ${webhookCheck}
        ${check(Number(agent?.replies24h || 0) > 0, t('O agente respondeu'), where ? t('Mande uma mensagem de um celular da equipe para {where}.', { where }) : t('Mande uma mensagem de teste para o canal.'))}
        ${defaultAgent}
      </ul>
      ${expired ? h`<p class="pg-settings__hint">${t('A conferência automática parou depois de 10 minutos.')} ${button({ label: t('Conferir de novo'), action: 'product-connect-recheck', variant: 'ghost' })}</p>` : ''}
      ${error ? banner({ tone: 'danger', title: t('Não foi possível concluir'), body: error }) : ''}
      <div class="pg-settings__form-actions">${button({ label: t('Concluir'), action: 'product-connect-finish', variant: 'primary', disabled: busy || Boolean(token && !keySaved) })}${token && !keySaved ? h`<span class="pg-settings__hint">${t('Confirme que guardou a chave para concluir.')}</span>` : ''}</div></div>`;
  }

  return {
    get active() { return active; },
    start(products = []) {
      stopPolling(); wipe(); active = true; step = 1; draft = blank(); channels = null; result = null; live = null; error = ''; requestId = freshRequestId();
      companies = products.map(item => ({ tenantId: item.tenantId, name: item.name }));
      draft.tenantId = companies[0]?.tenantId || 'new'; render();
    },
    view() {
      if (!active) return '';
      const bodies = [productStep, channelStep, agentStep, eventsStep, repliesStep, finalStep];
      return h`<section class="pg-settings__section" aria-labelledby="product-connect-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="product-connect-title">${t('Conectar produto')}</h2>
        <p class="pg-settings__sub">${t('Seis passos: produto, canal, agente, eventos, ritmo e o teste de ponta a ponta.')}</p></div>${step === 6 ? badge(t('Conexão criada'), 'success') : ''}</div>${stepsMarkup()}${bodies[step - 1]()}</section>`;
    },
    async submit(element, data = new FormData(element)) {
      const name = element.dataset.productConnectForm;
      if (name === 'product') {
        Object.assign(draft, { tenantId: String(data.get('tenantId') || ''), newCompany: String(data.get('newCompany') || '').trim(), kind: data.get('kind') === 'attendance' ? 'attendance' : 'assistant' });
        await guarded(async () => {
          if (draft.tenantId === 'new') {
            if (!draft.newCompany) throw new Error(t('Dê um nome ao novo produto.'));
            const created = await request('/api/tenants', { method: 'POST', body: JSON.stringify({ name: draft.newCompany, segment: 'Produto' }) });
            companies.push({ tenantId: created.id, name: created.name || draft.newCompany }); draft.tenantId = created.id; draft.newCompany = '';
          }
          if (!company()) throw new Error(t('Escolha o produto.'));
          if (!draft.agentName) draft.agentName = `${company().name} · Agente`.slice(0, 48);
          await loadChannels(); step = 2;
        });
      } else if (name === 'channel') {
        draft.channelId = String(data.get('channelId') || '');
        if (!channel()) { error = t('Escolha o canal.'); render(); return; }
        error = ''; step = 3; render();
      } else if (name === 'agent') {
        draft.agentName = String(data.get('agentName') || '').trim();
        draft.capabilities = ['conversation.read', ...data.getAll('capabilities').map(String).filter(id => id !== 'conversation.read')];
        if (!draft.agentName) { error = t('Dê um nome ao agente.'); render(); return; }
        error = ''; step = 4; render();
      } else if (name === 'events') {
        Object.assign(draft, { events: data.get('events') === 'wait' ? 'wait' : 'webhook', webhookUrl: String(data.get('webhookUrl') || '').trim(), secretMode: data.get('secretMode') === 'provide' ? 'provide' : 'generate' });
        providedSecret = String(data.get('providedSecret') || '');
        if (draft.events === 'webhook' && !/^https:\/\/\S+$/.test(draft.webhookUrl)) { error = t('Informe o endereço HTTPS do webhook ou escolha a espera de eventos.'); render(); return; }
        if (draft.events === 'webhook' && draft.secretMode === 'provide' && (providedSecret.length < 32 || providedSecret.length > 256)) { error = t('O segredo do produto precisa ter de 32 a 256 caracteres.'); render(); return; }
        error = ''; step = 5; render();
      } else if (name === 'replies') {
        if (draft.kind === 'assistant') Object.assign(draft, { perHour: Number(data.get('perHour')), perMinute: Number(data.get('perMinute')), notice: String(data.get('notice') || '').trim() });
        await guarded(async () => {
          const body = { requestId, tenantId: draft.tenantId, channelId: draft.channelId, kind: draft.kind, agentName: draft.agentName, capabilities: draft.capabilities,
            ...(draft.kind === 'assistant' ? { replyPolicy: { perHour: draft.perHour, perMinute: draft.perMinute, notice: draft.notice } } : {}),
            ...(draft.events === 'webhook' ? { webhook: { url: draft.webhookUrl, ...(draft.secretMode === 'provide' ? { secret: providedSecret } : {}) } } : {}) };
          const answer = await request('/api/platform/product-connections', { method: 'POST', body: JSON.stringify(body) });
          token = typeof answer?.token === 'string' ? answer.token : ''; secret = typeof answer?.secret === 'string' ? answer.secret : ''; providedSecret = '';
          result = { ...answer, token: '', secret: '' }; keySaved = false; step = 6; startPolling();
        });
      }
    },
    async act(name, element) {
      if (!name?.startsWith('product-connect-')) return false;
      if (name === 'product-connect-cancel' || name === 'product-connect-finish') { const done = name === 'product-connect-finish'; close(); if (done) toast(t('Produto conectado.')); return true; }
      if (name === 'product-connect-back') { if (step > 1 && step < 6) { step -= 1; error = ''; render(); } return true; }
      if (name === 'product-connect-open-channels') { const tenantId = draft.tenantId; close(); await openChannels(tenantId); return true; }
      if (name === 'product-connect-key-saved') { keySaved = element?.checked === true; render(); return true; }
      if (name === 'product-connect-copy-key' || name === 'product-connect-copy-secret') {
        const value = name === 'product-connect-copy-key' ? token : secret;
        try { await copy(value); toast(name === 'product-connect-copy-key' ? t('Chave copiada.') : t('Segredo copiado.')); } catch { toast(t('Não foi possível copiar. Selecione e copie manualmente.'), true); }
        return true;
      }
      if (name === 'product-connect-recheck') { startPolling(); return true; }
      const base = result ? `/api/tenants/${encodeURIComponent(result.tenantId)}` : '';
      const principalPath = result?.principal ? `${base}/service-principals/${encodeURIComponent(result.principal.id)}` : '';
      if (name === 'product-connect-rotate-key') {
        await guarded(async () => {
          const list = await request(`${base}/service-principals`), current = (list?.principals || []).find(item => item.id === result.principal.id);
          const rotated = await request(`${principalPath}/rotate`, { method: 'POST', body: JSON.stringify({ revision: current.revision }) });
          token = typeof rotated?.token === 'string' ? rotated.token : ''; keySaved = false;
        });
        return true;
      }
      if (name === 'product-connect-rotate-secret' || name === 'product-connect-webhook-on') {
        await guarded(async () => {
          const current = (await request(`${principalPath}/webhook`))?.webhook;
          if (name === 'product-connect-rotate-secret') { const rotated = await request(`${principalPath}/webhook/rotate`, { method: 'POST', body: JSON.stringify({ revision: current.revision }) }); secret = rotated?.secret || ''; result.secretLost = !secret; }
          else { const changed = await request(`${principalPath}/webhook`, { method: 'PUT', body: JSON.stringify({ enabled: true, revision: current.revision }) }); result.webhook = changed?.webhook || result.webhook; toast(t('Webhook ligado.')); }
          void poll();
        });
        return true;
      }
      if (name === 'product-connect-default-agent') {
        await guarded(async () => { await request(`${base}/channels/${encodeURIComponent(result.channelId)}/default-agent`, { method: 'POST', body: JSON.stringify({ agentId: result.agent.id }) }); toast(t('Agente padrão ligado neste canal.')); void poll(); });
        return true;
      }
      return false;
    },
    close
  };
}
