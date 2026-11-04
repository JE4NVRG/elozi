import './locales-telegram-account.js';
import { t as i18nT, html as i18nHtml, txt as i18nTxt, markup as i18nMarkup, labels as i18nLabels, h, raw, getLocale, translateError } from './i18n.js';
import './locales-management.js';
import './locales-settings.js';
import { CHANNEL_JOURNEY_IDS, channelJourney, channelJourneyTotals } from './channel-journey.js';
import { motionOK } from './theme-prefs.js';
import { button as uiButton, badge as uiBadge, emptyState } from './ui.js';
import { glyph } from './icons.js';
import { pageHeader } from './settings-ui.js';

// Plataforma › Integrações (FRONTEND-V2 §8.9, P8), platform owner only: the providers of the whole
// platform (Google login, the copilot model and e-mail), the encrypted backup and the catalog of the
// selected company's integrations with the journey of each channel. The MCP servers and tool grants
// live in Agentes › Ferramentas (#agents/tools).
const filters = [['all', 'Todas'], ['channels', 'Canais'], ['access', 'Acesso e e-mail'], ['agents', 'Agentes']].map(row => i18nLabels(row));
const connectionNames = i18nLabels({ disconnected: 'Desconectado', starting: 'Iniciando', qr: 'Aguardando QR', connecting: 'Conectando', reconnecting: 'Reconectando', connected: 'Conectado', logged_out: 'Sessão encerrada', wrong_number: 'Número diferente', failed: 'Falha de conexão', error: 'Conexão requer atenção', configured: 'Configurado · validar', planned: 'Configuração pendente', sandbox: 'Demonstração' });
const toneOf = legacy => ({ green: 'success', blue: 'info', amber: 'warning' })[legacy] || 'neutral';
const brandPaths = {
  whatsapp: '<path d="M24 7a16 16 0 0 0-13.8 24L8 40l9-2.2A16 16 0 1 0 24 7Z" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M18 16c-2 1-3 3-2 6 2 6 7 10 12 10 2 0 4-2 4-4l-6-3-2 2c-3-1-5-3-6-6l2-2-2-3Z" fill="currentColor"/>',
  telegram: '<circle cx="24" cy="24" r="19" fill="currentColor"/><path d="m13 23 23-9-5 22-8-6-4 4 1-7 11-10-15 8Z" fill="#fff"/>',
  webchat: '<path d="M11 9h26a5 5 0 0 1 5 5v16a5 5 0 0 1-5 5H23l-10 7v-7h-2a5 5 0 0 1-5-5V14a5 5 0 0 1 5-5Z" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="15" cy="22" r="2" fill="currentColor"/><circle cx="24" cy="22" r="2" fill="currentColor"/><circle cx="33" cy="22" r="2" fill="currentColor"/>',
  instagram: '<rect x="8" y="8" width="32" height="32" rx="10" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="24" cy="24" r="8" fill="none" stroke="currentColor" stroke-width="2.4"/><circle cx="34" cy="14" r="2" fill="currentColor"/>',
  messenger: '<path d="M24 7C13 7 5 14 5 24c0 6 3 11 8 14v7l7-4c14 2 23-6 23-17C43 14 35 7 24 7Z" fill="currentColor"/><path d="m12 29 10-12 7 6 8-5-10 12-7-6Z" fill="#fff"/>',
  email: '<rect x="8" y="12" width="32" height="24" rx="5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m10 15 14 11 14-11" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  google: '<path d="M39 24c0-1-.1-2-.3-3H24v6h8.5a9 9 0 0 1-3.6 5l5 4A15 15 0 0 0 39 24Z" fill="#4285f4"/><path d="M24 40a16 16 0 0 0 10-4l-5-4a9 9 0 0 1-13-4l-5 4a16 16 0 0 0 13 8Z" fill="#34a853"/><path d="M16 28a9 9 0 0 1 0-8l-5-4a16 16 0 0 0 0 16Z" fill="#fbbc05"/><path d="M16 20a9 9 0 0 1 15-3l5-5a16 16 0 0 0-25 4Z" fill="#ea4335"/>',
  mepmail: '<rect x="8" y="12" width="32" height="24" rx="5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m10 15 14 11 14-11M10 34l10-10M38 34 28 24" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  hermes: '<rect x="9" y="13" width="30" height="26" rx="8" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M24 7v6M17 30h14M5 23h4M39 23h4" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="18" cy="23" r="2" fill="currentColor"/><circle cx="30" cy="23" r="2" fill="currentColor"/>',
  claude: '<path d="M24 7v34M7 24h34M12 12l24 24M12 36l24-24M16 8l16 32M8 16l32 16M8 32l32-16M16 40 32 8" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"/>',
  codex: '<path d="m17 13-11 11 11 11M31 13l11 11-11 11M28 9l-8 30" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>',
  webhook: '<circle cx="24" cy="11" r="5" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="12" cy="34" r="5" fill="none" stroke="currentColor" stroke-width="2.2"/><circle cx="36" cy="34" r="5" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="m24 16-9 14M17 34h14M33 30l-7-12" fill="none" stroke="currentColor" stroke-width="2.2"/>',
  mcp: '<path d="m9 22 12-12a7 7 0 0 1 10 10L19 32M17 17l12-12M19 32l10 10M25 26l10-10a7 7 0 0 1 10 10L33 38" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
};

