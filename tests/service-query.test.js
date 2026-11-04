import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Outbox } from '../src/outbox.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';

const status = expected => error => error.status === expected;
const HISTORY_BYTES = 24576, SEARCH_BYTES = 65536;
function fixture(t, { dailyRequests = 100 } = {}) {
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, tenantId) => store.tenant(actor, tenantId) }); new Outbox(store);
  const admin = auth.actor(auth.insertUser({ username: 'query.synthetic.owner', name: 'Admin sintético' }, Buffer.alloc(16, 6), Buffer.alloc(64, 6), 'reseller', [], 'mep-demo'));
  const tenant = store.createTenant(admin, { name: 'Consulta sintética', segment: 'QA' }), otherTenant = store.createTenant(admin, { name: 'Outra empresa sintética', segment: 'QA' });
  let clock = Date.parse('2026-10-05T12:00:00Z'), providerCalls = 0, groupChecks = 0, sequence = 0;
  const message = (id, text, extra = {}) => ({ id, kind: 'customer', text, createdAt: '2026-10-04T12:00:00Z', ...extra });
  const conversation = (id, channelId, extra = {}) => ({ id, channelId, departmentId: 'support', contact: 'Cliente Ágata', status: 'open', version: 1, owner: 'human', assignedUserId: admin.userId, unread: 2, updatedAt: '2026-10-04T12:00:00Z', messages: [message(id + '-message', 'Café aprovação comprovante público')], ...extra });
  store.mutate(admin, tenant.id, 'Fixture consulta isolada', state => {
    state.agents = [{ id: 'external', name: 'Agente de consulta sintético', provider: 'mcp', mode: 'copilot', configured: true, version: 1 }];
    state.channels = [
      { id: 'wa', kind: 'whatsapp_qr', transport: 'baileys', allowedGroups: ['123-456@g.us'], enabled: true },
      { id: 'tg', kind: 'telegram', transport: 'telegram-bot', telegramGroups: { mode: 'selected', groupIds: ['-123'] }, enabled: true },
      { id: 'web', kind: 'webchat', transport: 'elozi-webchat' }, { id: 'ig', kind: 'instagram', transport: 'meta-instagram' },
      { id: 'messenger', kind: 'messenger', transport: 'meta-messenger' }, { id: 'other', kind: 'telegram', transport: 'telegram-bot' }
    ];
    state.departments = [{ id: 'support', name: 'Suporte', active: true }, { id: 'sales', name: 'Vendas', active: true }];
    state.contacts = [{ id: 'linked', name: 'Privado em outro canal', phone: '551188887777', email: 'secret-other@example.invalid', tags: ['hidden-contact-tag'], identities: [{ channelId: 'wa', kind: 'person', externalId: '551188887777@s.whatsapp.net' }, { channelId: 'web', kind: 'person', externalId: 'outside-web-peer' }] }];
    state.conversations = [
      conversation('wa-direct', 'wa', { remoteJid: '551199998888@s.whatsapp.net', tags: ['Renovação'] }),
      conversation('tg-direct', 'tg', { remoteChatId: '1234', status: 'pending' }),
      conversation('web-direct', 'web', { contactId: 'linked', remoteSessionId: 'visitor-session', status: 'closed' }),
      conversation('ig-direct', 'ig', { remoteSenderId: 'instagram-client' }), conversation('messenger-direct', 'messenger', { remoteUserId: 'messenger-client' }),
      conversation('wa-group', 'wa', { conversationKind: 'group', remoteJid: '123-456@g.us', contact: 'Grupo João' }),
      conversation('tg-group', 'tg', { conversationKind: 'group', remoteChatId: '-123', contact: 'Grupo Telegram' }),
      conversation('unselected-wa', 'wa', { conversationKind: 'group', remoteJid: '987@g.us', contact: 'Oculto grupo WhatsApp', messages: [message('hidden-wa', 'oculto proibido')] }),
      conversation('unselected-tg', 'tg', { conversationKind: 'group', remoteChatId: '-999', contact: 'Oculto grupo Telegram', messages: [message('hidden-tg', 'oculto proibido')] }),
      conversation('outside-channel', 'other', { contact: 'Oculto canal', messages: [message('hidden-channel', 'oculto proibido')] }),
      conversation('outside-department', 'wa', { contact: 'Oculto departamento', departmentId: 'sales', messages: [message('hidden-dept', 'oculto proibido')] })
    ];
    state.conversations[0].messages.push(message('public-human', 'Resposta pública humana https://public.example/suporte', { kind: 'human' }), message('public-agent', 'Resposta pública agente'), message('private-note', 'nota-sensivel-secreta', { kind: 'internal' }), message('private-system', 'evento-sensivel-secreto', { kind: 'system' }), message('unknown-kind', 'texto-kind-nao-publico', { kind: 'text' }));
    state.conversations[0].messages[0].attachments = [{ id: 'attachment-safe', kind: 'image', name: 'imagem.png', mime: 'image/png', size: 4, url: 'https://private-media.invalid/item', privateKey: 'private-media-key', bytes: 'private-media-bytes' }];
  });
  store.mutate(admin, otherTenant.id, 'Fixture empresa excluída', state => { state.conversations = [conversation('another-company', 'wa', { contact: 'Oculto empresa', messages: [message('hidden-company', 'oculto proibido')] })]; });
  const principals = new ServicePrincipals(store, auth, { now: () => clock }), runtime = { start() { providerCalls++; assert.fail('Consulta não chama IA'); } };
  const api = new ServiceApi(store, principals, runtime, { assertGroup() { groupChecks++; return true; }, sendGroup() { assert.fail('Consulta não envia mensagem'); }, scheduleGroup() { assert.fail('Consulta não agenda mensagem'); } });
  const create = extra => principals.create(admin, tenant.id, { name: 'Consulta externa QA', agentId: 'external', capabilities: ['conversation.read'], channelIds: ['wa', 'tg', 'web', 'ig', 'messenger'], departmentIds: ['support'], dailyRequests, dailyBudgetMicros: 0, estimatedRequestMicros: 0, maxConcurrent: 2, ttlHours: 24, ...extra });
  const created = create(), actor = principals.authenticate('Bearer ' + created.token), initial = JSON.stringify(store.tenant(admin, tenant.id));
  t.after(() => store.close());
  return { store, auth, admin, tenant, otherTenant, principals, api, created, actor, create, message, conversation,
    request: extra => ({ requestId: `synthetic_query_${++sequence}`, ...extra }), current: () => store.tenant(admin, tenant.id),
    usage: () => principals.list(admin, tenant.id).principals.find(item => item.id === created.principal.id).usage,
    advance: duration => { clock += duration; }, groupsChecked: () => groupChecks,
    assertReadOnly() { assert.equal(providerCalls, 0); assert.equal(store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n, 0); assert.equal(JSON.stringify(store.tenant(admin, tenant.id)), initial); }
  };
}

