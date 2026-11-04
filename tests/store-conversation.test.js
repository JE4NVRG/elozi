import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { createEventBus, scopeEvent } from '../src/events.js';

const status = code => error => error.status === code;
const actor = { resellerId: 'workspace-a', role: 'reseller', name: 'Operador sintético' };
const otherActor = { ...actor, resellerId: 'workspace-b' };
function source(count = 3, messages = 2) {
  return { name: 'Empresa sintética', privateHeader: { token: 'private-header-synthetic' },
    contacts: [{ id: 'contact', name: 'Contato privado sintético', privateFields: { account: 'synthetic-only' } }],
    automation: { enabled: true, instruction: 'Instrução privada sintética' }, flowBindings: [{ id: 'flow', enabled: true }],
    channels: [{ id: 'wa', kind: 'whatsapp_qr', state: 'connected', credentials: { synthetic: true } }, { id: 'wa2', kind: 'webchat' }],
    agents: [{ id: 'agent', provider: 'mcp', mode: 'copilot', version: 1, configured: true, instructions: 'Instrução privada' }],
    departments: [{ id: 'd1', name: 'Suporte', active: true }, { id: 'd2', name: 'Financeiro', active: true }],
    conversations: Array.from({ length: count }, (_, index) => ({ id: `conversation-${index}`, contact: `Pessoa sintética ${index}`, contactId: 'contact',
      channelId: 'wa', department: 'Suporte', owner: 'agent', agentId: 'agent', status: 'open', version: 1, unread: 1,
      privateConversation: { note: `Nota privada ${index}` }, webchatVisitor: { key: `visitor-${index}` }, supportAssistantHandoff: { state: 'human' },
      messages: Array.from({ length: messages }, (_, number) => ({ id: `message-${index}-${number}`, kind: 'customer', text: `Texto sintético ${index}/${number}` })) })) };
}
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'elozi-conversation-fixture-')), path = join(directory, 'synthetic.sqlite'), store = new Store(path);
  store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('workspace-a', '{}');
  store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('workspace-b', '{}');
  const value = source(options.count, options.messages);
  store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('tenant-a', 'workspace-a', JSON.stringify(value));
  store.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run('tenant-b', 'workspace-b', JSON.stringify(source()));
  store.db.exec('CREATE TABLE wa_seen (channel_id TEXT NOT NULL,remote_jid TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(channel_id,remote_jid,message_id))');
  t.after(() => { store.events?.close?.(); store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, path, value };
}
const canonical = (store, id = 'tenant-a') => JSON.parse(store.db.prepare('SELECT data FROM tenants WHERE id=?').get(id).data);
const write = (store, value, id = 'tenant-a') => store.db.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(value), id);
const audits = store => store.db.prepare('SELECT action,actor FROM audit WHERE tenant_id=? ORDER BY rowid').all('tenant-a').map(row => ({ ...row }));
const remember = store => store.db.prepare('INSERT INTO wa_seen VALUES (?,?,?)').run('wa', 'synthetic-jid', 'synthetic-message');
const countSeen = store => store.db.prepare('SELECT count(*) AS n FROM wa_seen').get().n;

test('conversationTenant preserva todo header privado e uma história integral sem Store.tenant nem parse das outras histórias', t => {
  const { store, value } = fixture(t), parse = JSON.parse, parsed = [];
  store.tenant = () => { throw new Error('Leitura integral proibida no helper'); };
  JSON.parse = (input, ...args) => { parsed.push(input); return parse(input, ...args); };
  let selected;
  try {
    selected = store.conversationTenant(actor, 'tenant-a', 'conversation-0');
    store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'Parse seletivo', conversation => { conversation.version++; });
  }
  finally { JSON.parse = parse; }
  assert.deepEqual(selected, { id: 'tenant-a', resellerId: 'workspace-a', ...value, conversations: [value.conversations[0]] });
  assert.ok(parsed.length > 0);
  assert.ok(parsed.every(input => !input.includes('"conversations"') && !input.includes('"id":"conversation-1"')));
  assert.equal(selected.privateHeader.token, 'private-header-synthetic');
  assert.equal(selected.conversations[0].webchatVisitor.key, 'visitor-0');
});

