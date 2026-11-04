import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerContext, customerContextMarkup, createCustomerContextUI } from '../public/customer-context-ui.js';
import { setLocale } from '../public/i18n.js';

test.afterEach(() => setLocale('pt-BR', { persist: false, notify: false }));
function fixture() {
  const current = { id: 'conversation-a', contactId: 'contact-explicit', channelId: 'channel-a', version: 3, contact: 'Nome manual <Suporte>', phone: '+5511000000000', conversationKind: 'direct', status: 'open', owner: 'human', assignedUserId: 'person-a', assignedUserName: 'Pessoa manual', agentId: 'agent-a', messages: [
    { kind: 'customer', text: 'Public customer text is not a summary instruction' },
    { kind: 'internal', text: 'Private note <do not send>', authorName: 'Autor manual', createdAt: '2026-10-05T12:00:00Z' },
    { kind: 'draft', text: 'Unsent draft must not appear' }
  ] };
  const context = { active: true, selecting: false, busy: false, workspaceId: 'workspace-a', tenantId: 'tenant-a', tenantName: 'Empresa manual', userId: 'user-a', authorityKey: 'synthetic-private-session-key', canReadInbox: true, canReadContacts: true,
    conversation: current, conversations: [current, { id: 'conversation-b', contactId: current.contactId, channelId: 'channel-b', version: 7, contact: current.contact, status: 'pending', owner: 'queue' }, { id: 'lookalike', channelId: 'channel-b', version: 1, contact: current.contact, phone: current.phone, status: 'pending', owner: 'human', messages: [{ kind: 'internal', text: 'Unlinked private note' }] }],
    channels: [{ id: 'channel-a', name: 'Nome do WhatsApp', kind: 'whatsapp_qr' }, { id: 'channel-b', name: 'Nome do Telegram', kind: 'telegram' }],
    contacts: [{ id: current.contactId, name: 'Cliente manual <Cadastro>', type: 'person', notes: 'Contact private note', tags: ['Tag manual · Suporte'] }], assignees: [{ id: 'person-a', name: 'Pessoa manual' }], agents: [{ id: 'agent-a', name: 'Agente manual' }],
    capabilities: { takeover: true, transfer: true, participants: true, handoffs: true, prepareDraft: true } };
  return { context, current };
}
const actionElement = (markup, action, id = 'conversation-a') => {
  const match = markup.match(new RegExp('data-customer-context-action="' + action + '" data-customer-context-token="([^"]+)"'));
  assert.ok(match, 'Expected a real rendered action ' + action);
  return { dataset: { customerContextAction: action, customerContextToken: match[1], conversationId: id }, disabled: false };
};

