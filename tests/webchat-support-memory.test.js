import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { AgentMemory, AGENT_MEMORY_LIMITS } from '../src/agent-memory.js';
import { WebchatIdentity } from '../src/webchat-identity.js';

const admin = { role: 'reseller', resellerId: 'mep-demo', userId: 'support-memory-reviewer', name: 'Revisor sintético' };
const origin = 'https://mepmail.example';
const status = code => error => error.status === code;
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const tenant = store.createTenant(admin, { name: 'Suporte próprio RAM', segment: 'Teste' });
  // Use the actual identity schema. These rows are synthetic proof metadata, never tokens or private keys.
  new WebchatIdentity(store, { secrets: { get() { return {}; }, set() {} }, channelContext() {} });
  const identity = { enabled: true, version: 1, identityVersion: 1, issuer: 'https://mepmail.example', keys: [{ kid: 'synthetic-kid', revokedAt: null, validUntil: null }] };
  store.mutate(admin, tenant.id, 'Fixture de memória própria verificada', state => {
    state.agents = [{ id: 'support-agent', provider: 'hermes', mode: 'copilot', configured: true, version: 1 }, { id: 'other-agent', provider: 'hermes', mode: 'copilot', configured: true, version: 1 }];
    state.channels = [{ id: 'own-webchat', kind: 'webchat', transport: 'elozi-webchat', state: 'connected',
      webchat: { enabled: true, version: 1, origins: [origin], identity }, centralSupportScope: { origins: [origin], productIds: ['mepmail'] },
      supportAssistant: { enabled: true, version: 1, agentId: 'support-agent' } }, { id: 'other-channel', kind: 'telegram', transport: 'telegram-bot' }];
    state.contacts = [{ id: 'own-contact', name: 'Mesmo nome', type: 'person', version: 1, identities: [
      { channelId: 'own-webchat', kind: 'person', externalId: 'mepmail:user-one', verified: true },
      { channelId: 'other-channel', kind: 'person', externalId: '12345' } ] },
      { id: 'other-contact', name: 'Mesmo nome', type: 'person', version: 1, identities: [{ channelId: 'own-webchat', kind: 'person', externalId: 'mepmail:user-two', verified: true }] }];
    const verified = (id, contactId, externalId, owner = 'human') => ({ id, channelId: 'own-webchat', contactId, departmentId: 'support',
      owner, assignedUserId: owner === 'human' ? admin.userId : null, status: 'open', version: 1, messages: [], remoteSessionId: 'session-' + id,
      webchatVisitor: { verified: true, externalId, email: 'synthetic@example.test', name: 'Mesmo nome' } });
    state.conversations = [verified('origin-conversation', 'own-contact', 'mepmail:user-one'),
      verified('current-conversation', 'own-contact', 'mepmail:user-one', 'queue'), verified('other-conversation', 'other-contact', 'mepmail:user-two'),
      { id: 'other-channel-conversation', channelId: 'other-channel', remoteChatId: '12345', contactId: 'own-contact', departmentId: 'support', owner: 'human', assignedUserId: admin.userId, status: 'open', version: 1, messages: [] }];
  });
  for (const [index, cid] of ['origin-conversation', 'current-conversation', 'other-conversation'].entries()) {
    const external = cid === 'other-conversation' ? 'mepmail:user-two' : 'mepmail:user-one';
    store.db.prepare('INSERT INTO webchat_identity_sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)').run('session-' + cid, tenant.id, 'own-webchat', origin,
      origin, external, 'synthetic-kid', 'synthetic-jti-' + index, 1, '{}', Date.now(), Date.now() + 86400000);
  }
  const memory = new AgentMemory(store, { access: actor => actor.userId === admin.userId, resolveActor: () => admin });
  let authorized = true;
  const state = () => store.tenant(admin, tenant.id), conversation = (cid = 'current-conversation') => state().conversations.find(item => item.id === cid);
  const create = (extra = {}, cid = 'origin-conversation') => memory.create(admin, tenant.id, cid, { agentId: 'support-agent', scope: 'contact', title: 'Fato revisado',
    content: 'Prefere atendimento por escrito.', expiresAt: null, reviewed: true, conversationVersion: conversation(cid).version, ...extra });
  const snapshot = () => memory.supportSnapshot(state(), state().agents[0], conversation(), { authorize: () => authorized });
  const run = () => { const { references, ...supportMemorySnapshot } = snapshot(); return { id: 'support_synthetic-job', tenantId: tenant.id,
    channelIdAtStart: 'own-webchat', agentId: 'support-agent', conversationId: 'current-conversation', conversationVersion: conversation().version,
    actorUserId: null, serviceId: null, supportGrantId: null, supportMemorySnapshot }; };
  const current = value => memory.supportCurrent(state(), value, { authorize: () => authorized });
  const change = fn => store.mutate(admin, tenant.id, 'Mudança sintética de autorização', fn);
  const rewrite = (record, fn) => { const row = JSON.parse(store.db.prepare('SELECT data FROM agent_memories WHERE id=?').get(record.id).data); fn(row);
    store.db.prepare('UPDATE agent_memories SET data=? WHERE id=?').run(JSON.stringify(row), record.id); };
  return { store, tenant, memory, state, conversation, create, snapshot, run, current, change, rewrite, revoke() { authorized = false; } };
}