test('mutateConversation equivale a mutate para valores, projeção, auditoria e retorno; só expõe metadata readonly', t => {
  const full = fixture(t), partial = fixture(t), mutate = conversation => {
    conversation.messages.push({ id: 'new-message', kind: 'agent', text: 'Resposta sintética' });
    conversation.version++; conversation.unread = 0; conversation.tags = ['Sintético'];
    return { id: conversation.id, version: conversation.version };
  };
  const fullEvents = [], partialEvents = [];
  for (const [entry, events] of [[full, fullEvents], [partial, partialEvents]]) {
    entry.store.events = createEventBus();
    entry.store.events.subscribe(({ id, at, ...event }) => events.push(event));
  }
  const expected = full.store.mutate(actor, 'tenant-a', result => `Versão ${result.version}`, state => mutate(full.store.getConversation(state, 'conversation-0')));
  const queued = []; partial.store.queuePostgres = id => queued.push(id);
  partial.store.tenant = () => { throw new Error('Leitura integral proibida no helper'); };
  const actual = partial.store.mutateConversation(actor, 'tenant-a', 'conversation-0', result => `Versão ${result.version}`, (conversation, metadata) => {
    assert.equal(metadata.id, 'tenant-a'); assert.equal(metadata.resellerId, actor.resellerId);
    assert.equal(metadata.contacts[0].privateFields.account, 'synthetic-only'); assert.equal(metadata.conversations, undefined);
    assert.ok(Object.isFrozen(metadata)); assert.ok(Object.isFrozen(metadata.channels)); assert.ok(Object.isFrozen(metadata.channels[0].credentials));
    assert.throws(() => { metadata.departments[0].name = 'Mudança proibida'; }, TypeError);
    return mutate(conversation);
  });
  assert.deepEqual(actual, expected); assert.deepEqual(canonical(partial.store), canonical(full.store));
  assert.deepEqual(partial.store.serviceTenant('workspace-a', 'tenant-a'), full.store.serviceTenant('workspace-a', 'tenant-a'));
  assert.deepEqual(audits(partial.store), audits(full.store)); assert.deepEqual(queued, ['tenant-a']);
  assert.deepEqual(partialEvents, fullEvents, 'o diff parcial não remove nem anuncia outras conversas');
});

test('referências retornadas não permitem mudar metadata readonly nem persistir estado depois do commit', t => {
  const { store, value } = fixture(t);
  const result = store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'Referências locais', (conversation, metadata) => ({ conversation, metadata }));
  assert.throws(() => { result.metadata.contacts[0].name = 'Mutação proibida'; }, TypeError);
  result.conversation.privateConversation.note = 'Mudança somente na referência local';
  result.conversation.messages.push({ id: 'not-persisted', kind: 'agent', text: 'Apenas local' });
  assert.deepEqual(canonical(store), value);
});

test('no-op preserva callback/audit/bridge sem UPDATE canônico nem guard', t => {
  const { store, value } = fixture(t), queued = [], original = store.serviceReadModel.withConversationWrite.bind(store.serviceReadModel);
  let guardedWrites = 0;
  store.serviceReadModel.withConversationWrite = (...args) => { guardedWrites++; return original(...args); };
  store.queuePostgres = id => queued.push(id);
  const before = store.db.prepare('SELECT total_changes() AS n').get().n;
  const result = store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'No-op auditado', (conversation, metadata) => {
    remember(store); assert.equal(metadata.contacts[0].id, 'contact'); return conversation.id;
  });
  assert.equal(result, 'conversation-0'); assert.equal(guardedWrites, 0);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n - before, 2, 'somente wa_seen e auditoria; nem canonical UPDATE nem guard/projeções');
  assert.deepEqual(canonical(store), value); assert.deepEqual(queued, ['tenant-a']); assert.equal(countSeen(store), 1); assert.equal(audits(store).length, 1);
});

