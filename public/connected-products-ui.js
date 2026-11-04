import { t, h, getLocale } from './i18n.js';
import './locales-management.js';
import { button, badge, banner, emptyState } from './ui.js';
import { pageHeader } from './settings-ui.js';
import { createProductConnectUI } from './product-connect-ui.js';

// Plataforma › Produtos conectados: each company of the operation with its lines, the automation answering on each
// line, the connected agents with their signed webhook, the reply policy and what the agents ran into. The pairs between
// our own lines show who answers on each side: the server never lets agents answer on both (own-lines.js). Nothing here
// carries message text, contact names or full phone numbers.
const number = value => Number(value || 0).toLocaleString(getLocale());
const when = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString(getLocale(), { dateStyle: 'short', timeStyle: 'short' }) : ''; };
const AUTOMATION = () => ({ 'default-agent': t('Agente padrão'), autopilot: t('Piloto automático'), 'connected-agent': t('Agente conectado') });
const BLOCKED = () => ({ claim: t('ao assumir'), reply: t('ao responder'), handover: t('no repasse'), 'default-agent': t('agente padrão'), autopilot: t('piloto automático') });
const OWNER = () => ({ agent: t('Com agente'), human: t('Com uma pessoa'), queue: t('Na fila'), closed: t('Encerrada'), none: t('Sem conversa ainda') });

function lineText(channel) {
  const kind = channel.kind === 'whatsapp_qr' ? 'WhatsApp' : channel.kind === 'telegram' ? 'Telegram' : channel.kind === 'webchat' ? t('Chat do site') : channel.kind;
  return channel.tail ? t('{kind} · final {tail}', { kind, tail: channel.tail }) : kind;
}
function policyText(policy) {
  return policy?.profile === 'assistant' ? t('Assistente · {hour}/h · {minute}/min', { hour: policy.perHour, minute: policy.perMinute }) + (policy.notice ? ` · ${t('aviso ligado')}` : '') : t('Atendimento');
}
function webhookText(webhook) {
  if (!webhook?.configured) return t('Espera de eventos');
  const state = webhook.enabled ? t('Webhook ligado') : t('Webhook desligado');
  return [state, webhook.lastStatus ? t('último retorno {status}', { status: webhook.lastStatus }) : '', webhook.failures ? t('{count} falhas seguidas', { count: webhook.failures }) : ''].filter(Boolean).join(' · ');
}

function productCard(product) {
  const automated = product.channels.some(channel => channel.automation.length), withAgents = product.agents.filter(agent => agent.state === 'active').length;
  const tone = product.sinceStart.ownLineBlocks ? 'warning' : automated ? 'success' : 'neutral';
  const status = automated ? t('Agentes respondendo') : t('Só a equipe');
  return h`<article class="pg-settings__product" aria-label="${product.name}">
    <div class="pg-settings__product-head"><h3 class="pg-settings__section-title">${product.name}</h3>${badge(status, tone)}</div>
    <dl class="pg-settings__product-facts">
      ${product.channels.map(channel => h`<div><dt>${channel.name || lineText(channel)}</dt><dd>${lineText(channel)} · ${policyText(channel.replyPolicy)}${channel.automation.length ? h`<br/><span class="pg-settings__sub">${channel.automation.map(item => AUTOMATION()[item] || item).join(' · ')}${channel.defaultAgent ? ` (${channel.defaultAgent})` : ''}</span>` : ''}</dd></div>`)}
      ${product.agents.length ? product.agents.map(agent => h`<div><dt>${agent.name}</dt><dd>${agent.agent || t('Agente conectado')} · ${agent.state === 'active' ? t('ativo') : t('inativo')}<br/><span class="pg-settings__sub">${webhookText(agent.webhook)}</span></dd></div>`) : h`<div><dt>${t('Agentes conectados')}</dt><dd>${t('Nenhum')}</dd></div>`}
      <div><dt>${t('Equipe/QA')}</dt><dd>${product.qaConversations ? t('{count} conversas sem limite por hora', { count: product.qaConversations }) : t('Nenhuma')}</dd></div>
    </dl>
    <div class="pg-settings__product-stats" role="group" aria-label="${t('Números de {name}', { name: product.name })}">
      <div><strong>${number(product.last24h.agentReplies)}</strong><span>${t('respostas de agentes em 24 h')}</span></div>
      <div><strong>${number(product.sinceStart.limitHits)}</strong><span>${t('limites atingidos')}</span></div>
      <div><strong>${number(product.last24h.notices)}</strong><span>${t('avisos em 24 h')}</span></div>
      <div><strong>${number(product.sinceStart.ownLineBlocks)}</strong><span>${t('bloqueios entre linhas')}</span></div>
    </div>
    <p class="pg-settings__sub">${t('{count} agentes ativos · {lines} conversas com linhas próprias', { count: withAgents, lines: product.ownLineConversations })}</p>
  </article>`;
}

