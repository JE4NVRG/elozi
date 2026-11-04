import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import vm from 'node:vm';
import { t, setLocale, getLocale } from '../public/i18n.js';
import { managementTranslations } from '../public/locales-management.js';
import { channelJourneyTranslations } from '../public/locales-channel-journey.js';
import { agentJourneyTranslations } from '../public/locales-agent-journey.js';
import { platformUsersTranslations } from '../public/locales-platform-users.js';
// P8 copy of the settings, reseller and platform screens lives in its own catalog (FRONTEND-V2 §8.1).
import { settingsTranslations } from '../public/locales-settings.js';
import { telegramAccountTranslations } from '../public/locales-telegram-account.js';
import { supportCentralTranslations } from '../public/locales-support-central.js';
// Mirror explicit production catalog registration, including recovery modules.
const catalogTranslations = {};
const catalogContext = vm.createContext({ registerTranslations(dictionary) {
  for (const [source, target] of Object.entries(dictionary)) if (!Object.hasOwn(catalogTranslations, source)) catalogTranslations[source] = target;
} });
for (const file of (await readdir(new URL('../public/', import.meta.url))).filter(file => /^locales(?:-[\w-]+)?\.js$/.test(file)).sort()) {
  const source = await readFile(new URL('../public/' + file, import.meta.url), 'utf8');
  new vm.Script(source.replace(/^import[^\n]*\n/gm, '').replace(/\bexport (?=const|function)/g, '')).runInContext(catalogContext);
}
// Preserve the original owner-specific strict parity check. The global scanner
// additionally validates all modular dictionaries, including grammatical slots.
const administrativeTranslations={...managementTranslations,...channelJourneyTranslations,...agentJourneyTranslations,...platformUsersTranslations,...settingsTranslations,...telegramAccountTranslations,...supportCentralTranslations};
import { billingLabels, parseBillingCents, formatBillingMoney } from '../public/billing-ui.js';
import { permissionNames, presenceNames, clientRecordMarkup, contactOpenNotice } from '../public/workspace-ui.js';
import { createUnitsUI, unitRows } from '../public/units-ui.js';
import { createGuideMarkup } from '../public/guide-ui.js';
import { createAccountSecurityUI } from '../public/account-security-ui.js';
import { createServicePrincipalsUI } from '../public/service-principals-ui.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const inLocale = (context, locale) => { setLocale(locale, { persist: false, notify: false }); context.after(() => setLocale('pt-BR', { persist: false, notify: false })); };

test('administrative labels change on the same imports and keep permission and item codes', context => {
  inLocale(context, 'pt-BR');
  assert.equal(permissionNames['inbox.read'], 'Ver atendimentos');
  assert.equal(billingLabels.subscription, 'Mensalidade');
  setLocale('en', { persist: false, notify: false });
  assert.equal(permissionNames['inbox.read'], 'View conversations');
  assert.equal(presenceNames.away, 'Away');
  assert.equal(billingLabels.subscription, 'Subscription');
  assert.deepEqual(Object.keys(billingLabels), ['subscription', 'connections', 'users', 'agent_service', 'email']);
  setLocale('pt-BR', { persist: false, notify: false });
  assert.equal(permissionNames['inbox.read'], 'Ver atendimentos');
});

test('billing follows the current locale and preserves BRL, exact cents and submitted prices', context => {
  inLocale(context, 'pt-BR');
  const cents = Number.MAX_SAFE_INTEGER, pt = formatBillingMoney(cents);
  assert.match(pt, /R\$/);
  assert.match(pt, /,91$/);
  setLocale('en', { persist: false, notify: false });
  const en = formatBillingMoney(cents);
  assert.match(en, /R\$/);
  assert.match(en, /\.91$/);
  assert.notEqual(en, pt);
  assert.equal(parseBillingCents('49,90'), 4990);
  assert.equal(parseBillingCents('49.90'), 4990);
  assert.equal(formatBillingMoney(-1), 'Amount needs review');
});

