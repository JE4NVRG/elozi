import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { snapshotTenant, diffTenant } from '../src/events.js';
import { createConversationFollowUps } from '../src/conversation-follow-ups.js';

const status = code => error => error.status === code;
const instant = Date.parse('2026-10-24T12:00:00Z');
function fixture(t, { path = ':memory:', conversationJournal = false } = {}) {
  let store = new Store(path, { conversationJournal });
  t.after(() => { if (store.db.isOpen) store.close(); });
  let auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) }), count = 0;
  function user({ role = 'operator', tenantIds = [], permissions = null, scopeRules = null } = {}) {
    const n = ++count, row = auth.insertUser({ username: `follow-up-qa-${n}`, name: `Pessoa sintética ${n}` }, Buffer.alloc(16, n), Buffer.alloc(64, n), role, tenantIds, 'mep-demo');
    store.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(permissions === null ? null : JSON.stringify(permissions), scopeRules === null ? null : JSON.stringify(scopeRules), row.id);
    return auth.actor(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
  }
  const admin = user({ role: 'reseller' });
  const tenant = store.createTenant(admin, { name: 'Acompanhamento QA', segment: 'Sintético' });
  const other = store.createTenant(admin, { name: 'Outra empresa QA', segment: 'Sintético' });
  const scopeRules = { [tenant.id]: { channelIds: ['wa'], departmentIds: ['support'] } };
  const alice = user({ tenantIds: [tenant.id], scopeRules }), bob = user({ tenantIds: [tenant.id] });
  const reader = user({ tenantIds: [tenant.id], scopeRules, permissions: ['inbox.read'] });
  store.mutate(admin, tenant.id, 'Fixture sintética de acompanhamento', state => {
    state.channels = [{ id: 'wa', kind: 'whatsapp_qr' }, { id: 'tg', kind: 'telegram' }];
    state.departments = [{ id: 'support', name: 'Suporte' }, { id: 'sales', name: 'Comercial' }];
    state.conversations = [{ id: 'conv', contact: 'Contato sintético', channelId: 'wa', departmentId: 'support', department: 'Suporte', status: 'open', owner: 'agent', assignedUserId: null, version: 1, unread: 3, updatedAt: '2026-10-24T11:00:00.000Z', messages: [{ id: 'incoming', kind: 'customer', text: 'Pergunta sintética.', createdAt: '2026-10-24T11:00:00.000Z' }] }, { id: 'other-conv', channelId: 'wa', departmentId: 'support', status: 'closed', owner: 'human', version: 1, unread: 0, messages: [] }];
  });
  const permissions = [];
  const authorize = (actor, tid, conversation, permission) => {
    permissions.push({ tenantId: tid, channelId: conversation.channelId, departmentId: conversation.departmentId, permission });
    return auth.can(actor, permission, { tenantId: tid, channelId: conversation.channelId, departmentId: conversation.departmentId || 'unassigned' });
  };
  let service = createConversationFollowUps(store, { authorize, now: () => instant });
  const current = () => store.getConversation(store.tenant(admin, tenant.id), 'conv');
  const payload = (extra = {}) => ({ version: current().version, commandId: `follow-up-${current().version}`, kind: 'support', title: 'Retorno do suporte', nextAction: 'Conferir a correção com o cliente', dueAt: '2026-10-25T09:00:00-03:00', ...extra });
  return {
    get store() { return store; }, get auth() { return auth; }, get service() { return service; },
    admin, tenant, other, alice, bob, reader, permissions, authorize, user, current, payload,
    create: extra => service.create(alice, tenant.id, 'conv', payload(extra)),
    update: (id, extra) => service.update(alice, tenant.id, 'conv', id, { version: current().version, ...extra }),
    change: fn => store.mutate(admin, tenant.id, 'Fixture: mudança concorrente', state => fn(state.conversations[0], state)),
    auditCount: () => store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get(tenant.id).n,
    reopen() {
      store.close(); store = new Store(path, { conversationJournal });
      auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
      service = createConversationFollowUps(store, { authorize, now: () => instant });
    }
  };
}
function unchangedConversation(before, after) {
  const { version: _v1, followUps: _f1, ...first } = before;
  const { version: _v2, followUps: _f2, ...second } = after;
  assert.deepEqual(second, first);
}