test('busca registrada AND sem acentos contempla todos canais autorizados e grupos selecionados', t => {
  const f = fixture(t), input = f.request({ query: 'CAFE aprovacao', limit: 50 }), result = f.api.searchConversations(f.actor, input);
  assert.deepEqual(result.conversations.map(item => item.conversationId).sort(), ['ig-direct', 'messenger-direct', 'tg-direct', 'tg-group', 'wa-direct', 'wa-group', 'web-direct']);
  assert.equal(result.coverage.includedCount, 7); assert.equal(result.nextCursor, null); assert.ok(f.groupsChecked() >= 4);
  assert.ok(result.conversations.every(item => item.snippets.length <= 3 && item.snippets.every(value => value.text.length <= 160)));
  assert.equal(f.api.searchConversations(f.actor, input).receipt, result.receipt); assert.equal(f.usage().requests, 1); assert.equal(f.usage().budgetMicros, 0);
  assert.equal(f.api.searchConversations(f.actor, f.request({ query: 'cafe termo-inexistente' })).conversations.length, 0); f.assertReadOnly();
});

test('busca por nome, telefone próprio e metadados não encontra contato/identidade de outro escopo', t => {
  const f = fixture(t);
  assert.equal(f.api.searchConversations(f.actor, f.request({ query: 'agata' })).conversations.length, 5);
  assert.deepEqual(f.api.searchConversations(f.actor, f.request({ query: '551199998888' })).conversations.map(item => item.conversationId), ['wa-direct']);
  assert.deepEqual(f.api.searchConversations(f.actor, f.request({ query: 'renovacao' })).conversations.map(item => item.conversationId), ['wa-direct']);
  for (const query of ['oculto', '551188887777', 'secret-other', 'hidden-contact-tag', 'outside-web-peer', 'privado em outro canal']) {
    const result = f.api.searchConversations(f.actor, f.request({ query })); assert.equal(result.conversations.length, 0, query); assert.equal(result.coverage.includedCount, 0); assert.equal(result.nextCursor, null);
  }
  assert.throws(() => f.api.readConversationHistory(f.actor, f.request({ conversationId: 'another-company' })), status(404));
  for (const conversationId of ['unselected-wa', 'unselected-tg', 'outside-channel', 'outside-department']) assert.throws(() => f.api.readConversationHistory(f.actor, f.request({ conversationId })), status(403));
  assert.throws(() => f.api.searchConversations(f.actor, f.request({ query: 'cafe', channelId: 'other' })), status(403)); f.assertReadOnly();
});