test('only explicit contact IDs link authorized conversations, never matching names or phone numbers', () => {
  const { context } = fixture(), before = JSON.stringify(context), model = buildCustomerContext(context);
  assert.deepEqual(model.rows.map(row => row.id), ['conversation-a', 'conversation-b']); assert.equal(model.pendingCount, 1);
  assert.equal(model.rows[0].publicMessageCount, 1); assert.equal(model.loadedNoteCount, 1); assert.equal(model.notesCoverageKnown, false);
  assert.equal(JSON.stringify(context), before); assert.doesNotMatch(customerContextMarkup(model), /Unlinked private note|Unsent draft|Public customer text/);
});
test('unlinked conversation never picks a matching or empty-ID contact', () => {
  const { context, current } = fixture(); delete current.contactId; context.contacts.push({ id: '', name: 'Malformed contact', notes: 'must stay hidden', type: 'person' });
  const model = buildCustomerContext(context); assert.equal(model.linked, false); assert.equal(model.contactAvailable, false); assert.equal(model.contactNotes, ''); assert.equal(model.rows.length, 1);
  assert.doesNotMatch(customerContextMarkup(model), /Contact private note|must stay hidden|Malformed contact/);
});
test('foreign company/workspace/channel records, duplicate IDs and person/group mixing are withheld', () => {
  const { context, current } = fixture();
  for (const extra of [{ id: 'foreign-tenant', tenantId: 'tenant-b', channelId: 'channel-b' }, { id: 'foreign-workspace', workspaceId: 'workspace-b', channelId: 'channel-b' }, { id: 'foreign-channel', channelId: 'channel-unavailable' }, { id: 'group-record', channelId: 'channel-b', conversationKind: 'group' }, { id: 'duplicate', channelId: 'channel-b' }, { id: 'duplicate', channelId: 'channel-b' }]) context.conversations.push({ ...extra, contactId: current.contactId, version: 1, messages: [{ kind: 'internal', text: 'forbidden-note-' + extra.id }] });
  const model = buildCustomerContext(context); assert.deepEqual(model.rows.map(row => row.id), ['conversation-a', 'conversation-b']); assert.doesNotMatch(customerContextMarkup(model), /forbidden-note/);
});
test('missing history and unchecked handoffs are unavailable, rather than zero', () => {
  const { context, current } = fixture(); delete current.messages; delete context.conversations;
  const model = buildCustomerContext(context), markup = customerContextMarkup(model);
  assert.equal(model.rows[0].publicMessageCount, null); assert.equal(model.handoffsLoaded, false); assert.equal(model.notesCoverageKnown, false);
  assert.match(markup, /Histórico não carregado/); assert.match(markup, /Pedidos dos agentes ainda não consultados/); assert.match(markup, /Contact private note/); assert.match(markup, /Parte dos históricos não está carregada/); assert.doesNotMatch(markup, /0 mensagens carregadas|0 pedidos de apoio/);
  context.contacts = null; const unavailable = customerContextMarkup(buildCustomerContext(context)); assert.match(unavailable, /Notas indisponíveis/); assert.doesNotMatch(unavailable, /Contact private note|Nenhuma nota interna nos históricos carregados/);
});
test('contact metadata requires contacts.read, while explicit loaded conversation links remain visible', () => {
  const { context } = fixture(); context.canReadContacts = false; const model = buildCustomerContext(context), markup = customerContextMarkup(model);
  assert.equal(model.rows.length, 2); assert.equal(model.contactNotes, ''); assert.deepEqual(model.contactTags, []); assert.match(markup, /cadastro completo não está disponível/); assert.doesNotMatch(markup, /Contact private note|Tag manual|Cliente manual/);
});
test('scoped handoffs count only the loaded requests of the current conversation', () => {
  const { context } = fixture(); context.handoffs = [{ id: 'request-a', conversationId: 'conversation-a', state: 'pending' }, { id: 'request-b', conversationId: 'conversation-b', state: 'pending' }, { id: 'request-c', conversationId: 'conversation-a', tenantId: 'tenant-b', state: 'pending' }, { id: 'request-d', conversationId: 'conversation-a', state: 'acknowledged' }];
  const model = buildCustomerContext(context); assert.equal(model.handoffsLoaded, true); assert.equal(model.pendingHandoffCount, 1);
});
test('ownership and collaboration permissions are distinct, and closed conversations have no mutation actions', () => {
  const { context, current } = fixture(); current.owner = 'agent'; context.capabilities = { handoffs: true };
  let markup = customerContextMarkup(buildCustomerContext(context)); assert.match(markup, /Agente responsável/); assert.match(markup, /Agente manual/); assert.doesNotMatch(markup, /data-customer-context-action="transfer"|data-customer-context-action="prepareDraft"/);
  current.status = 'closed'; context.capabilities = { takeover: true, transfer: true, participants: true, handoffs: true, prepareDraft: true };
  markup = customerContextMarkup(buildCustomerContext(context)); assert.match(markup, /data-customer-context-action="handoffs"/); assert.doesNotMatch(markup, /data-customer-context-action="takeover"|data-customer-context-action="transfer"|data-customer-context-action="participants"|data-customer-context-action="prepareDraft"/);
});
test('incomplete identity, denied inbox scope, loading and expired support all fail closed', () => {
  for (const patch of [{ active: false }, { selecting: true }, { canReadInbox: false }, { userId: '' }, { authorityKey: '' }, { channels: [] }, { supportGrantId: 'support-a', supportExpiresAt: 'invalid' }, { supportGrantId: 'support-a', supportExpiresAt: '2026-01-01T00:00:00Z' }]) assert.equal(buildCustomerContext({ ...fixture().context, ...patch }, { now: Date.parse('2026-10-05T12:00:00Z') }), null);
});
for (const language of ['pt-BR', 'en']) test('static UI changes language while manual data and escaped internal notes remain unchanged in ' + language, () => {
  setLocale(language, { persist: false, notify: false }); const { context } = fixture(), markup = customerContextMarkup(buildCustomerContext(context));
  assert.match(markup, /Cliente manual &lt;Cadastro&gt;/); assert.match(markup, /Private note &lt;do not send&gt;/); assert.match(markup, /Contact private note/); assert.match(markup, /Tag manual · Suporte/);
  assert.doesNotMatch(markup, /synthetic-private-session-key/);
  assert.match(markup, language === 'en' ? /CUSTOMER CONTEXT/ : /CONTEXTO DO CLIENTE/);
  assert.match(markup, language === 'en' ? /Transfer with context/ : /Transferir com contexto/);
  assert.match(markup, language === 'en' ? /History not loaded/ : /Histórico não carregado/);
  assert.match(markup, language === 'en' ? /Explicit contact link/ : /Vínculo explícito do cadastro/);
  assert.match(markup, language === 'en' ? /1 loaded messages/ : /1 mensagens carregadas/);
  if (language === 'en') assert.doesNotMatch(markup, /Resumo dos|Pessoa responsável|Anotações do cadastro|Equipe e agente|Notas internas carregadas|Atendimentos e canais vinculados/);
});
test('dispatch sends only existing handler names and scoped IDs/version, with no summary or note payload', async () => {
  const { context } = fixture(), opens = [], calls = [], updates = [];
  const ui = createCustomerContextUI({ getContext: () => context, onOpenConversation: value => opens.push(value), onAction: (...args) => calls.push(args), onUpdate: () => updates.push(true) });
  for (const [action, handler] of Object.entries({ takeover: 'takeover', transfer: 'transfer-conversation', participants: 'conversation-participants', handoffs: 'service-handoffs', prepareDraft: 'run-agent' })) {
    const markup = ui.markup(); await ui.handleAction(actionElement(markup, action)); const [name, payload] = calls.at(-1);
    assert.equal(name, handler); assert.deepEqual(payload, { workspaceId: 'workspace-a', tenantId: 'tenant-a', conversationId: 'conversation-a', version: 3 });
  }
  await ui.handleAction(actionElement(ui.markup(), 'open', 'conversation-b')); assert.deepEqual(opens, [{ workspaceId: 'workspace-a', tenantId: 'tenant-a', conversationId: 'conversation-b' }]);
  assert.equal(updates.length, 6); assert.doesNotMatch(JSON.stringify([calls, opens]), /Private note|Contact private note|authority|session-key|draft/i);
});
test('render tokens, scope/version changes, channel revocation and live capabilities prevent stale dispatch', async () => {
  for (const change of [c => { c.tenantId = 'tenant-b'; }, c => { c.authorityKey = 'other-authority'; }, c => { c.conversation.version++; }, c => { c.channels = [c.channels[0]]; }, c => { c.capabilities.transfer = false; }]) {
    const { context } = fixture(), calls = [], ui = createCustomerContextUI({ getContext: () => context, onAction: (...args) => calls.push(args), onOpenConversation: value => calls.push(value) });
    const action = change.toString().includes('channels') ? 'open' : 'transfer', button = actionElement(ui.markup(), action, action === 'open' ? 'conversation-b' : 'conversation-a'); change(context);
    await assert.rejects(ui.handleAction(button), error => error.code === 'customer-context-stale'); assert.deepEqual(calls, []);
  }
  const { context } = fixture(), ui = createCustomerContextUI({ getContext: () => context }), old = actionElement(ui.markup(), 'transfer'); ui.markup(); await assert.rejects(ui.handleAction(old), /contexto do cliente mudou/);
  const latest = actionElement(ui.markup(), 'transfer'); ui.reset(); await assert.rejects(ui.handleAction(latest), /contexto do cliente mudou/);
});
test('pending operations dispatch once and uncertain errors never trigger an automatic replay', async () => {
  const { context } = fixture(), calls = []; let reject;
  const response = new Promise((resolve, failure) => { reject = failure; });
  const ui = createCustomerContextUI({ getContext: () => context, onAction: (...args) => { calls.push(args); return response; } }), button = actionElement(ui.markup(), 'transfer');
  const first = ui.handleAction(button); assert.equal(ui.busy, true); assert.equal(await ui.handleAction(button), true); assert.equal(calls.length, 1);
  reject(new Error('Synthetic uncertain result')); await assert.rejects(first, /uncertain result/); assert.equal(ui.busy, false); assert.equal(calls.length, 1);
});