for (const conversationJournal of [false, true]) {
  for (const kind of ['support', 'quote']) {
    test(`${kind}: salvar, reabrir arquivo, concluir e reabrir; journal=${conversationJournal}`, t => {
      // Hermes TMPDIR takes precedence; the directory belongs only to this fixture.
      const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'elozi-follow-ups-'));
      const c = fixture(t, { path: join(dir, 'synthetic.sqlite'), conversationJournal });
      t.after(() => rmSync(dir, { recursive: true, force: true }));
      const before = c.current();
      const input = c.payload({ kind, title: kind === 'support' ? 'SaaS: conferir correção do acesso' : 'Orçamento: retorno da oficina', nextAction: kind === 'support' ? 'Validar acesso após correção' : 'Confirmar escopo do serviço local' });
      const created = c.service.create(c.alice, c.tenant.id, 'conv', input);
      assert.equal(created.version, 2); assert.equal(created.item.userId, c.alice.userId);
      assert.equal(created.item.dueAt, '2026-10-25T12:00:00.000Z');
      c.reopen();
      assert.deepEqual(c.service.list(c.reader, c.tenant.id, 'conv'), { items: [created.item], version: 2 });
      const projected = c.store.db.prepare('SELECT data FROM service_conversation_private WHERE tenant_id=? AND id=?').get(c.tenant.id, 'conv');
      assert.equal(JSON.parse(projected.data).followUps[0].id, created.item.id);
      const completed = c.update(created.item.id, { state: 'done', outcome: kind === 'support' ? 'Acesso validado pelo cliente sintético' : 'Orçamento discutido; aguardar decisão' });
      c.reopen();
      assert.deepEqual(c.service.list(c.alice, c.tenant.id, 'conv'), { items: [completed.item], version: 3 });
      assert.equal(c.current().followUps[0].userId, c.alice.userId);
      assert.deepEqual(c.service.create(c.alice, c.tenant.id, 'conv', input), created);
      unchangedConversation(before, c.current());
      assert.throws(() => c.update(created.item.id, { state: 'pending' }), status(409));
      assert.equal(c.store.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name='outbound_commands'").get().n, 0);
      assert.equal(c.service.tick, undefined); assert.equal(c.service.send, undefined);
      // Close before cleanup even if a preceding assertion fails (hooks run in registration order).
      c.store.close();
    });
  }
}

test('CAS, replay estável após edição e conflito de payload/pessoa/grant sem auditoria extra', t => {
  const c = fixture(t), input = c.payload({ commandId: 'stable-command' });
  const created = c.service.create(c.alice, c.tenant.id, 'conv', input);
  c.update(created.item.id, { nextAction: 'Nova ação', dueAt: null });
  const before = c.current(), audits = c.auditCount(); let queued = 0;
  c.store.queuePostgres = () => { queued++; };
  created.item.title = 'Resposta local adulterada';
  const replay = c.service.create(c.alice, c.tenant.id, 'conv', input);
  assert.equal(replay.item.title, input.title); assert.equal(replay.version, 2);
  assert.equal(replay.item.nextAction, input.nextAction);
  for (const change of [{ title: 'Outro título' }, { kind: 'quote' }, { nextAction: 'Outro passo' }, { dueAt: null }, { version: 2 }]) assert.throws(() => c.service.create(c.alice, c.tenant.id, 'conv', { ...input, ...change }), status(409));
  assert.throws(() => c.service.create(c.bob, c.tenant.id, 'conv', input), status(409));
  const trustedGrant = createConversationFollowUps(c.store, { authorize: () => true });
  assert.throws(() => trustedGrant.create({ ...c.alice, supportGrantId: 'different-grant' }, c.tenant.id, 'conv', input), status(409));
  assert.throws(() => c.service.create(c.alice, c.tenant.id, 'conv', { ...input, commandId: 'stale-new' }), status(409));
  assert.throws(() => c.update(replay.item.id, { version: 1, state: 'done', outcome: 'Stale' }), status(409));
  assert.deepEqual(c.current(), before); assert.equal(c.auditCount(), audits); assert.equal(queued, 0);
});