test('filtros status/canal/tempo usam só dados registrados e links públicos continuam pesquisáveis', t => {
  const f = fixture(t);
  assert.deepEqual(f.api.searchConversations(f.actor, f.request({ query: 'cafe', status: 'pending' })).conversations.map(item => item.conversationId), ['tg-direct']);
  assert.deepEqual(f.api.searchConversations(f.actor, f.request({ query: 'cafe', status: 'closed', channelId: 'web' })).conversations.map(item => item.conversationId), ['web-direct']);
  assert.equal(f.api.searchConversations(f.actor, f.request({ query: 'cafe', after: '2026-10-04T13:00:00Z' })).conversations.length, 0);
  const link = f.api.searchConversations(f.actor, f.request({ query: 'public.example' }));
  assert.deepEqual(link.conversations.map(item => item.conversationId), ['wa-direct']); assert.match(link.conversations[0].snippets[0].text, /https:\/\/public\.example\/suporte/);
  for (const query of ['nota-sensivel', 'evento-sensivel', 'texto-kind-nao-publico', 'private-media']) assert.equal(f.api.searchConversations(f.actor, f.request({ query })).conversations.length, 0);
  const history = f.api.readConversationHistory(f.actor, f.request({ conversationId: 'wa-direct' })), serialized = JSON.stringify(history);
  assert.match(serialized, /https:\/\/public\.example\/suporte/); for (const excluded of ['nota-sensivel', 'evento-sensivel', 'texto-kind-nao-publico', 'private-media']) assert.equal(serialized.includes(excluded), false);
  assert.deepEqual(history.messages.find(item => item.id === 'wa-direct-message').attachments, [{ id: 'attachment-safe', kind: 'image', name: 'imagem.png', mime: 'image/png', size: 4 }]); f.assertReadOnly();
});

test('cursor busca pagina ordenação estável e rejeita filtro, principal, tamper e versão alterados', t => {
  const f = fixture(t), first = f.api.searchConversations(f.actor, f.request({ query: 'cafe', limit: 2 })), second = f.api.searchConversations(f.actor, f.request({ query: 'cafe', limit: 2, cursor: first.nextCursor }));
  assert.deepEqual(first.conversations.map(item => item.conversationId), ['ig-direct', 'messenger-direct']); assert.deepEqual(second.conversations.map(item => item.conversationId), ['tg-direct', 'tg-group']);
  assert.throws(() => f.api.searchConversations(f.actor, f.request({ query: 'agata', limit: 2, cursor: first.nextCursor })), status(409));
  assert.throws(() => f.api.searchConversations(f.actor, f.request({ query: 'cafe', limit: 3, cursor: first.nextCursor })), status(409));
  assert.throws(() => f.api.readConversationHistory(f.actor, f.request({ conversationId: 'wa-direct', limit: 2, cursor: first.nextCursor })), status(409));
  const secondPrincipal = f.create(), secondActor = f.principals.authenticate('Bearer ' + secondPrincipal.token);
  assert.throws(() => f.api.searchConversations(secondActor, f.request({ query: 'cafe', limit: 2, cursor: first.nextCursor })), status(409));
  const [payload, signature] = first.nextCursor.split('.'), data = JSON.parse(Buffer.from(payload, 'base64url')); data.offset = 3;
  assert.throws(() => f.api.searchConversations(f.actor, f.request({ query: 'cafe', limit: 2, cursor: Buffer.from(JSON.stringify(data)).toString('base64url') + '.' + signature })), status(400));
  f.store.mutate(f.admin, f.tenant.id, 'Mensagem posterior sintética', state => { const c = state.conversations[0]; c.version++; c.messages.push(f.message('new-public', 'Café aprovação recente')); });
  assert.throws(() => f.api.searchConversations(f.actor, f.request({ query: 'cafe', limit: 2, cursor: first.nextCursor })), status(409));
});