test('CRM translates its controls while names, notes, tags and conversation IDs remain customer data', context => {
  inLocale(context, 'en');
  const contact = { id: 'customer-pt', name: 'Salvar contato', type: 'group', phone: '5511999999999', email: 'cliente@example.test', tags: ['Ativo', '<Rascunho>'], notes: 'Nome da empresa e notas em português.', archivedAt: null };
  const before = structuredClone(contact);
  const markup = clientRecordMarkup({ id: 'conversation-pt', contactId: contact.id }, { contacts: [contact], canRead: true, canWrite: true, canTransfer: true, escape, icon: () => '<svg></svg>' });
  assert.match(markup, /aria-label="Client record"/);
  assert.match(markup, />\s*Edit contact</);
  assert.match(markup, /data-id="customer-pt"/);
  assert.match(markup, /Salvar contato/);
  assert.match(markup, /Nome da empresa e notas em português\./);
  assert.match(markup, /&lt;Rascunho&gt;/);
  assert.match(markup, />Group</);
  assert.deepEqual(contact, before);
  assert.equal(contactOpenNotice({ status: 'open', assignedUserId: 'other', assignedUserName: 'Responsável português' }, { userId: 'me' }), 'Conversation opened in observation mode. Assigned to: Responsável português.');
});

test('unit rendering changes language without changing units, sorting inputs or persisted defaults', context => {
  inLocale(context, 'pt-BR');
  const units = [{ id: 'headquarters', name: 'Empresas', segment: 'Atendimento', channels: 2, conversations: 3 }, { id: 'branch', parentTenantId: 'headquarters', name: '<Filial>', segment: 'Nome', channels: 1, conversations: 0 }];
  const state = { workspaceId: 'workspace', supportGrantId: null, boot: { session: { userId: 'user' }, tenants: units } }, calls = [];
  const ui = createUnitsUI({ state, escape, icon: () => '<svg></svg>', formModal: (...arguments_) => calls.push(arguments_), api: () => assert.fail('render must not call the API'), render: () => {} });
  const before = structuredClone(state), pt = ui.markup();
  setLocale('en', { persist: false, notify: false });
  const en = ui.markup();
  assert.match(pt, /Empresas e filiais/);
  assert.match(en, /Companies and branches/);
  assert.match(en, />Empresas</);
  assert.match(en, /&lt;Filial&gt;/);
  assert.match(en, /3 open/);
  assert.deepEqual(state, before);
  assert.deepEqual(unitRows(units).map(unit => unit.id), ['headquarters', 'branch']);
  ui.action('new-tenant');
  assert.equal(calls[0][0], 'Add company or branch');
  assert.match(calls[0][3], /name="segment" required maxlength="80" value="Atendimento"/);
});

test('the same security component translates static fields and session labels without mutating session state', context => {
  inLocale(context, 'pt-BR');
  const state = { workspaceId: 'workspace', account: { user: { id: 'user' } }, securitySessions: [{ id: 'session', current: true, createdAt: '2026-10-01T12:00:00Z', expiresAt: '2026-10-02T12:00:00Z' }] };
  const snapshot = structuredClone(state), ui = createAccountSecurityUI({ state, escape, icon: () => '<svg></svg>' });
  assert.match(ui.markup(), /Segurança da conta/);
  setLocale('en', { persist: false, notify: false });
  const en = ui.markup();
  assert.match(en, /aria-label="Account security"/);
  assert.match(en, />Current session</);
  assert.match(en, /Current password<input class="pg-settings__input" type="password" name="currentPassword"/);
  assert.match(en, /Save new password/);
  assert.deepEqual(state, snapshot);
});

test('guide translates its explanations while capability names, API paths and tool names remain exact', context => {
  inLocale(context, 'en');
  const options = { session: { role: 'reseller', platformOwner: true, kind: 'human' }, accountKind: 'platform' };
  const en = createGuideMarkup(options);
  assert.match(en, /Principal administrator/);
  assert.match(en, /Service API v1 operations/);
  assert.match(en, /Read conversations across channels and companies/);
  for (const literal of ['/api/agent/mcp', 'ELOZI_MCP_CONFIG_PATH', 'conversation.read', 'elozi_search_all', 'elozi_read_context', '/conversations/{conversationId}']) assert.ok(en.includes(literal), literal);
  assert.doesNotMatch(en, /Quem administra o quê|Preparar o painel|Como conectar|Dúvidas frequentes/);
  const routes = markup => [...markup.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]);
  setLocale('pt-BR', { persist: false, notify: false });
  assert.deepEqual(routes(en), routes(createGuideMarkup(options)));
});