test('escopo fresco de tenant/canal/departamento, identidade revogada e replay não contornam autorização', t => {
  const c = fixture(t), input = c.payload(), created = c.service.create(c.alice, c.tenant.id, 'conv', input);
  assert.equal(c.service.list(c.reader, c.tenant.id, 'conv').items.length, 1);
  assert.throws(() => c.service.create(c.reader, c.tenant.id, 'conv', c.payload()), status(403));
  assert.throws(() => c.service.list(c.alice, c.other.id, 'conv'), status(403));
  assert.throws(() => c.service.list({ ...c.admin, resellerId: 'foreign-workspace' }, c.tenant.id, 'conv'), status(404));
  assert.throws(() => c.service.update(c.alice, c.tenant.id, 'other-conv', created.item.id, { version: 1, state: 'done', outcome: 'Errado' }), status(404));
  for (const change of [conv => { conv.channelId = 'tg'; }, conv => { conv.channelId = 'wa'; conv.departmentId = 'sales'; }]) {
    c.change(change); const before = c.current(), audits = c.auditCount();
    assert.throws(() => c.service.list(c.alice, c.tenant.id, 'conv'), status(403));
    assert.throws(() => c.service.create(c.alice, c.tenant.id, 'conv', input), status(403));
    assert.throws(() => c.update(created.item.id, { nextAction: 'Fora de escopo' }), status(403));
    assert.deepEqual(c.current(), before); assert.equal(c.auditCount(), audits);
  }
  c.change(conv => { conv.channelId = 'wa'; delete conv.departmentId; conv.department = 'Suporte'; });
  assert.equal(c.service.list(c.alice, c.tenant.id, 'conv').items.length, 1);
  assert.equal(c.permissions.at(-1).departmentId, 'support');
  c.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(instant, c.alice.userId);
  assert.throws(() => c.service.list(c.alice, c.tenant.id, 'conv'), status(403));
  assert.throws(() => c.service.create(c.alice, c.tenant.id, 'conv', input), status(403));
});

test('autorizar somente true síncrono; serviços e agentes negados inclusive com userId humano', async t => {
  const c = fixture(t), before = c.current(), audits = c.auditCount();
  assert.throws(() => createConversationFollowUps(c.store), TypeError);
  for (const authorize of [() => false, () => undefined, () => 1, () => 'true', async () => true, () => Promise.reject(Error('negação sintética'))]) {
    const service = createConversationFollowUps(c.store, { authorize });
    assert.throws(() => service.list(c.alice, c.tenant.id, 'conv'), status(403));
    assert.throws(() => service.create(c.alice, c.tenant.id, 'conv', c.payload()), status(403));
    assert.throws(() => service.update(c.alice, c.tenant.id, 'conv', 'unknown', { version: 1, nextAction: 'Teste' }), status(403));
  }
  const service = createConversationFollowUps(c.store, { authorize: () => true });
  for (const actor of [{ ...c.alice, kind: 'service', serviceId: 'service' }, { ...c.alice, kind: 'agent' }, { ...c.alice, agentId: 'agent' }, { ...c.alice, serviceCapability: 'inbox.reply' }, { ...c.alice, userId: '' }, { ...c.alice, role: 'service' }]) {
    assert.throws(() => service.list(actor, c.tenant.id, 'conv'), status(403));
    assert.throws(() => service.create(actor, c.tenant.id, 'conv', c.payload()), status(403));
    assert.throws(() => service.update(actor, c.tenant.id, 'conv', 'unknown', { version: 1, nextAction: 'Teste' }), status(403));
  }
  await Promise.resolve();
  assert.deepEqual(c.current(), before); assert.equal(c.auditCount(), audits);
});

test('limites, datas explícitas e campos de identidade inválidos rejeitados atomicamente', t => {
  const c = fixture(t), before = c.current(), audits = c.auditCount();
  for (const extra of [{ title: '' }, { title: 'x'.repeat(161) }, { nextAction: 'x'.repeat(501) }, { nextAction: null }, { title: '\u0000segredo' }, { kind: 'crm' }, { version: 0 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER }, { commandId: ' bad ' }, { commandId: 'x'.repeat(121) }, { dueAt: '' }, { dueAt: '2026-10-24T12:00:00' }, { dueAt: '2026-02-30T12:00:00Z' }, { dueAt: '2026-10-24T24:00:00Z' }, { dueAt: '2026-10-24T12:00:60Z' }, { dueAt: '2026-10-24T12:00:00+25:00' }, { userId: c.bob.userId }, { tenantId: c.other.id }, { conversationId: 'other-conv' }, { channelId: 'tg' }, { departmentId: 'sales' }, { state: 'done' }, { outcome: 'input' }, { assignedUserId: c.bob.userId }, { authorName: 'Forjado' }, { serviceId: 'forjado' }]) assert.throws(() => c.create(extra), status(400));
  const symbolic = c.payload(); symbolic[Symbol('foreign')] = true;
  assert.throws(() => c.service.create(c.alice, c.tenant.id, 'conv', symbolic), status(400));
  assert.deepEqual(c.current(), before); assert.equal(c.auditCount(), audits);
  const result = c.create({ title: 'x'.repeat(160), nextAction: 'x'.repeat(500), dueAt: '2028-02-29T00:00:00Z' });
  assert.equal(result.item.title.length, 160); assert.equal(result.item.nextAction.length, 500);
});