test('suporte seleciona só contato verificado no mesmo canal e mantém texto fora de pins/binding', t => {
  const c = fixture(t), included = c.create({ content: 'PRIVATE-SYNTHETIC-REVIEWED-FACT' });
  c.create({ scope: 'operation', content: 'Operação fora do escopo.' }); c.create({ agentId: 'other-agent', content: 'Agente diferente.' });
  c.create({ content: 'Mesmo nome em outro contato.' }, 'other-conversation'); c.create({ content: 'Mesmo contato em outro canal.' }, 'other-channel-conversation');
  const result = c.snapshot(); assert.deepEqual(result.pins.map(pin => pin.id), [included.id]); assert.equal(result.references[0].content, 'PRIVATE-SYNTHETIC-REVIEWED-FACT');
  const { references, ...saved } = result; assert.equal(JSON.stringify(saved).includes('PRIVATE-SYNTHETIC'), false);
  assert.equal(JSON.stringify(saved).includes('mepmail:user-one'), false); assert.equal(JSON.stringify(saved).includes('synthetic@example.test'), false);
  assert.equal(c.current(c.run()), true);
  assert.equal(JSON.stringify(c.state()).includes('PRIVATE-SYNTHETIC'), false);
  assert.equal(c.memory.snapshot({ kind: 'service', role: 'operator', resellerId: admin.resellerId }, c.state(), c.state().agents[0], c.conversation()), null, 'serviço comum continua sem memória');
});

test('autoridade DI estrita é obrigatória antes de ler memória privada', t => {
  const c = fixture(t); c.create();
  for (const authorize of [undefined, () => false, () => 'true', () => Promise.resolve(true)]) assert.throws(() => c.memory.supportSnapshot(c.state(), c.state().agents[0], c.conversation(), { authorize }), error => [403, 500].includes(error.status));
  const accepted = c.run(); c.revoke(); assert.equal(c.current(accepted), false); assert.throws(c.snapshot, status(403));
});

for (const mode of ['anonymous', 'no_contact', 'wrong_contact', 'no_private_proof', 'revoked_identity', 'expired_identity', 'identity_revision', 'wrong_origin', 'wrong_tenant', 'wrong_channel', 'key_revoked', 'key_expired', 'customer_workspace', 'closed', 'support_disabled']) test(`seleção de suporte recusa ${mode}`, t => {
  const c = fixture(t); c.create();
  if (['revoked_identity', 'expired_identity', 'identity_revision', 'wrong_origin', 'wrong_tenant', 'wrong_channel'].includes(mode)) {
    const fields = { revoked_identity: ['revoked_at', Date.now()], expired_identity: ['expires_at', Date.now() - 1], identity_revision: ['identity_version', 2], wrong_origin: ['origin', 'https://denied.example'], wrong_tenant: ['tenant_id', 'missing-tenant'], wrong_channel: ['channel_id', 'other-channel'] };
    const [column, value] = fields[mode];
    if (mode === 'wrong_tenant') { c.change(state => { state.conversations.find(item => item.id === 'current-conversation').remoteSessionId = 'foreign-session'; }); }
    else c.store.db.prepare(`UPDATE webchat_identity_sessions SET ${column}=? WHERE session_id=?`).run(value, 'session-current-conversation');
  } else if (mode === 'no_private_proof') c.store.db.prepare('DELETE FROM webchat_identity_sessions WHERE session_id=?').run('session-current-conversation');
  else if (mode === 'customer_workspace') c.store.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify({ accountKind: 'reseller' }), admin.resellerId);
  else c.change(state => {
    const conversation = state.conversations.find(item => item.id === 'current-conversation');
    if (mode === 'anonymous') conversation.webchatVisitor.verified = false;
    if (mode === 'no_contact') delete conversation.contactId;
    if (mode === 'wrong_contact') conversation.contactId = 'other-contact';
    if (mode === 'key_revoked') state.channels[0].webchat.identity.keys[0].revokedAt = Date.now();
    if (mode === 'key_expired') state.channels[0].webchat.identity.keys[0].validUntil = Date.now() - 1;
    if (mode === 'closed') conversation.status = 'closed';
    if (mode === 'support_disabled') state.channels[0].supportAssistant.enabled = false;
  });
  if (mode === 'customer_workspace') assert.throws(c.snapshot, status(403)); else assert.equal(c.snapshot(), null);
});