test('cursores falham após rotação, revogação, mudança adaptador ou novo processo', t => {
  const f = fixture(t), cursor = f.api.searchConversations(f.actor, f.request({ query: 'cafe', limit: 1 })).nextCursor;
  const restarted = new ServiceApi(f.store, f.principals, {});
  assert.throws(() => restarted.searchConversations(f.actor, f.request({ query: 'cafe', limit: 1, cursor })), status(400));
  const rotated = f.principals.rotate(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 }), fresh = f.principals.authenticate('Bearer ' + rotated.token);
  assert.throws(() => f.api.searchConversations(f.actor, f.request({ query: 'cafe', limit: 1, cursor })), status(401));
  assert.throws(() => f.api.searchConversations(fresh, f.request({ query: 'cafe', limit: 1, cursor })), status(409));
  f.store.mutate(f.admin, f.tenant.id, 'Adaptador mudou', state => { state.agents[0].version++; });
  assert.throws(() => f.api.searchConversations(fresh, f.request({ query: 'cafe' })), status(409));
  const newActor = f.principals.authenticate('Bearer ' + rotated.token);
  f.principals.revoke(f.admin, f.tenant.id, f.created.principal.id, { revision: rotated.principal.revision });
  assert.throws(() => f.api.searchConversations(newActor, f.request({ query: 'cafe' })), status(401));
});

test('seleção de grupo e autoridade são reconferidas antes de contar/paginar e antes do retorno', t => {
  const f = fixture(t), first = f.api.searchConversations(f.actor, f.request({ query: 'cafe', limit: 1 }));
  f.store.mutate(f.admin, f.tenant.id, 'Deseleção sintética', state => { state.channels[0].allowedGroups = []; });
  assert.throws(() => f.api.searchConversations(f.actor, f.request({ query: 'cafe', limit: 1, cursor: first.nextCursor })), status(409));
  assert.equal(f.api.searchConversations(f.actor, f.request({ query: 'cafe', limit: 50 })).coverage.includedCount, 6);
  assert.throws(() => f.api.readConversationHistory(f.actor, f.request({ conversationId: 'wa-group' })), status(403));
  const complete = f.principals.complete.bind(f.principals);
  f.principals.complete = (...args) => { const result = complete(...args); f.principals.revoke(f.admin, f.tenant.id, f.created.principal.id, { revision: 1 }); return result; };
  assert.throws(() => f.api.searchConversations(f.actor, f.request({ query: 'cafe' })), status(401));
});

