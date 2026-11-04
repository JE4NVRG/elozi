import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { channelJourney, channelJourneyTotals, CHANNEL_JOURNEY_IDS } from '../public/channel-journey.js';
import { createIntegrationsUI } from '../public/integrations-ui.js';
import { setLocale } from '../public/i18n.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const channels = () => [
  { id: 'wa', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected', name: 'Salvar <WhatsApp>', enabledGroups: 2 },
  { id: 'tg', kind: 'telegram', transport: 'telegram-bot', state: 'connected', name: 'Equipe Telegram', selectedGroups: 3 },
  { id: 'site', kind: 'webchat', transport: 'elozi-webchat', state: 'connected', name: 'Minha conta', webchat: { enabled: true } },
  { id: 'ig', kind: 'instagram', transport: 'meta-instagram', state: 'configured', name: 'Instagram da loja', meta: { enabled: true, accessToken: 'PRIVATE-ACCESS', appSecret: 'PRIVATE-APP', verifyToken: 'PRIVATE-VERIFY' } },
  { id: 'fb', kind: 'messenger', transport: 'meta-messenger', state: 'error', name: 'Página da loja', meta: { enabled: true } },
  { id: 'mail', kind: 'email', transport: 'mepmail-channel', state: 'configured', name: 'Caixa do suporte', email: { enabled: true, ingressSecret: 'PRIVATE-RELAY' } }
];
// P8 (§8.9): the catalog is the Integrações tab of Plataforma, drawn for the platform owner (route guard
// integrations: owner); the per-company configuration actions still require a workspace admin outside support.
function fixture({ role = 'reseller', support = false } = {}) {
  const state = { boot: { session: { role, platformOwner: role === 'reseller', userId: 'human', resellerId: 'workspace', supportGrantId: support ? 'support-1' : null }, tenants: [{ id: 'other', channels: [{ name: 'OTHER-COMPANY-CHANNEL' }] }] }, tenant: { id: 'selected', name: 'Minha conta <empresa>', channels: channels(), agents: [] }, integrationSearch: 'Minha conta' };
  const modals = [], calls = [];
  const ui = createIntegrationsUI({ state, escape, icon: id => `<span class="icon" data-icon="${escape(id)}"></span>`, badge: (text, tone = '') => `<span class="badge ${escape(tone)}">${escape(text)}</span>`,
    button: (text, action, classes = '') => `<button type="button" class="button ${escape(classes)}" data-action="${escape(action)}">${escape(text)}</button>`,
    pageHeading: (eyebrow, title, subtitle, action) => `<header><span>${escape(eyebrow)}</span><h1>${escape(title)}</h1><p>${escape(subtitle)}</p>${action}</header>`,
    openModal: (title, subtitle, content) => modals.push({ title, subtitle, content }), api: (...args) => calls.push(args) });
  return { state, ui, modals, calls };
}
afterEach(() => { setLocale('pt-BR', { persist: false, notify: false }); delete globalThis.document; });

test('seven channel kinds expose steps without claiming Meta or email delivery is validated', () => {
  assert.deepEqual(CHANNEL_JOURNEY_IDS, ['whatsapp', 'telegram_user', 'telegram', 'webchat', 'instagram', 'messenger', 'email']);
  const input = channels(), before = JSON.stringify(input), ig = channelJourney('instagram', input), email = channelJourney('email', input);
  assert.equal(ig.text, 'Configurado · validar'); assert.equal(ig.tone, 'blue'); assert.equal(ig.counts.connected, 0); assert.equal(ig.counts.configured, 1);
  assert.equal(ig.currentStep, 3); assert.equal(ig.steps[2].saved, false); assert.match(ig.steps[2].detail, /permissões e webhook/);
  assert.equal(email.counts.connected, 0); assert.match(email.steps[2].detail, /não conecta uma caixa IMAP/);
  assert.equal(channelJourney('webchat', []).currentStep, 1); assert.equal(channelJourney('telegram', [{ id: 'bot', kind: 'telegram', transport: 'telegram-bot', state: 'qr' }]).currentStep, 2);
  assert.equal(JSON.stringify(input), before); assert.equal(channelJourney('__proto__', input), null);
});