test('no-op ainda faz CAS de header/target/posição/workspace e desfaz falhas de audit/bridge', t => {
  const { store, value } = fixture(t);
  for (const change of [
    () => store.db.prepare("UPDATE tenants SET data=json_set(data,'$.contacts[0].name','Outro header') WHERE id=?").run('tenant-a'),
    () => store.db.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[0].version',99) WHERE id=?").run('tenant-a'),
    () => { const moved = structuredClone(value); moved.conversations.reverse(); write(store, moved); },
    () => store.db.prepare('UPDATE tenants SET reseller_id=? WHERE id=?').run('workspace-b', 'tenant-a'),
    () => store.db.prepare("UPDATE service_tenant_private SET data=json_set(data,'$.contacts[0].name','Outro private header') WHERE tenant_id=?").run('tenant-a'),
    () => store.db.prepare("UPDATE service_conversation_private SET data=json_set(data,'$.version',99) WHERE tenant_id=? AND id=?").run('tenant-a', 'conversation-0'),
    () => store.db.prepare('UPDATE service_conversation_private SET position=2 WHERE tenant_id=? AND id=?').run('tenant-a', 'conversation-0'),
    () => store.db.prepare("UPDATE service_read_model_meta SET version=4 WHERE id='routing'").run()
  ]) {
    assert.throws(() => store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'No-op com CAS', () => { remember(store); change(); }), status(409));
    assert.deepEqual(canonical(store), value); assert.equal(countSeen(store), 0); assert.deepEqual(audits(store), []);
    assert.deepEqual(store.conversationTenant(actor, 'tenant-a', 'conversation-0').conversations[0], value.conversations[0]);
  }
  assert.throws(() => store.mutateConversation(actor, 'tenant-a', 'conversation-0', () => { throw new Error('Audit no-op falhou'); }, () => remember(store)), /Audit no-op falhou/);
  store.queuePostgres = () => { throw new Error('Bridge no-op falhou'); };
  assert.throws(() => store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'Bridge no-op', () => remember(store)), /Bridge no-op falhou/);
  delete store.queuePostgres;
  assert.deepEqual(canonical(store), value); assert.equal(countSeen(store), 0); assert.deepEqual(audits(store), []);
});

test('permissões de workspace/operator e IDs ausentes são iguais à leitura completa', t => {
  const { store, value } = fixture(t), denied = { ...actor, role: 'operator', tenantIds: ['another-tenant'] };
  const allowed = { ...actor, role: 'operator', tenantIds: ['tenant-a'] };
  for (const read of [() => store.conversationTenant(denied, 'tenant-a', 'conversation-0'), () => store.mutateConversation(denied, 'tenant-a', 'conversation-0', 'Negado', () => {})]) assert.throws(read, status(403));
  for (const read of [() => store.conversationTenant(otherActor, 'tenant-a', 'conversation-0'), () => store.mutateConversation(otherActor, 'tenant-a', 'conversation-0', 'Negado', () => {})]) assert.throws(read, status(404));
  assert.throws(() => store.conversationTenant(actor, 'tenant-a', 'missing'), status(404));
  assert.throws(() => store.mutateConversation(actor, 'tenant-a', 'missing', 'Negado', () => {}), status(404));
  assert.equal(store.conversationTenant(allowed, 'tenant-a', 'conversation-0').conversations[0].id, 'conversation-0');
  assert.deepEqual(canonical(store), value); assert.deepEqual(audits(store), []);
});

test('leitura WAL usa header e história do mesmo snapshot, inclusive dentro de transação externa', t => {
  const { store, path, value } = fixture(t), raw = new DatabaseSync(path), prepare = store.db.prepare.bind(store.db);
  try {
    let injected = false;
    store.db.prepare = sql => {
      const statement = prepare(sql);
      if (sql.includes(' AS header') && sql.includes('FROM tenants')) {
        const get = statement.get.bind(statement);
        statement.get = (...args) => {
          const row = get(...args);
          if (!injected) {
            injected = true; const next = structuredClone(value); next.contacts[0].name = 'Novo workspace'; next.conversations[0].messages[0].text = 'Nova história';
            raw.prepare('UPDATE tenants SET reseller_id=?,data=? WHERE id=?').run('workspace-b', JSON.stringify(next), 'tenant-a');
          }
          return row;
        };
      }
      return statement;
    };
    const snapshot = store.conversationTenant(actor, 'tenant-a', 'conversation-0');
    assert.equal(snapshot.contacts[0].name, value.contacts[0].name); assert.equal(snapshot.conversations[0].messages[0].text, value.conversations[0].messages[0].text);
    store.db.prepare = prepare;
    assert.throws(() => store.conversationTenant(actor, 'tenant-a', 'conversation-0'), status(404));
    store.db.exec('BEGIN IMMEDIATE');
    assert.equal(store.conversationTenant(otherActor, 'tenant-a', 'conversation-0').contacts[0].name, 'Novo workspace');
    assert.throws(() => store.conversationTenant(otherActor, 'tenant-a', 'missing'), status(404));
    store.db.exec('ROLLBACK');
  } finally { store.db.prepare = prepare; raw.close(); }
});