test('atualização preserva responsável; terminal exige resultado e não reabre nem altera conversa fechada', t => {
  const c = fixture(t), first = c.create({ dueAt: null }), before = c.current(), audits = c.auditCount();
  for (const patch of [{}, { state: 'sent' }, { state: 'done' }, { state: 'cancelled', outcome: ' ' }, { outcome: 'x'.repeat(501) }, { nextAction: 'x'.repeat(501) }, { dueAt: undefined }, { userId: c.bob.userId }, { title: 'Mudar título' }, { kind: 'quote' }, { tenantId: c.other.id }, { creationResult: {} }, { updatedAt: 'forjado' }]) assert.throws(() => c.update(first.item.id, patch), status(400));
  assert.deepEqual(c.current(), before); assert.equal(c.auditCount(), audits);
  c.change(conv => { conv.status = 'closed'; });
  const closed = c.current();
  const edited = c.service.update(c.bob, c.tenant.id, 'conv', first.item.id, { version: closed.version, state: 'pending', nextAction: 'Equipe conferirá retorno', dueAt: null });
  assert.equal(edited.item.userId, c.alice.userId);
  const cancelled = c.update(first.item.id, { state: 'cancelled', outcome: '  Cliente desistiu do retorno  ' });
  assert.equal(cancelled.item.outcome, 'Cliente desistiu do retorno');
  unchangedConversation(closed, c.current());
  for (const patch of [{ state: 'pending' }, { nextAction: 'Reabrir' }, { outcome: 'Corrigir histórico' }]) assert.throws(() => c.update(first.item.id, patch), status(409));
  assert.equal(c.current().status, 'closed');
});

test('limite de 40 inclui terminais, com replay ainda permitido e rejeição sem efeito', t => {
  const c = fixture(t), input = c.payload({ commandId: 'first' });
  const first = c.service.create(c.alice, c.tenant.id, 'conv', input);
  c.update(first.item.id, { state: 'done', outcome: 'Conferido' });
  for (let n = 1; n < 40; n++) c.create({ commandId: `batch-${n}`, kind: 'task' });
  const before = c.current(), audits = c.auditCount();
  assert.equal(c.service.list(c.reader, c.tenant.id, 'conv').items.length, 40);
  assert.throws(() => c.create({ commandId: 'forty-one' }), status(409));
  assert.deepEqual(c.service.create(c.alice, c.tenant.id, 'conv', input), first);
  assert.deepEqual(c.current(), before); assert.equal(c.auditCount(), audits);
});

test('DTO, snapshot de eventos e auditoria não expõem captura privada; nenhuma escrita envia ou invalida IA', t => {
  const c = fixture(t), before = c.current(), snapshot = snapshotTenant(c.store.tenant(c.admin, c.tenant.id));
  let queued = 0, callbacks = 0;
  c.store.queuePostgres = () => { queued++; };
  c.store.onConversationChanged = () => { callbacks++; };
  const result = c.create({ title: 'CANARIO_PRIVADO_TITULO', nextAction: 'CANARIO_PRIVADO_PASSO' });
  const record = c.current().followUps[0];
  assert.equal(record.tenantId, c.tenant.id); assert.equal(record.conversationId, 'conv');
  assert.equal(record.channelId, 'wa'); assert.equal(record.departmentId, 'support');
  for (const key of ['tenantId', 'resellerId', 'conversationId', 'channelId', 'departmentId', 'commandId', 'command', 'creationResult', 'supportGrantId']) assert.equal(Object.hasOwn(result.item, key), false);
  assert.deepEqual(Object.keys(c.service).sort(), ['create', 'list', 'update']);
  const completed = c.update(result.item.id, { state: 'done', outcome: 'CANARIO_PRIVADO_RESULTADO' });
  assert.equal(completed.item.outcome, 'CANARIO_PRIVADO_RESULTADO');
  const state = c.store.tenant(c.admin, c.tenant.id), events = diffTenant(snapshot, state, { tenantId: c.tenant.id });
  const publicPointers = JSON.stringify({ snapshot: snapshotTenant(state), events, audit: c.store.audit(c.admin, c.tenant.id) });
  for (const canary of ['CANARIO_PRIVADO_TITULO', 'CANARIO_PRIVADO_PASSO', 'CANARIO_PRIVADO_RESULTADO', record.commandId]) assert.equal(publicPointers.includes(canary), false);
  unchangedConversation(before, c.current());
  assert.equal(queued, 2); assert.equal(callbacks, 0);
  assert.equal(c.store.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name='outbound_commands'").get().n, 0);
});