test('connection totals use the selected company and actual adapter states across all six transports', () => {
  const input = [...channels(), { id: 'cloud', kind: 'whatsapp_cloud', transport: 'future', state: 'connected' }];
  assert.deepEqual(channelJourneyTotals(input), { total: 6, connected: 3, configured: 2, attention: 1 });
  assert.equal(channelJourney('whatsapp', [{ id: 'demo', kind: 'whatsapp_qr', transport: 'sandbox', state: 'connected' }]).counts.connected, 0);
  assert.equal(channelJourney('instagram', [{ id: 'bad', kind: 'instagram', state: 'unknown-provider-state' }]).instances[0].state, 'disconnected');
});

test('the journey projects only bounded display fields and never returns secrets, messages or private metadata', () => {
  const input = channels(); input.push({ id: 'x'.repeat(121), kind: 'instagram', state: 'connected' });
  const result = channelJourney('instagram', input), serialized = JSON.stringify(result);
  assert.equal(result.instances.length, 1); assert.equal(result.instances[0].id, 'ig');
  assert.deepEqual(Object.keys(result.instances[0]), ['id', 'name', 'label', 'state', 'native', 'enabledGroups', 'selectedGroups']);
  for (const secret of ['PRIVATE-ACCESS', 'PRIVATE-APP', 'PRIVATE-VERIFY', 'PRIVATE-RELAY']) assert(!serialized.includes(secret));
  const malformed = channelJourney('telegram', [{ id: 'bot', kind: 'telegram', name: {}, label: ['provider secret'], enabledGroups: -1, selectedGroups: 'ALL' }]);
  assert.equal(malformed.instances[0].name, 'Conexão sem nome'); assert.equal(malformed.instances[0].label, ''); assert.equal(malformed.instances[0].enabledGroups, 0);
});

test('disabled or incompatible configurations do not reuse stale connected badges and email remains a relay', () => {
  const input = channels();
  for (const channel of input.filter(channel => ['site', 'ig', 'fb', 'mail'].includes(channel.id))) {
    channel.state = 'connected';
    (channel.webchat || channel.meta || channel.email).enabled = false;
  }
  for (const id of ['webchat', 'instagram', 'messenger', 'email']) {
    const journey = channelJourney(id, input);
    assert.equal(journey.instances[0].state, 'disconnected');
    assert.equal(journey.counts.connected, 0); assert.equal(journey.counts.configured, 0);
    assert.equal(journey.currentStep, 2);
  }
  assert.equal(channelJourney('whatsapp', [{ id: 'legacy', kind: 'whatsapp_qr', transport: 'sandbox', state: 'connected' }]).instances[0].state, 'disconnected');
  assert.equal(channelJourney('webchat', [{ id: 'missing', kind: 'webchat', transport: 'elozi-webchat', state: 'connected' }]).counts.connected, 0);
  const email = channelJourney('email', [{ id: 'relay', kind: 'email', transport: 'mepmail-channel', state: 'connected', email: { enabled: true } }]);
  assert.equal(email.instances[0].state, 'configured'); assert.equal(email.counts.connected, 0); assert.equal(email.counts.configured, 1);
  const { state, ui } = fixture(); state.tenant.channels = input; const markup = ui.view();
  assert(markup.includes('<span class="pg-settings__item-main"><strong class="pg-settings__strong">Minha conta</strong>'), 'a conexão desativada continua listada');
  assert(!markup.includes('<span class="pg-settings__dot" data-tone="success" aria-hidden="true"></span><span class="pg-settings__item-main"><strong class="pg-settings__strong">Minha conta</strong>'));
});