test('histórico antigo explícito pagina para trás com páginas cronológicas e escopo de conversa', t => {
  const f = fixture(t);
  f.store.mutate(f.admin, f.tenant.id, 'Histórico antigo sintético', state => { state.conversations[0].messages = [
    f.message('a', 'Primeira antiga', { createdAt: '2020-01-01T10:00:00Z' }), f.message('c', 'Terceira antiga', { createdAt: '2020-01-03T10:00:00Z' }),
    f.message('b', 'Segunda antiga', { kind: 'human', createdAt: '2020-01-02T10:00:00Z' }), f.message('d', 'Quarta antiga', { kind: 'agent', createdAt: '2020-01-03T10:00:00Z' }),
    f.message('private-old', 'Nota antiga privada', { kind: 'internal', createdAt: '2020-01-03T10:00:00Z' })
  ]; });
  assert.equal(f.api.readConversationHistory(f.actor, f.request({ conversationId: 'wa-direct' })).messages.length, 0);
  const filters = { conversationId: 'wa-direct', after: '2020-01-01T00:00:00Z', before: '2020-01-04T00:00:00Z', limit: 2 };
  const first = f.api.readConversationHistory(f.actor, f.request(filters)), second = f.api.readConversationHistory(f.actor, f.request({ ...filters, cursor: first.nextCursor }));
  assert.deepEqual(first.messages.map(item => item.id), ['c', 'd']); assert.deepEqual(second.messages.map(item => item.id), ['a', 'b']);
  assert.equal(first.coverage.availableCount, 4); assert.equal(first.coverage.historySource, 'elozi'); assert.equal(second.nextCursor, null);
  assert.equal(f.api.searchConversations(f.actor, f.request({ query: 'primeira antiga' })).conversations[0].conversationId, 'wa-direct');
  assert.throws(() => f.api.readConversationHistory(f.actor, f.request({ ...filters, conversationId: 'tg-direct', cursor: first.nextCursor })), status(409));
  assert.throws(() => f.api.readConversationHistory(f.actor, f.request({ ...filters, before: '2020-01-05T00:00:00Z', cursor: first.nextCursor })), status(409));
  f.store.mutate(f.admin, f.tenant.id, 'Histórico revisado', state => { state.conversations[0].version++; });
  assert.throws(() => f.api.readConversationHistory(f.actor, f.request({ ...filters, cursor: first.nextCursor })), status(409));
});

test('replay histórico sem datas aceita relógio avançado e leitura atual sem cota adicional', t => {
  const f = fixture(t), input = f.request({ conversationId: 'wa-direct' }), first = f.api.readConversationHistory(f.actor, input);
  f.advance(5000); const repeated = f.api.readConversationHistory(f.actor, input);
  assert.equal(first.receipt, repeated.receipt); assert.equal(f.usage().requests, 1);
  f.store.mutate(f.admin, f.tenant.id, 'Novo texto registrado', state => { const c = state.conversations[0]; c.version++; c.messages.push(f.message('fresh-after-replay', 'Texto público novo')); });
  const latest = f.api.readConversationHistory(f.actor, input); assert.equal(latest.receipt, first.receipt); assert.equal(latest.version, 2); assert.ok(latest.messages.some(item => item.id === 'fresh-after-replay')); assert.equal(f.usage().requests, 1);
  assert.throws(() => f.api.readConversationHistory(f.actor, { ...input, limit: 1 }), status(409));
  const receipts = f.store.db.prepare('SELECT result,context FROM service_principal_receipts').all();
  for (const row of receipts) { assert.equal(row.result.includes('Texto público'), false); assert.equal(row.context.includes('Texto público'), false); }
});

test('limites UTF8 preservam paginação sem pular mensagens/conversas e informam cortes', t => {
  const f = fixture(t);
  f.store.mutate(f.admin, f.tenant.id, 'Volume Unicode sintético', state => {
    state.conversations = Array.from({ length: 50 }, (_, index) => f.conversation(`volume-${String(index).padStart(2, '0')}`, 'wa', {
      contact: '界'.repeat(120), messages: Array.from({ length: 3 }, (_, messageIndex) => f.message(`v${index}-m${messageIndex}`, '界'.repeat(1000)))
    }));
  });
  const collected = []; let cursor;
  do {
    const page = f.api.searchConversations(f.actor, f.request({ query: '界界', limit: 50, ...(cursor ? { cursor } : {}) }));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= SEARCH_BYTES); collected.push(...page.conversations.map(item => item.conversationId)); cursor = page.nextCursor;
    if (cursor) assert.equal(page.coverage.truncated, true);
  } while (cursor);
  assert.equal(collected.length, 50); assert.equal(new Set(collected).size, 50);
  f.store.mutate(f.admin, f.tenant.id, 'Texto longo registrado', state => { state.conversations[0].messages = Array.from({ length: 5 }, (_, index) => f.message(`long-${index}`, '界'.repeat(12000), { createdAt: `2026-10-04T12:0${index}:00Z` })); });
  const ids = []; cursor = null;
  do {
    const page = f.api.readConversationHistory(f.actor, f.request({ conversationId: 'volume-00', limit: 100, ...(cursor ? { cursor } : {}) }));
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= HISTORY_BYTES); assert.equal(page.coverage.truncated, true);
    assert.ok(page.messages.every(item => item.text.length > 0)); ids.push(...page.messages.map(item => item.id)); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(ids.length, 5); assert.equal(new Set(ids).size, 5);
});