for (const mode of ['archived', 'expired', 'unreviewed', 'malformed_expiry', 'origin_unverified', 'origin_changed', 'origin_revoked', 'wrong_subject', 'missing_verified_hash']) test(`fato com ${mode} nunca entra na memória do suporte`, t => {
  const c = fixture(t), record = c.create();
  if (mode === 'origin_revoked') c.store.db.prepare('UPDATE webchat_identity_sessions SET revoked_at=? WHERE session_id=?').run(Date.now(), 'session-origin-conversation');
  else if (mode.startsWith('origin_')) c.change(state => { const source = state.conversations[0]; if (mode === 'origin_unverified') source.webchatVisitor.verified = false; else source.webchatVisitor.externalId = 'mepmail:user-two'; });
  else c.rewrite(record, value => {
    if (mode === 'archived') value.status = 'archived'; if (mode === 'expired') value.expiresAt = new Date(Date.now() - 1).toISOString();
    if (mode === 'unreviewed') value.reviewedBy = null; if (mode === 'malformed_expiry') value.expiresAt = 'not-a-date';
    if (mode === 'wrong_subject') value.subjectId = 'other-contact'; if (mode === 'missing_verified_hash') delete value.origin.webchatIdentityHash;
  });
  assert.equal(c.snapshot().references.length, 0);
});

test('sessão histórica expirada preserva fato revisado; sessão atual exige prova válida', t => {
  const c = fixture(t), record = c.create(); c.store.db.prepare('UPDATE webchat_identity_sessions SET expires_at=? WHERE session_id=?').run(Date.now() - 1, 'session-origin-conversation');
  assert.deepEqual(c.snapshot().pins.map(pin => pin.id), [record.id]); assert.equal(c.current(c.run()), true);
});

for (const mode of ['record_update', 'new_selection', 'contact_identity', 'contact_version', 'contact_archive', 'conversation_version', 'channel_config', 'proof_revoked', 'forged_run']) test(`supportCurrent invalida ${mode} antes de usar resultado`, t => {
  const c = fixture(t), record = c.create(), accepted = c.run(); assert.equal(c.current(accepted), true);
  if (mode === 'record_update') c.rewrite(record, value => { value.content = 'Nova revisão humana.'; value.version++; });
  if (mode === 'new_selection') c.create({ content: 'Novo fato selecionado.' });
  if (mode === 'proof_revoked') c.revoke();
  if (mode === 'forged_run') accepted.serviceId = 'unrelated-agent-service';
  if (['contact_identity', 'contact_version', 'contact_archive', 'conversation_version', 'channel_config'].includes(mode)) c.change(state => {
    if (mode === 'contact_identity') state.contacts[0].identities[0].externalId = 'mepmail:changed';
    if (mode === 'contact_version') state.contacts[0].version++;
    if (mode === 'contact_archive') state.contacts[0].archivedAt = new Date().toISOString();
    if (mode === 'conversation_version') state.conversations.find(item => item.id === 'current-conversation').version++;
    if (mode === 'channel_config') state.channels[0].supportAssistant.version++;
  });
  assert.equal(c.current(accepted), false);
});

test('snapshot limita contexto por bytes, e seleção fora dos pins também é revalidada', t => {
  const c = fixture(t); for (let i = 0; i < 7; i++) c.create({ title: 'Fato revisado ' + i, content: ('Fato humano ' + i + '. ').repeat(80) });
  const before = c.snapshot(); assert.ok(before.references.length > 0 && before.references.length < 7);
  assert.ok(Buffer.byteLength(JSON.stringify(before.references)) <= AGENT_MEMORY_LIMITS.contextBytes);
  const accepted = c.run(); const selected = new Set(before.pins.map(pin => pin.id));
  const excluded = c.store.db.prepare('SELECT id,data FROM agent_memories').all().find(row => !selected.has(row.id));
  const record = JSON.parse(excluded.data); record.version++; record.content = 'Revisão fora dos pins.';
  c.store.db.prepare('UPDATE agent_memories SET data=? WHERE id=?').run(JSON.stringify(record), record.id);
  assert.equal(c.current(accepted), false);
});

test('supportCurrent rejeita texto inserido no snapshot e snapshot geral permanece separado', t => {
  const c = fixture(t); c.create(); const accepted = c.run(); accepted.supportMemorySnapshot.references = [{ content: 'Injected' }];
  assert.equal(c.current(accepted), false); assert.equal(c.memory.current(c.state(), accepted), true);
});