function pairRow(pair) {
  const side = item => h`<span class="pg-settings__strong">${item.company}</span> · ${item.channel}${item.tail ? ` (${t('final {tail}', { tail: item.tail })})` : ''}<br/><span class="pg-settings__sub">${OWNER()[item.owner] || item.owner}${item.agent ? ` · ${item.agent}` : ''}${item.qa ? ` · ${t('equipe/QA')}` : ''}</span>`;
  const state = pair.state === 'both-agents' ? badge(t('Agentes nos dois lados: respostas bloqueadas'), 'danger') : pair.state === 'one-agent' ? badge(t('Protegido: agente só de um lado'), 'success') : badge(t('Sem agente'), 'neutral');
  return h`<tr><td>${side(pair.sides[0])}</td><td>${side(pair.sides[1])}</td><td>${state}</td></tr>`;
}

function eventText(event) {
  if (event.type === 'own-line') return { what: t('Agente bloqueado entre linhas próprias ({action})', { action: BLOCKED()[event.action] || event.action || '' }), tone: 'warning', result: t('A conversa ficou com a equipe') };
  return { what: event.window === 'minute' ? t('Limite por minuto atingido ({max})', { max: event.max }) : t('Limite por hora atingido ({max})', { max: event.max }), tone: event.noticeSent ? 'info' : 'neutral',
    result: event.noticeSent ? t('Aviso enviado ao usuário') : t('Sem aviso nesta recusa') };
}