test('key e metadata são relidos do SQL atual; duplicata usa somente o primeiro ID', t => {
  const { store, path, value } = fixture(t), raw = new DatabaseSync(path);
  try {
    const next = structuredClone(value), selected = next.conversations.shift();
    selected.version = 9; selected.channelId = 'wa2'; next.conversations.push(selected, { ...structuredClone(selected), privateConversation: { note: 'Duplicata intocada' } });
    next.agents[0].version = 42; next.contacts[0].name = 'Metadata SQL recente';
    raw.prepare('UPDATE tenants SET data=? WHERE id=?').run(JSON.stringify(next), 'tenant-a');
    store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'Alteração seletiva', (conversation, metadata) => {
      assert.equal(conversation.version, 9); assert.equal(conversation.channelId, 'wa2'); assert.equal(metadata.agents[0].version, 42);
      assert.equal(metadata.contacts[0].name, 'Metadata SQL recente'); conversation.version = 10;
    });
    const after = canonical(store);
    assert.equal(after.conversations[2].version, 10); assert.equal(after.conversations[3].version, 9);
    assert.equal(after.conversations[3].privateConversation.note, 'Duplicata intocada');
    assert.deepEqual(after.conversations.slice(0, 2), next.conversations.slice(0, 2));
  } finally { raw.close(); }
});

test('ID com caracteres de path nunca é interpolado no caminho JSON do UPDATE', t => {
  const { store, value } = fixture(t), id = 'conversation-"][0].id';
  value.conversations[1].id = id; write(store, value);
  store.mutateConversation(actor, 'tenant-a', id, 'ID literal sintético', conversation => { conversation.version++; });
  const after = canonical(store);
  assert.equal(after.conversations[1].id, id); assert.equal(after.conversations[1].version, 2);
  assert.deepEqual(after.conversations[0], value.conversations[0]); assert.deepEqual(after.conversations[2], value.conversations[2]);
});

test('mudanças de versão/path/header/workspace dentro do callback falham sem gravar conversa, audit ou wa_seen', t => {
  const { store, value } = fixture(t);
  const changes = [
    () => store.db.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[0].version',99) WHERE id=?").run('tenant-a'),
    () => { const moved = structuredClone(value); moved.conversations.reverse(); write(store, moved); },
    () => store.db.prepare("UPDATE tenants SET data=json_set(data,'$.conversations[0].id','other-id') WHERE id=?").run('tenant-a'),
    () => store.db.prepare("UPDATE tenants SET data=json_set(data,'$.contacts[0].name','Outro header') WHERE id=?").run('tenant-a'),
    () => store.db.prepare('UPDATE tenants SET reseller_id=? WHERE id=?').run('workspace-b', 'tenant-a')
  ];
  for (const change of changes) {
    assert.throws(() => store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'Deve voltar atrás', conversation => {
      remember(store); change(); conversation.version = 2;
    }), status(409));
    assert.deepEqual(canonical(store), value); assert.deepEqual(audits(store), []); assert.equal(countSeen(store), 0);
    assert.equal(store.db.prepare('SELECT reseller_id FROM tenants WHERE id=?').get('tenant-a').reseller_id, 'workspace-a');
  }
});

test('callback síncrono, ID imutável, audit e ponte PostgreSQL preservam rollback atômico dos efeitos de DB', t => {
  const { store, value } = fixture(t);
  for (const mutate of [
    () => { throw new Error('Falha sintética'); },
    conversation => { conversation.id = 'other-id'; },
    () => Promise.resolve('callback assíncrono proibido')
  ]) {
    assert.throws(() => store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'Deve voltar atrás', conversation => { remember(store); return mutate(conversation); }));
    assert.deepEqual(canonical(store), value); assert.deepEqual(audits(store), []); assert.equal(countSeen(store), 0);
  }
  assert.throws(() => store.mutateConversation(actor, 'tenant-a', 'conversation-0', () => { throw new Error('Falha no audit'); }, conversation => { remember(store); conversation.version++; }), /Falha no audit/);
  store.queuePostgres = () => { throw new Error('Falha na ponte'); };
  assert.throws(() => store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'Ponte deve voltar atrás', conversation => { remember(store); conversation.version++; }), /Falha na ponte/);
  delete store.queuePostgres;
  assert.deepEqual(canonical(store), value); assert.deepEqual(audits(store), []); assert.equal(countSeen(store), 0);
  store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'Confirmação atômica', conversation => { remember(store); conversation.version++; });
  assert.equal(countSeen(store), 1); assert.equal(audits(store).length, 1); assert.equal(canonical(store).conversations[0].version, 2);
});