test('entrada inválida e dados malformados não contornam limites nem consomem cota', t => {
  const f = fixture(t);
  for (const extra of [{ query: null }, { query: {} }, { query: ['cafe'] }, { query: 'x' }, { query: 'x'.repeat(201) }, { query: 'ca\u0000fe' }, { query: 'cafe', limit: 0 }, { query: 'cafe', limit: 51 }, { query: 'cafe', limit: '20' }, { query: 'cafe', status: 'deleted' }, { query: 'cafe', channelId: 'invalid space' }, { query: 'cafe', before: '2026-02-30T00:00:00Z' }, { query: 'cafe', after: '2026-10-05T00:00:60Z' }, { query: 'cafe', before: {} }, { query: 'cafe', cursor: '' }, { query: 'cafe', cursor: 'x'.repeat(2401) }, { query: 'cafe', tenantId: f.otherTenant.id }]) assert.throws(() => f.api.searchConversations(f.actor, f.request(extra)), status(400));
  for (const extra of [{ conversationId: null }, { conversationId: 'wa-direct', limit: 101 }, { conversationId: 'wa-direct', limit: 1.5 }, { conversationId: 'wa-direct', after: '2026-08-01T00:00:00Z', before: '2026-10-01T00:00:00Z' }, { conversationId: 'wa-direct', after: '2026-10-01T00:00:00Z', before: '2026-10-01T00:00:00Z' }, { conversationId: 'wa-direct', after: '2026-10-01' }, { conversationId: 'wa-direct', cursor: {} }]) assert.throws(() => f.api.readConversationHistory(f.actor, f.request(extra)), status(400));
  assert.equal(f.usage().requests, 0);
  f.store.mutate(f.admin, f.tenant.id, 'Dados legados malformados', state => {
    state.conversations[0].messages.push({ id: 'non-string', kind: 'customer', text: { password: 'do-not-coerce' }, createdAt: '2026-10-04T12:00:00Z', attachments: [{ id: 'https://do-not-expose.invalid', kind: 'image', name: 'invalid.png' }, { id: 'safe-attachment', kind: 'https://private-kind.invalid', mime: 'https://private-mime.invalid', name: 'https://private-name.invalid/a', size: -4 }] });
    state.conversations.push(f.conversation('invalid-channel', 'wa', { channelId: 'x'.repeat(1000) }));
  });
  assert.equal(f.api.searchConversations(f.actor, f.request({ query: 'do-not-coerce' })).conversations.length, 0);
  const serialized = JSON.stringify(f.api.readConversationHistory(f.actor, f.request({ conversationId: 'wa-direct' })));
  for (const excluded of ['do-not-coerce', 'do-not-expose', 'private-kind', 'private-mime', 'private-name']) assert.equal(serialized.includes(excluded), false);
});

test('consulta usa cota existente, mantém recibo mínimo e recusa serviço sem conversation.read', t => {
  const f = fixture(t, { dailyRequests: 1 }), input = f.request({ query: 'cafe' }), first = f.api.searchConversations(f.actor, input);
  assert.equal(f.api.searchConversations(f.actor, input).receipt, first.receipt);
  assert.throws(() => f.api.searchConversations(f.actor, f.request({ query: 'agata' })), status(429)); assert.equal(f.usage().requests, 1);
  const row = f.store.db.prepare('SELECT payload_hash,result FROM service_principal_receipts WHERE id=?').get(first.receipt);
  assert.match(row.payload_hash, /^[a-f0-9]{64}$/); assert.deepEqual(JSON.parse(row.result), { operation: 'search', includedCount: 7 }); assert.equal(row.result.includes('cafe'), false);
  const noRead = f.create({ capabilities: ['company.read'] }), noReadActor = f.principals.authenticate('Bearer ' + noRead.token);
  assert.throws(() => f.api.searchConversations(noReadActor, f.request({ query: 'cafe' })), status(403));
  assert.throws(() => f.api.readConversationHistory(noReadActor, f.request({ conversationId: 'wa-direct' })), status(403)); f.assertReadOnly();
});