/** The page. `data` is the server's answer to /api/platform/connected-products. */
export function connectedProductsMarkup(data, { loading = false, error = '', wizard = '' } = {}) {
  const refresh = button({ label: loading ? t('Atualizando…') : t('Atualizar'), action: 'connected-products-refresh', variant: 'secondary', icon: 'refresh', busy: loading, disabled: loading });
  const connect = button({ label: t('Conectar produto'), action: 'product-connect-start', variant: 'primary', icon: 'plus', disabled: loading || !data });
  const header = pageHeader({ eyebrow: t('Nossa operação'), title: t('Produtos conectados'), id: 'connected-products-title', actions: wizard ? '' : h`${connect}${refresh}`,
    lead: t('Cada produto nosso conversa com os clientes por aqui. Veja as linhas, os agentes, o ritmo de respostas e a entrega de eventos de cada um.') });
  if (wizard) return h`<div class="pg-settings pg-settings--platform">${header}${wizard}</div>`;
  if (error && !data) return h`<div class="pg-settings pg-settings--platform">${header}${banner({ tone: 'danger', title: t('Não foi possível carregar os produtos'), body: error })}</div>`;
  if (!data) return h`<div class="pg-settings pg-settings--platform">${header}<p class="pg-settings__sub" role="status">${t('Carregando os produtos…')}</p></div>`;
  const pairs = data.pairs || [], blocked = pairs.filter(pair => pair.state === 'both-agents').length;
  const protection = h`<section class="pg-settings__section" data-tone="${blocked ? 'danger' : 'accent'}" aria-labelledby="own-lines-title">
    <div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="own-lines-title">${t('Proteção entre linhas próprias')}</h2>
      <p class="pg-settings__sub">${t('{count} linhas pareadas nesta operação. Quando dois produtos nossos conversam, só um lado pode estar com agente; o outro fica com a equipe.', { count: data.ownLines })}</p></div>
      ${blocked ? badge(t('{count} pares com agentes nos dois lados', { count: blocked }), 'danger') : badge(t('Nenhum laço possível agora'), 'success')}</div>
    ${pairs.length ? h`<div class="pg-settings__table-wrap" tabindex="0" role="region" aria-label="${t('Conversas entre linhas próprias')}"><table class="pg-settings__table pg-settings__table--cards"><caption class="sr-only">${t('Conversas entre linhas próprias e quem responde em cada lado')}</caption>
      <thead><tr><th scope="col">${t('Um lado')}</th><th scope="col">${t('Outro lado')}</th><th scope="col">${t('Situação')}</th></tr></thead><tbody>${pairs.map(pairRow)}</tbody></table></div>` : h`<p class="pg-settings__sub">${t('Nenhuma conversa entre linhas próprias ainda.')}</p>`}
  </section>`;
  const products = (data.products || []).length ? h`<div class="pg-settings__products">${data.products.map(productCard)}</div>`
    : emptyState({ icon: 'building', title: t('Nenhuma empresa nesta operação'), body: t('Crie uma empresa e conecte um canal para ver o produto aqui.') });
  const events = (data.events || []).length ? h`<div class="pg-settings__table-wrap" tabindex="0" role="region" aria-label="${t('Eventos recentes dos agentes')}"><table class="pg-settings__table pg-settings__table--cards"><caption class="sr-only">${t('Eventos recentes dos agentes conectados')}</caption>
      <thead><tr><th scope="col">${t('Quando')}</th><th scope="col">${t('Produto')}</th><th scope="col">${t('O que aconteceu')}</th><th scope="col">${t('Resultado')}</th></tr></thead>
      <tbody>${data.events.map(event => { const view = eventText(event); return h`<tr><td>${when(event.at)}</td><td>${event.company}</td><td>${view.what}</td><td>${badge(view.result, view.tone)}</td></tr>`; })}</tbody></table></div>`
    : h`<p class="pg-settings__sub">${t('Nenhum limite ou bloqueio desde {date}.', { date: when(data.activitySince) })}</p>`;
  return h`<div class="pg-settings pg-settings--platform">${header}
    ${error ? banner({ tone: 'warning', title: t('Mostrando a última leitura'), body: error }) : ''}
    ${protection}
    <section class="pg-settings__grid" aria-labelledby="products-title"><h2 class="pg-settings__section-title" id="products-title">${t('Produtos')}</h2>${products}</section>
    <section class="pg-settings__section" aria-labelledby="events-title"><div class="pg-settings__section-head"><div><h2 class="pg-settings__section-title" id="events-title">${t('Eventos dos agentes')}</h2>
      <p class="pg-settings__sub">${t('Limites e bloqueios desde {date}. Respostas e avisos contam as últimas 24 h.', { date: when(data.activitySince) })}</p></div></div>${events}</section>
  </div>`;
}

export function createConnectedProductsUI({ request, getContext = () => ({}), onRender = () => {}, toast = () => {}, openChannels = async () => {}, wizardOptions = {} } = {}) {
  let data = null, loading = false, error = '', scope = '';
  const wizard = createProductConnectUI({ request, onRender, toast, openChannels, onClose: () => { void load(); }, ...wizardOptions });
  const key = () => JSON.stringify([getContext().workspaceId || '', getContext().supportGrantId || '']);
  async function load() {
    const current = key();
    if (current !== scope) { data = null; error = ''; scope = current; }
    loading = true; onRender();
    try { const result = await request('/api/platform/connected-products'); if (key() === current) { data = result; error = ''; } }
    catch (failure) { if (key() === current) error = failure?.message || t('Não foi possível carregar os produtos'); }
    finally { loading = false; onRender(); }
  }
  return {
    load,
    view: () => connectedProductsMarkup(data, { loading, error, wizard: wizard.active ? wizard.view() : '' }),
    async action(name, element) {
      if (name === 'product-connect-start') { if (data) wizard.start(data.products || []); return true; }
      if (name?.startsWith('product-connect-')) return wizard.act(name, element);
      if (name !== 'connected-products-refresh') return false;
      await load(); if (!error) toast(t('Produtos atualizados.')); return true;
    },
    submit: (element, data) => wizard.submit(element, data),
    get wizard() { return wizard; },
    reset() { if (wizard.active) wizard.close(); data = null; error = ''; scope = ''; }
  };
}