test('integration cards route seven channels and external agents to existing actions without making any request', () => {
  const { state, ui, calls } = fixture(), before = JSON.stringify(state.tenant), markup = ui.view();
  assert.equal((markup.match(/data-integration-category="channels"/g) || []).length, 7);
  for (const id of ['site', 'ig', 'fb', 'mail']) assert(markup.includes(`data-action="configure-channel" data-id="${id}"`));
  assert(markup.includes('data-action="connect-channel" data-id="wa"')); assert(markup.includes('data-action="connect-telegram" data-id="tg"'));
  assert(markup.includes('data-action="telegram-groups" data-id="tg"')); assert(markup.includes('data-action="channel-groups" data-id="wa"'));
  assert.equal((markup.match(/data-view="service-agents"/g) || []).length, 2);
  assert(!markup.includes('OTHER-COMPANY-CHANNEL')); assert(!markup.includes('PRIVATE-')); assert(!markup.includes('estão no mapa do produto'));
  assert.equal(JSON.stringify(state.tenant), before); assert.equal(state.integrationSearch, 'Minha conta'); assert.deepEqual(calls, []);
});

test('operators and temporary support can inspect steps without being offered channel configuration', () => {
  for (const options of [{ role: 'operator' }, { support: true }]) {
    const { ui, modals } = fixture(options), markup = ui.view();
    assert(!markup.includes('data-action="configure-channel"')); assert(!markup.includes('data-action="new-channel"'));
    assert(!markup.includes('data-view="service-agents"')); assert(ui.act('integration-info', 'instagram'));
    assert.match(modals.at(-1).content, /Configuração pelo administrador da empresa/); assert(!modals.at(-1).content.includes('data-action="configure-channel"'));
  }
});

test('PT and EN render current step copy while preserving names, input values and escaped channel identities', () => {
  const { ui, state, modals, calls } = fixture(); ui.view();
  setLocale('en', { persist: false, notify: false });
  const english = ui.view(); assert.match(english, /Platform integrations/); assert.match(english, /Minha conta &lt;empresa&gt; catalog/); assert.match(english, /Support email/); assert.match(english, /Configured · validate/);
  assert(english.includes('Salvar &lt;WhatsApp&gt;')); assert(english.includes('Minha conta &lt;empresa&gt;')); assert(english.includes('value="Minha conta"'));
  assert(ui.act('integration-info', 'instagram')); assert.match(modals.at(-1).content, /Validate the account, permissions and webhook/); assert.match(modals.at(-1).content, /aria-current="step"/); assert.equal(modals.at(-1).subtitle, state.tenant.name);
  assert(!modals.at(-1).content.includes('data-view=')); // Modal navigation is handled by existing channel actions and Close.
  assert(ui.act('integration-info', 'claude')); assert.match(modals.at(-1).content, /external Claude agent/); assert.match(modals.at(-1).content, /does not start a session/);
  setLocale('pt-BR', { persist: false, notify: false }); assert(ui.act('integration-info', 'codex')); assert.match(modals.at(-1).content, /não inicia uma sessão/);
  assert.equal(state.integrationSearch, 'Minha conta'); assert.deepEqual(calls, []);
});

test('search and category filters preserve the typed value and use the displayed integration catalog', () => {
  const { ui, state } = fixture(), markup = ui.view(), cards = [...markup.matchAll(/data-integration-category="([^"]*)" data-integration-keywords="([^"]*)"/g)].map(match => ({ dataset: { integrationCategory: match[1], integrationKeywords: match[2] }, hidden: false }));
  const results = { textContent: '' }, empty = { hidden: true }, filters = ['all', 'channels', 'access', 'agents'].map(id => ({ dataset: { id }, classList: { toggle() {} }, setAttribute() {} }));
  const input = { dataset: {}, value: 'Página', addEventListener(event, listener) { this.listener = listener; } };
  const container = { querySelectorAll: selector => selector === '[data-integration-card]' ? cards : filters, querySelector: selector => selector.includes('no-results') ? empty : results };
  globalThis.document = { querySelector: selector => selector === '#integration-catalog' ? container : selector === '[data-integration-search]' ? input : null };
  ui.bind(); input.listener(); assert.equal(state.integrationSearch, 'Página'); assert.equal(input.value, 'Página'); assert.equal(cards.filter(card => !card.hidden).length, 1);
  ui.act('integration-filter', 'agents'); assert.equal(cards.filter(card => !card.hidden).length, 0); assert.equal(empty.hidden, false);
  ui.act('integration-filter', 'all'); assert.equal(cards.filter(card => !card.hidden).length, 1); assert.equal(input.value, 'Página');
});