test('service principals translate scopes and errors at rendering time without touching service metadata', async context => {
  inLocale(context, 'pt-BR');
  const principal = { id: 'principal', name: 'Ler atendimentos', agentId: 'agent', capabilities: ['conversation.read'], channelIds: ['channel'], departmentIds: ['department'], state: 'active', active: true, revision: 2, keyRevision: 1, dailyRequests: 10, maxConcurrent: 1, expiresAt: '2027-01-01T00:00:00Z', usage: {} };
  const current = { workspaceId: 'workspace', tenantId: 'tenant', userId: 'admin', isAdmin: true, agents: [{ id: 'agent', name: 'Nome do serviço', provider: 'hermes' }], channels: [{ id: 'channel', name: 'Nome do canal' }], departments: [{ id: 'department', name: 'Nome do departamento' }] };
  let failure = false;
  const ui = createServicePrincipalsUI({ getContext: () => current, request: async () => { if (failure) throw new Error('Não foi possível confirmar a lista de serviços.'); return { principals: [principal] }; }, getModal: () => null });
  const before = structuredClone({ current, principal });
  await ui.load();
  setLocale('en', { persist: false, notify: false });
  const en = ui.markup();
  assert.match(en, /Company access/);
  assert.match(en, /Read conversations/);
  assert.match(en, /Ler atendimentos/);
  assert.match(en, /Nome do canal/);
  assert.match(en, /Nome do departamento/);
  assert.deepEqual({ current, principal }, before);
  setLocale('pt-BR', { persist: false, notify: false }); failure = true; await ui.load({ force: true });
  setLocale('en', { persist: false, notify: false });
  assert.match(ui.markup(), /Unable to confirm the service list\./);
});

test('static administrative template coverage and placeholder parity are enforced independently', async context => {
  inLocale(context, 'en');
  const acornModule = { exports: {} };
  new Function('exports', 'module', process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'])(acornModule.exports, acornModule);
  const { parse } = acornModule.exports, files = ['accounts-ui', 'account-invitations-ui', 'account-security-ui', 'billing-ui', 'plans-ui', 'commercial-usage-ui', 'workspace-ui', 'workspace-domains-ui', 'units-ui', 'platform-users-ui', 'integrations-ui', 'support-ui', 'service-principals-ui', 'service-handoffs-ui', 'guide-ui'];
  const pattern = template => template.quasis.reduce((result, quasi, index) => result + (index ? `{${index - 1}}` : '') + quasi.value.cooked, '');
  const markupKeys = source => source.split(/(<[^>]*>)/g).flatMap(part => part.startsWith('<') ? [...part.matchAll(/\b(?:aria-label|title|placeholder|alt|label|data-nav-label)=("|')([\s\S]*?)\1/g)].map(match => match[2].trim()) : [part.trim()]);
  const walk = (node, visit) => { if (!node || typeof node !== 'object') return; if (node.type) visit(node); for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(value => walk(value, visit)); else if (child?.type) walk(child, visit); };
  const missing = [];
  for (const file of files) {
    const source = await readFile(new URL(`../public/${file}.js`, import.meta.url), 'utf8');
    walk(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }), node => {
      let keys = [];
      if (node.type === 'TaggedTemplateExpression' && ['i18nHtml', 'i18nTxt'].includes(node.tag?.name)) keys = node.tag.name === 'i18nHtml' ? markupKeys(pattern(node.quasi)) : [pattern(node.quasi)];
      if (node.type === 'CallExpression' && ['i18nT', 'i18nMarkup'].includes(node.callee?.name) && node.arguments[0]?.type === 'Literal') keys = node.callee.name === 'i18nMarkup' ? markupKeys(node.arguments[0].value) : [node.arguments[0].value];
      if (node.type === 'CallExpression' && node.callee?.name === 'i18nLabels' && node.arguments[0]?.type === 'ObjectExpression') keys.push(...node.arguments[0].properties.flatMap(property => typeof property.value?.value === 'string' ? [property.value.value] : []));
      for (const key of keys) if (/[A-Za-zÀ-ÿ]/.test(key.replace(/\{\d+\}/g, '')) && !Object.hasOwn(catalogTranslations, key)) missing.push(`${file}: ${key}`);
    });
  }
  assert.deepEqual(missing, []);
  const slots = value => [...value.matchAll(/\{\d+\}/g)].map(match => match[0]).sort();
  for (const [source, target] of Object.entries(administrativeTranslations)) assert.deepEqual(slots(target), slots(source), source);
  assert.equal(getLocale(), 'en');
  assert.equal(t('· revisão {6}', { 6: 'immutable-id' }), '· revision immutable-id');
});