test('escopo da sessão é conferido novamente dentro da transação após o callback', t => {
  const { store, value } = fixture(t);
  for (const change of [session => { session.resellerId = 'workspace-b'; }, session => { session.role = 'reseller'; }, session => { session.tenantIds = []; }]) {
    const session = { ...actor, role: 'operator', tenantIds: ['tenant-a'] };
    assert.throws(() => store.mutateConversation(session, 'tenant-a', 'conversation-0', 'Escopo mudou', conversation => {
      remember(store); change(session); conversation.version++;
    }), status(403));
    assert.deepEqual(canonical(store), value); assert.equal(countSeen(store), 0); assert.deepEqual(audits(store), []);
  }
});

test('EventBus parcial publica após COMMIT, mantém status/rotas anteriores e left; rollback não publica', t => {
  const { store } = fixture(t), bus = createEventBus(), seen = [];
  store.events = bus;
  bus.subscribe(event => {
    store.db.exec('BEGIN IMMEDIATE');
    try { assert.equal(canonical(store).conversations[0].version, 2); assert.equal(audits(store).length, 1); }
    finally { store.db.exec('COMMIT'); }
    seen.push(event);
  });
  store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'Mudar rota', conversation => {
    conversation.messages.push({ id: 'new-message', kind: 'agent', text: 'Texto privado que não entra no evento' });
    conversation.status = 'closed'; conversation.owner = 'human'; conversation.agentId = null; conversation.departmentId = 'd2'; conversation.channelId = 'wa2'; conversation.version++;
  });
  assert.deepEqual(seen.map(event => event.type), ['conversation.message', 'conversation.updated']);
  const event = seen[1];
  assert.equal(event.status, 'closed'); assert.equal(event.departmentId, 'd2'); assert.equal(event.previous.departmentId, 'd1');
  assert.equal(event.previous.status, 'open'); assert.equal(event.previous.channelId, 'wa'); assert.equal(event.previous.owner, 'agent');
  assert.equal(scopeEvent(event, { tenantId: 'tenant-a', channelIds: ['wa'], departmentIds: ['d1'], assignedOnly: true, agentId: 'agent' }).left, true);
  assert.equal(JSON.stringify(seen).includes('Texto privado'), false);
  assert.throws(() => store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'Rollback', conversation => { conversation.version++; throw new Error('Rollback'); }), /Rollback/);
  assert.equal(seen.length, 2);
});

test('erro de publicação não reverte conversa e auditoria já confirmadas', t => {
  const { store } = fixture(t), failures = [];
  store.events = { closed: false, publish() { throw new Error('Falha sintética no bus'); } };
  store.onEventError = error => { failures.push(error.message); throw new Error('Falha do relator'); };
  store.mutateConversation(actor, 'tenant-a', 'conversation-0', 'Confirma apesar do bus', conversation => { conversation.version++; });
  assert.equal(canonical(store).conversations[0].version, 2); assert.equal(audits(store).length, 1); assert.deepEqual(failures, ['Falha sintética no bus']);
});

test('alterar uma de 10 mil conversas preserva os 200 mil históricos originais e campos privados', t => {
  const { store, value } = fixture(t, { count: 10000, messages: 20 });
  const hash = conversations => { const digest = createHash('sha256'); for (const conversation of conversations) digest.update(JSON.stringify([conversation.id, conversation.messages.slice(0, 20)])); return digest.digest('hex'); };
  const before = hash(value.conversations);
  store.tenant = () => { throw new Error('Leitura integral proibida no helper'); };
  store.mutateConversation(actor, 'tenant-a', 'conversation-9999', 'Uma conversa grande', conversation => {
    conversation.messages.push({ id: 'one-new-message', kind: 'agent', text: 'Resposta exclusivamente sintética' }); conversation.version++;
  });
  const after = canonical(store);
  assert.equal(after.conversations.length, 10000); assert.equal(after.conversations.reduce((total, conversation) => total + conversation.messages.length, 0), 200001);
  assert.equal(hash(after.conversations), before); assert.deepEqual(after.privateHeader, value.privateHeader); assert.deepEqual(after.contacts, value.contacts);
  assert.deepEqual(after.conversations[0], value.conversations[0]); assert.deepEqual(after.conversations[9999].privateConversation, value.conversations[9999].privateConversation);
  assert.deepEqual(after.conversations[9999].webchatVisitor, value.conversations[9999].webchatVisitor);
});