export function createIntegrationsUI(ctx) {
  const { state, escape: e, openModal } = ctx;
  const admin = () => state.boot?.session?.role === 'reseller' && !state.supportGrantId && !state.boot?.session?.supportGrantId && state.boot?.session?.kind !== 'service';
  const owner = () => Boolean(state.boot?.session?.platformOwner);
  const agentList = provider => (state.tenant?.agents || []).filter(agent => agent.provider === provider);
  const symbol = id => h`<span class="pg-settings__symbol"><svg viewBox="0 0 48 48" aria-hidden="true">${raw(brandPaths[id] || brandPaths.webhook)}</svg></span>`;
  const action = (label, name, id, primary = false) => uiButton({ label, action: name, size: 'sm', variant: primary ? 'primary' : 'secondary', icon: 'arrow', attrs: { 'data-id': id } });
  const viewLink = (label, view) => uiButton({ label, size: 'sm', icon: 'arrow', attrs: { 'data-view': view } });
  const details = () => ({
    whatsapp: [i18nT('WhatsApp QR'), i18nT('Conversas privadas e grupos selecionados, pelo número conectado à empresa. Mensagens e anexos mantêm a origem. Cada número tem sua própria conexão e sessão.')],
    telegram: ['Telegram', i18nT('Conecte um bot criado no BotFather para receber conversas privadas, grupos e tópicos. O cliente precisa iniciar o contato; as permissões do bot determinam quais mensagens dos grupos ficam disponíveis.')],
    telegram_user:[i18nT('Telegram pessoal'),i18nT('Escolha as conversas da sua conta para atendimento humano.')],
    google: [i18nT('Login com Google'), i18nT('Um método de acesso ao painel. A configuração pertence à plataforma; cada pessoa pode vincular sua conta em Minha conta. Configurado significa que o Client ID foi salvo.')],
    mepmail: ['MepMail', i18nT('Provedor das notificações da conta, configurado pela plataforma. Configurado indica chave e remetente cadastrados; a aceitação pelo provedor não comprova entrega. Para conversas com clientes, configure um canal de e-mail nesta empresa.')],
    hermes: ['Hermes', i18nT('O adaptador Hermes prepara rascunhos por empresa para revisão humana. Uma configuração salva não comprova que o serviço esteja respondendo. Ferramentas MCP precisam de concessões individuais; o envio continua com o atendente.')],
    claude: ['Claude', i18nT('Você pode usar um agente Claude externo com uma identidade MCP desta empresa. Configure o cliente externo com o acesso autorizado. O cadastro no painel não inicia uma sessão nem concede ferramentas automaticamente.')],
    codex: ['Codex', i18nT('Você pode usar um agente Codex externo com uma identidade MCP desta empresa. Configure o cliente externo com o acesso autorizado. O cadastro no painel não inicia uma sessão nem concede ferramentas automaticamente.')],
    webhook: [i18nT('API e webhook'), i18nT('O cadastro prepara a identidade de uma integração externa. O conector genérico e seu contrato de execução ainda serão implementados.')],
    mcp: [i18nT('Ferramentas MCP'), i18nT('Os servidores e suas ferramentas pertencem à empresa selecionada. O administrador descobre o catálogo e concede ferramentas individualmente aos agentes. Cada execução espera a aprovação do responsável pelo atendimento, com argumentos visíveis e resultado usado no rascunho.')]
  });

  function catalog() {
    const googleEnabled = owner() ? Boolean(state.integrations?.google?.enabled) : Boolean(state.account?.google?.enabled);
    const emailConfigured = owner() ? Boolean(state.integrations?.email?.configured) : Boolean(state.account?.emailConfigured);
    const hermes = agentList('hermes'), configured = hermes.filter(agent => agent.configured).length;
    return [
      ...CHANNEL_JOURNEY_IDS.map(id => ({ ...channelJourney(id, state.tenant?.channels), category: 'channels', scope: i18nT('Nesta empresa') })),
      { id: 'google', name: 'Google', category: 'access', scope: i18nT('Toda a plataforma'), description: i18nT('Um acesso mais simples para a sua equipe e seus clientes.'), text: googleEnabled ? i18nT('Configurado') : i18nT('Configuração pendente'), tone: googleEnabled ? 'blue' : 'neutral', detail: googleEnabled ? i18nT('Vínculo individual em Minha conta.') : i18nT('O administrador da plataforma configura o login.') },
      { id: 'mepmail', name: 'MepMail', category: 'access', scope: i18nT('Toda a plataforma'), description: i18nT('Confirmação de cadastro e notificações da conta.'), text: emailConfigured ? i18nT('Configurado') : i18nT('Configuração pendente'), tone: emailConfigured ? 'blue' : 'neutral', detail: emailConfigured ? i18nT('Confirmação de e-mail disponível em Minha conta.') : i18nT('Chave e remetente definidos pela plataforma.') },
      { id: 'hermes', name: 'Hermes', category: 'agents', scope: i18nT('Nesta empresa'), description: i18nT('Um copiloto para preparar respostas com contexto.'), text: configured ? i18nT('Configurado') : i18nT('Configuração pendente'), tone: configured ? 'blue' : 'neutral', detail: hermes.length ? i18nTxt`${configured} de ${hermes.length} ${hermes.length === 1 ? i18nT('copiloto configurado') : i18nT('copilotos configurados')}. Envio humano.` : i18nT('Adaptador disponível. Cadastre o copiloto desta empresa.'), instances: hermes },
      { id: 'claude', name: 'Claude', category: 'agents', scope: i18nT('Acessos de agentes'), description: i18nT('Use seu agente externo por um acesso MCP autorizado à empresa.'), text: i18nT('Conexão via MCP'), tone: 'neutral', detail: i18nT('A sessão do agente depende da configuração no cliente externo.'), externalAgent: true },
      { id: 'codex', name: 'Codex', category: 'agents', scope: i18nT('Acessos de agentes'), description: i18nT('Use seu agente externo por um acesso MCP autorizado à empresa.'), text: i18nT('Conexão via MCP'), tone: 'neutral', detail: i18nT('A sessão do agente depende da configuração no cliente externo.'), externalAgent: true },
      { id: 'webhook', name: i18nT('API e webhook'), category: 'agents', scope: i18nT('Próximo conector'), description: i18nT('Conecte o runtime que faz sentido para sua operação.'), text: i18nT('Em evolução'), tone: 'neutral', detail: i18nT('Conector genérico ainda não disponível.'), planned: true },
      { id: 'mcp', name: i18nT('Ferramentas MCP'), category: 'agents', scope: i18nT('Nesta empresa'), description: i18nT('Ferramentas concedidas a cada agente, com aprovação humana.'), ...(ctx.mcpSummary?.() || { text: i18nT('Configurar'), tone: 'neutral', detail: i18nT('O administrador configura os servidores desta empresa.') }) }
    ];
  }

  function instancesMarkup(item) {
    if (!item.instances?.length) return '';
    return h`<ul class="pg-settings__instances">${item.instances.map(instance => {
      const runtime = item.id === 'hermes';
      const instanceStatus = runtime ? instance.configured ? i18nT('Configurado') : i18nT('Pendente') : connectionNames[instance.state] || i18nT('Desconectado');
      const tone = runtime ? instance.configured ? 'info' : 'neutral' : instance.state === 'connected' ? 'success' : instance.state === 'configured' ? 'info' : ['failed', 'error', 'wrong_number', 'logged_out', 'reconnecting'].includes(instance.state) ? 'warning' : 'neutral';
      const connector = ['webchat', 'email', 'instagram', 'messenger'].includes(item.id);
      const mainAction = runtime ? action(i18nT('Configurar'), 'configure-agent', instance.id) : connector ? action(i18nT('Configurar esta conexão'), 'configure-channel', instance.id) : !instance.native ? action(i18nT('Ver caminho'), 'channel-info', instance.id) : action(instance.state === 'connected' ? i18nT('Ver conexão') : i18nT('Conectar'), item.id === 'whatsapp' ? 'connect-channel' : item.id==='telegram_user'?'connect-telegram-account':'connect-telegram', instance.id);
      const extraAction = !runtime && instance.native && instance.state === 'connected' ? item.id === 'whatsapp' ? action(i18nTxt`Grupos (${instance.enabledGroups || 0})`, 'channel-groups', instance.id) : item.id === 'telegram' ? h`${action(i18nT('Personalizar bot'), 'telegram-profile', instance.id)}${action(i18nT('Grupos'), 'telegram-groups', instance.id)}` : '' : '';
      return h`<li class="pg-settings__instance" data-integration-instance-tone="${tone}"><span class="pg-settings__dot" data-tone="${tone}" aria-hidden="true"></span><span class="pg-settings__item-main"><strong class="pg-settings__strong">${instance.name}</strong><span class="pg-settings__sub">${runtime ? instance.model || i18nT('Copiloto · envio humano') : instance.label || i18nT('Conexão desta empresa')}</span></span>${uiBadge(instanceStatus, tone)}${admin() ? h`<span class="pg-settings__cluster">${mainAction}${extraAction}</span>` : ''}</li>`;
    })}</ul>`;
  }

  function cardMarkup(item) {
    let cta;
    if (item.planned) cta = action(i18nT('Conhecer proposta'), 'integration-info', item.id);
    else if (item.category === 'channels') cta = item.instances.length ? viewLink(i18nT('Gerenciar canais'), 'channels') : admin() ? uiButton({ label: i18nT('Adicionar canal'), action: 'new-channel', size: 'sm', icon: 'plus' }) : viewLink(i18nT('Ver canais'), 'channels');
    else if (item.externalAgent) cta = viewLink(admin() ? i18nT('Acessos de agentes') : i18nT('Ver copilotos'), admin() ? 'service-agents' : 'agents');
    else if (item.id === 'hermes') cta = item.instances.length ? viewLink(i18nT('Ver copilotos'), 'agents') : admin() ? uiButton({ label: i18nT('Adicionar copiloto'), action: 'new-agent', size: 'sm', icon: 'plus' }) : viewLink(i18nT('Ver copilotos'), 'agents');
    else if (item.id === 'mcp') cta = admin() ? action(i18nT('Gerenciar ferramentas'), 'mcp-settings', item.id) : action(i18nT('Ver funcionamento'), 'integration-info', item.id);
    else cta = owner() ? action(i18nT('Configurar'), 'integration-settings', item.id) : viewLink(i18nT('Minha conta'), 'account');
    const keywords = `${item.name} ${item.description} ${item.scope} ${item.text} ${(item.instances || []).map(instance => instance.name).join(' ')}`;
    const info = item.planned ? '' : item.category === 'channels' ? action(i18nT('Ver passos'), 'integration-info', item.id) : uiButton({ label: i18nT('Sobre {name}', { name: item.name }), action: 'integration-info', size: 'sm', variant: 'ghost', icon: 'info', attrs: { 'data-id': item.id } });
    return h`<article class="pg-settings__card pg-settings__integration" data-integration-card data-integration-category="${item.category}" data-integration-keywords="${keywords}"><div class="pg-settings__card-head"><span class="pg-settings__cluster">${symbol(item.id)}<span class="pg-settings__identity-text"><strong class="pg-settings__strong">${item.name}</strong><span class="pg-settings__sub">${item.scope}</span></span></span>${uiBadge(item.text, toneOf(item.tone))}</div><p class="pg-settings__text">${item.description}</p><p class="pg-settings__muted">${item.detail}</p>${instancesMarkup(item)}<div class="pg-settings__cluster">${cta}${info}</div></article>`;
  }

  /** Providers of the whole platform (owner): Google login, the copilot model and e-mail, plus the backup. */
  function platformSettings() {
    const config = state.integrations;
    if (!owner() || !config) return '';
    const origin = state.boot?.canonicalPublicOrigin || state.boot?.publicOrigin || globalThis.location?.origin || '';
    const brand = state.boot?.reseller?.brand?.name || '';
    return h`<form id="integrations-form" class="pg-settings__stack" data-integration-settings aria-label="${i18nT('Configurações da plataforma')}">
      <div class="pg-settings__grid pg-settings__grid--2">
        <section class="pg-settings__section" aria-labelledby="integrations-google-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="integrations-google-title">${symbol('google')}${i18nT('Login com Google')}</h2><p class="pg-settings__muted">${i18nT('Cadastre um Client ID do tipo aplicação web no Google Cloud.')}</p></div>${uiBadge(config.googleClientId ? i18nT('Configurado') : i18nT('Aguardando Client ID'), config.googleClientId ? 'success' : 'neutral')}</div>
          <label class="pg-settings__field">${i18nT('Client ID web')}<input class="pg-settings__input" name="googleClientId" value="${config.googleClientId || ''}" maxlength="220" placeholder="…apps.googleusercontent.com" autocomplete="off"/><span class="pg-settings__hint">${i18nT('Origem autorizada: {origin}. O login usa o Google Identity Services.', { origin })}</span></label>
        </section>
        <section class="pg-settings__section" aria-labelledby="integrations-model-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="integrations-model-title">${symbol('hermes')}${i18nT('Modelo dos copilotos')}</h2><p class="pg-settings__muted">${i18nT('Hermes com o DeepSeek V4.1 Flash pela API CommandCode. A chave fica cifrada no servidor e só o dono da plataforma pode alterá-la.')}</p></div>${uiBadge(config.commandCode?.configured ? i18nT('Chave cadastrada') : i18nT('Aguardando chave'), config.commandCode?.configured ? 'info' : 'neutral')}</div>
          <label class="pg-settings__field">${i18nT('Chave da API CommandCode')}<input class="pg-settings__input" name="commandCodeApiKey" type="password" autocomplete="new-password" maxlength="4096" spellcheck="false" placeholder="${config.commandCode?.configured ? i18nT('Deixe vazio para manter a chave') : i18nT('Cadastre a chave válida da API')}"/><span class="pg-settings__hint">${i18nT('Use a chave do Studio CommandCode. Não envie chaves por mensagem.')}</span></label>
          <label class="pg-settings__check"><input name="disableCommandCode" type="checkbox"/>${i18nT('Desativar acesso ao modelo')}</label>
          <p class="pg-settings__muted">${i18nT('Modelo: deepseek/deepseek-v4.1-flash · rascunhos com revisão humana.')}</p>
        </section>
        <section class="pg-settings__section" aria-labelledby="integrations-email-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="integrations-email-title">${symbol('mepmail')}${i18nT('E-mail da plataforma')}</h2><p class="pg-settings__muted">${i18nT('Cadastro e notificações pelo MepMail.')}</p></div>${uiBadge(config.email?.configured ? i18nT('MepMail configurado') : i18nT('Aguardando configuração'), config.email?.configured ? 'success' : 'neutral')}</div>
          <label class="pg-settings__field">${i18nT('Remetente verificado')}<input class="pg-settings__input" name="emailFrom" value="${config.email?.from || ''}" maxlength="340" placeholder="${brand ? `${brand} <contato@seu-dominio.com>` : 'contato@seu-dominio.com'}" autocomplete="off"/></label>
          <label class="pg-settings__field">${i18nT('Chave de envio')}<input class="pg-settings__input" name="emailApiKey" type="password" autocomplete="new-password" maxlength="512" placeholder="${config.email?.configured ? i18nT('Deixe vazio para manter a chave') : i18nT('Chave exclusiva de envio MepMail')}"/><span class="pg-settings__hint">${i18nT('Use uma chave exclusiva, restrita ao domínio do remetente.')}</span></label>
          <label class="pg-settings__check"><input name="disableEmail" type="checkbox"/>${i18nT('Desativar envio de e-mails')}</label>
          <p class="pg-settings__muted pg-settings__num">${i18nT('{pending} pendentes · {confirmed} aceitos pelo provedor · {unknown} sem confirmação', { pending: config.email?.pending ?? 0, confirmed: config.email?.confirmed ?? 0, unknown: config.email?.unknown ?? 0 })}</p>
        </section>
        <section class="pg-settings__section" aria-labelledby="integrations-backup-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="integrations-backup-title">${glyph('shield')}${i18nT('Cópia de segurança')}</h2><p class="pg-settings__muted">${i18nT('Gera um backup cifrado dos dados locais. A cópia é verificada antes de confirmar a criação.')}</p></div></div>
          <div>${uiButton({ label: i18nT('Criar backup'), action: 'create-backup', icon: 'shield' })}</div>
        </section>
      </div>
      <p class="form-error pg-settings__error" role="alert"></p>
      <div class="pg-settings__form-actions">${uiButton({ label: i18nT('Salvar integrações'), type: 'submit', variant: 'primary', icon: 'check' })}</div>
    </form>`;
  }

  function view() {
    if (!owner()) return String(h`<div class="pg-settings">${pageHeader({ title: i18nT('Integrações da plataforma') })}${emptyState({ icon: 'shield', title: i18nT('A configuração de integrações pertence ao dono da plataforma.'), body: i18nT('Os canais e agentes de cada empresa ficam em Canais e Agentes.') })}</div>`);
    const totals = channelJourneyTotals(state.tenant?.channels);
    const configured = agentList('hermes').filter(agent => agent.configured).length;
    const filter = filters.some(([id]) => id === state.integrationFilter) ? state.integrationFilter : 'all';
    state.integrationFilter = filter;
    const search = state.integrationSearch || '';
    return String(h`<div class="pg-settings pg-settings--integrations">
      ${pageHeader({ title: i18nT('Integrações da plataforma'), lead: i18nT('Login, e-mail e o modelo dos copilotos valem para toda a plataforma. O catálogo abaixo mostra a empresa selecionada.') })}
      ${platformSettings()}
      <section id="integration-catalog" class="pg-settings__section" aria-labelledby="integration-catalog-title">
        <div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="integration-catalog-title">${i18nT('Catálogo de {company}', { company: state.tenant?.name || i18nT('Sua empresa') })}</h2><p class="pg-settings__muted">${i18nT('Canais, acesso e copilotos. Cada conexão com seu estado e seu lugar.')}</p></div>${admin() ? uiButton({ label: i18nT('Adicionar canal'), action: 'new-channel', variant: 'primary', icon: 'plus', size: 'sm' }) : ''}</div>
        <dl class="pg-settings__stats"><div class="pg-settings__stat"><dt class="pg-settings__stat-label">${i18nT('Canais conectados')}</dt><dd class="pg-settings__stat-value">${totals.connected}<span class="pg-settings__muted"> / ${totals.total}</span></dd></div><div class="pg-settings__stat"${raw(totals.attention ? ' data-tone="warning"' : '')}><dt class="pg-settings__stat-label">${i18nT('Precisam de atenção')}</dt><dd class="pg-settings__stat-value">${totals.attention}</dd></div><div class="pg-settings__stat"><dt class="pg-settings__stat-label">${i18nT('Copilotos configurados')}</dt><dd class="pg-settings__stat-value">${configured}</dd></div></dl>
        <div class="pg-settings__toolbar pg-settings__toolbar--plain"><div class="pg-settings__cluster" role="group" aria-label="${i18nT('Filtrar integrações')}">${filters.map(([id, label]) => uiButton({ label, action: 'integration-filter', size: 'sm', variant: id === filter ? 'primary' : 'secondary', attrs: { 'data-id': id, 'aria-pressed': id === filter ? 'true' : 'false' } }))}</div><label class="pg-settings__search">${glyph('search')}<span class="sr-only">${i18nT('Buscar integração')}</span><input class="pg-settings__input" data-integration-search value="${search}" maxlength="120" placeholder="${i18nT('Buscar integração')}" type="search" autocomplete="off"/></label><p class="pg-settings__total" data-integration-result-count role="status" aria-live="polite"></p></div>
        <div class="pg-settings__catalog">${catalog().map(cardMarkup)}</div>
        <div data-integration-no-results hidden>${emptyState({ icon: 'search', title: i18nT('Nenhuma integração neste filtro.'), body: i18nT('Tente outro nome ou selecione Todas.'), level: 3 })}</div>
        <p class="pg-settings__muted">${i18nT('Depois de conectar, confira o canal no Atendimento e use os copilotos desta empresa para preparar respostas com revisão humana.')}</p>
      </section>
    </div>`);
  }

  const normalize = value => String(value).normalize('NFD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase(getLocale()).trim();
  function applyFilter() {
    const container = document.querySelector('#integration-catalog');
    if (!container) return;
    const term = normalize(state.integrationSearch || '');
    let count = 0;
    container.querySelectorAll('[data-integration-card]').forEach(card => {
      const visible = (state.integrationFilter === 'all' || card.dataset.integrationCategory === state.integrationFilter) && normalize(card.dataset.integrationKeywords).includes(term);
      card.hidden = !visible;
      if (visible) count++;
    });
    container.querySelectorAll('[data-action="integration-filter"]').forEach(filter => {
      const selected = filter.dataset.id === state.integrationFilter;
      filter.classList?.toggle?.('ui-btn--primary', selected); filter.classList?.toggle?.('ui-btn--secondary', !selected);
      filter.setAttribute('aria-pressed', String(selected));
    });
    const empty = container.querySelector('[data-integration-no-results]');
    if (empty) empty.hidden = count !== 0;
    const result = container.querySelector('[data-integration-result-count]');
    if (result) result.textContent = `${count} ${count === 1 ? i18nT('integração') : i18nT('integrações')}`;
  }

  function bind() {
    const input = document.querySelector('[data-integration-search]');
    if (input && !input.dataset.integrationBound) {
      input.dataset.integrationBound = 'true';
      input.addEventListener('input', () => { state.integrationSearch = input.value; applyFilter(); });
    }
    applyFilter();
  }

  function act(name, id) {
    if (name === 'integration-filter') {
      if (!filters.some(([value]) => value === id)) return true;
      state.integrationFilter = id; applyFilter(); return true;
    }
    if (name === 'integration-settings') {
      if (!owner() || !['google', 'mepmail'].includes(id)) return true;
      const section = document.querySelector('[data-integration-settings]');
      section?.scrollIntoView({ behavior: motionOK() ? 'smooth' : 'auto', block: 'start' });
      section?.querySelector(id === 'google' ? '[name="googleClientId"]' : '[name="emailFrom"]')?.focus({ preventScroll: true });
      return true;
    }
    if (name !== 'integration-info') return false;
    const journey = channelJourney(id, state.tenant?.channels);
    if (journey) {
      const steps = journey.steps.map(step => i18nHtml`<li class="pg-settings__step-row" ${step.number === journey.currentStep ? 'aria-current="step"' : ''} data-complete="${step.saved ? 'true' : 'false'}"><span class="pg-settings__step-symbol" aria-hidden="true">${step.number}</span><div><strong class="pg-settings__strong">${e(step.label)}</strong><span class="pg-settings__muted">${e(step.detail)}</span></div>${step.saved ? `<span class="pg-settings__step-state">${e(step.number === 1 ? i18nT('Canal cadastrado') : i18nT('Configuração salva'))}</span>` : step.number === journey.currentStep ? `<span class="pg-settings__step-state">${e(i18nT('Próximo passo'))}</span>` : ''}</li>`).join('');
      openModal(journey.name, state.tenant?.name || i18nT('Nesta empresa'), i18nHtml`<div class="pg-settings__dialog"><div class="pg-settings__logo">${String(symbol(id))}<p class="pg-settings__text">${e(journey.description)}</p></div><ol class="pg-settings__checklist">${steps}</ol>${String(instancesMarkup(journey))}${!admin() ? i18nMarkup('<p class="pg-settings__muted">Configuração pelo administrador da empresa.</p>') : ''}<div class="pg-settings__dialog-actions">${!journey.instances.length && admin() ? String(uiButton({ label: i18nT('Adicionar canal'), action: 'new-channel', variant: 'primary', icon: 'plus' })) : ''}<button type="button" class="ui-btn ui-btn--secondary ui-btn--md" data-close-modal><span class="ui-btn__label">Entendido</span></button></div></div>`);
      return true;
    }
    const detail = details()[id];
    if (!detail) return true;
    openModal(detail[0], ['google', 'mepmail'].includes(id) ? i18nT('Integração da plataforma') : i18nT('Integrações da operação'), i18nHtml`<div class="pg-settings__dialog"><div class="pg-settings__logo">${String(symbol(id))}<p class="pg-settings__text">${e(detail[1])}</p></div><div class="pg-settings__dialog-actions"><button type="button" class="ui-btn ui-btn--secondary ui-btn--md" data-close-modal><span class="ui-btn__label">Entendido</span></button></div></div>`);
    return true;
  }

  return { view, act, bind };
}
