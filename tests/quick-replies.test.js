import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { QuickReplies } from '../src/quick-replies.js';

const status = code => error => error.status === code;
const valid = { shortcut: 'saudacao', title: 'Saudação de teste', text: 'Olá, texto sintético de atendimento.' };
function user(c, id, { role = 'operator', resellerId = 'mep-demo', tenantIds = [c.tenantId], permissions = null, scopeRules = null } = {}) {
  c.store.db.prepare(`INSERT INTO auth_users(id,username,name,role,reseller_id,tenant_ids,password_salt,password_hash,created_at,permissions,scope_rules)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, `${id}.synthetic`, `Pessoa ${id}`, role, resellerId, JSON.stringify(tenantIds), Buffer.alloc(16), Buffer.alloc(64), Date.now(), permissions === null ? null : JSON.stringify(permissions), scopeRules === null ? null : JSON.stringify(scopeRules));
  return c.auth.actor(c.store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(id));
}
function fixture(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  const c = { store, auth }, admin = user(c, 'owner', { role: 'reseller', tenantIds: [] });
  const tenant = store.createTenant(admin, { name: 'Respostas QA', segment: 'Atendimento sintético' });
  store.mutate(admin, tenant.id, 'Fixture de canais', state => { state.channels = [{ id: 'qa-wa', kind: 'whatsapp_qr' }, { id: 'qa-tg', kind: 'telegram' }]; });
  return { ...c, admin, tenantId: tenant.id, service: new QuickReplies({ sync: store }, auth) };
}
const create = (c, input = {}, actor = c.admin, tenantId = c.tenantId) => c.service.create(actor, tenantId, { ...valid, ...input });
const state = c => c.store.tenant(c.admin, c.tenantId);
const auditCount = c => c.store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get(c.tenantId).n;

test('catálogo não semeia empresas nem schema e persiste somente no JSON SQLite', t => {
  const c = fixture(t), schema = c.store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all();
  assert.equal(state(c).quickReplies, undefined);
  assert.deepEqual(c.service.list(c.admin, c.tenantId), []);
  assert.equal(state(c).quickReplies, undefined);
  const reply = create(c, { shortcut: '  BOAS_VINDAS-1  ', title: '  Título sintético  ', text: '  Primeira linha.\r\n\tSegunda linha.  ' });
  assert.equal(reply.shortcut, 'boas_vindas-1'); assert.equal(reply.title, 'Título sintético');
  assert.equal(reply.text, 'Primeira linha.\r\n\tSegunda linha.'); assert.equal(reply.active, true);
  assert.equal(reply.version, 1); assert.equal(reply.createdBy, c.admin.userId); assert.equal(reply.updatedBy, c.admin.userId);
  assert.match(reply.id, /^[0-9a-f-]{36}$/u); assert.equal(reply.updatedAt, reply.createdAt); assert.ok(Number.isFinite(Date.parse(reply.createdAt)));
  const saved = structuredClone(reply);
  reply.text = 'Retorno não altera armazenamento';
  const raw = JSON.parse(c.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(c.tenantId).data);
  assert.deepEqual(raw.quickReplies, [saved]);
  assert.deepEqual(new QuickReplies(c.store, c.auth).list(c.admin, c.tenantId), [saved]);
  assert.deepEqual(c.store.db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").all(), schema);
  assert.equal(typeof c.service.delete, 'undefined');
});

test('listagem exige inbox.read aggregate vigente e operador só recebe ativas', t => {
  const c = fixture(t), calls = [], originalCan = c.auth.can.bind(c.auth);
  c.auth.can = (actor, permission, scope) => { calls.push({ permission, scope }); return originalCan(actor, permission, scope); };
  const enabled = create(c), disabled = create(c, { shortcut: 'inativa', active: false });
  const operator = user(c, 'reader', { permissions: ['inbox.read'], scopeRules: { [c.tenantId]: { channelIds: ['qa-wa'] } } });
  const listed = c.service.list(operator, c.tenantId);
  assert.deepEqual(listed.map(reply => reply.id), [enabled.id]);
  assert.deepEqual(calls.at(-1), { permission: 'inbox.read', scope: { tenantId: c.tenantId, aggregate: true } });
  listed[0].text = 'Não persiste'; assert.equal(c.service.list(operator, c.tenantId)[0].text, enabled.text);
  assert.deepEqual(c.service.list(c.admin, c.tenantId).map(reply => reply.id), [enabled.id, disabled.id]);
  const denied = user(c, 'denied', { permissions: [] });
  const emptyScope = user(c, 'empty-scope', { scopeRules: { [c.tenantId]: { channelIds: [] } } });
  for (const actor of [denied, emptyScope, { ...operator, userId: 'missing' }]) assert.throws(() => c.service.list(actor, c.tenantId), status(403));
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run('[]', operator.userId);
  assert.throws(() => c.service.list(operator, c.tenantId), status(403));
});

test('criação e edição exigem Store.admin e Auth.admin mesmo com papel forjado', t => {
  const c = fixture(t), reply = create(c), operator = user(c, 'operator');
  const before = JSON.stringify(state(c)), count = auditCount(c);
  for (const actor of [operator, { ...operator, role: 'reseller' }, { ...c.admin, userId: 'missing' }, { ...c.admin, role: 'operator', tenantIds: [c.tenantId] }]) {
    assert.throws(() => create(c, { shortcut: 'proibida' }, actor), status(403));
    assert.throws(() => c.service.update(actor, c.tenantId, reply.id, { version: 1, text: 'Proibido' }), status(403));
  }
  assert.equal(JSON.stringify(state(c)), before); assert.equal(auditCount(c), count);
  create(c, { shortcut: 'desativada', active: false });
  assert.equal(c.service.list({ ...operator, role: 'reseller' }, c.tenantId).length, 1);
});

test('administrador rebaixado conserva apenas leitura ativa e não altera catálogo', t => {
  const c = fixture(t); create(c); create(c, { shortcut: 'privada', active: false });
  c.store.db.prepare('UPDATE auth_users SET role=?,tenant_ids=?,permissions=? WHERE id=?').run('operator', JSON.stringify([c.tenantId]), '["inbox.read"]', c.admin.userId);
  assert.equal(c.service.list(c.admin, c.tenantId).length, 1);
  assert.throws(() => create(c, { shortcut: 'bloqueada' }), status(403));
});

test('autoridade é revalidada dentro mutate antes da gravação', t => {
  const c = fixture(t), reply = create(c), originalMutate = c.store.mutate.bind(c.store), before = JSON.stringify(state(c)), count = auditCount(c);
  c.store.mutate = (actor, tenantId, action, callback) => {
    c.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.now(), actor.userId);
    return originalMutate(actor, tenantId, action, callback);
  };
  assert.throws(() => c.service.update(c.admin, c.tenantId, reply.id, { version: 1, text: 'Autoridade perdida' }), status(403));
  assert.equal(JSON.stringify(state(c)), before); assert.equal(auditCount(c), count);
  c.store.db.prepare('UPDATE auth_users SET disabled_at=NULL WHERE id=?').run(c.admin.userId);
  assert.throws(() => create(c, { shortcut: 'revogada' }), status(403));
  assert.equal(JSON.stringify(state(c)), before); assert.equal(auditCount(c), count);
});

test('empresa e revenda isolam catálogo e identidades de edição', t => {
  const c = fixture(t), reply = create(c), other = c.store.createTenant(c.admin, { name: 'Outra QA', segment: 'QA' });
  const otherReply = create(c, {}, c.admin, other.id);
  assert.notEqual(otherReply.id, reply.id);
  assert.equal(c.service.list(c.admin, other.id).length, 1);
  assert.throws(() => c.service.update(c.admin, other.id, reply.id, { version: 1, active: false }), status(404));
  const operator = user(c, 'scoped');
  assert.throws(() => c.service.list(operator, other.id), status(403));
  c.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('foreign', JSON.stringify({ name: 'Revenda externa sintética' }));
  const foreign = user(c, 'foreign', { role: 'reseller', resellerId: 'foreign', tenantIds: [] });
  assert.throws(() => c.service.list(foreign, c.tenantId), status(403));
  assert.throws(() => create(c, { shortcut: 'foreign' }, foreign), status(404));
  assert.throws(() => c.service.update(foreign, c.tenantId, reply.id, { version: 1, active: false }), status(404));
  assert.equal(c.service.list(c.admin, c.tenantId)[0].version, 1);
});

test('atalho é único sem distinguir maiúsculas e inclui respostas inativas', t => {
  const c = fixture(t), first = create(c, { active: false }), second = create(c, { shortcut: 'outra' }), before = JSON.stringify(state(c));
  assert.throws(() => create(c, { shortcut: 'SAUDACAO' }), status(409));
  assert.throws(() => c.service.update(c.admin, c.tenantId, second.id, { version: 1, shortcut: 'SaUdAcAo', active: false }), status(409));
  assert.equal(JSON.stringify(state(c)), before);
  const renamed = c.service.update(c.admin, c.tenantId, first.id, { version: 1, shortcut: ' Saudacao ', title: 'Renomeada' });
  assert.equal(renamed.shortcut, 'saudacao'); assert.equal(renamed.version, 2);
  c.store.mutate(c.admin, c.tenantId, 'Fixture de caixa de atalho legado', tenant => { tenant.quickReplies[0].shortcut = 'SAUDACAO'; });
  assert.throws(() => create(c), status(409));
});

test('edições concorrentes com CAS aceitam um vencedor e preservam referência', async t => {
  const c = fixture(t), original = create(c), count = auditCount(c);
  const results = await Promise.allSettled(['A', 'B'].map(text => Promise.resolve().then(() => c.service.update(c.admin, c.tenantId, original.id, { version: 1, text }))));
  const winner = results.find(result => result.status === 'fulfilled').value;
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal(winner.version, 2); assert.equal(winner.id, original.id); assert.equal(winner.createdAt, original.createdAt);
  assert.equal(auditCount(c), count + 1);
  const deactivated = c.service.update(c.admin, c.tenantId, original.id, { version: 2, active: false });
  assert.equal(deactivated.id, original.id); assert.equal(deactivated.createdBy, original.createdBy);
  assert.equal(c.service.list(c.admin, c.tenantId)[0].text, winner.text);
  const reactivated = c.service.update(c.admin, c.tenantId, original.id, { version: 3, active: true });
  assert.equal(reactivated.id, original.id); assert.equal(reactivated.version, 4);
});

test('criação concorrente com atalho igual é atômica', async t => {
  const c = fixture(t), count = auditCount(c);
  const results = await Promise.allSettled(['SAUDACAO', 'saudacao'].map(shortcut => Promise.resolve().then(() => create(c, { shortcut }))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  assert.equal(c.service.list(c.admin, c.tenantId).length, 1); assert.equal(auditCount(c), count + 1);
});

test('campos desconhecidos, segredos, protótipos, getters e tipos inválidos são rejeitados', t => {
  const c = fixture(t), before = JSON.stringify(state(c)), count = auditCount(c);
  const invalid = [null, [], new Date(), Object.create(valid), { ...valid, [Symbol('secret')]: 'forjado' },
    ...['id', 'version', 'tenantId', 'resellerId', 'createdBy', 'createdAt', 'updatedAt', 'token', 'password', 'credentials', '__proto__'].map(key => ({ ...valid, [key]: 'forjado' })),
    ...['', 'a', 'x'.repeat(33), 'atalho espaço', '/atalho', 'olá', 'ſa', 'Ka', 'ok\nruim'].map(shortcut => ({ ...valid, shortcut })),
    { ...valid, shortcut: null }, { ...valid, shortcut: 7 },
    ...['', '  ', 'x'.repeat(81), 'título\nlinha', 'título\tlinha', '\ud800', 'Título\u0085'].map(title => ({ ...valid, title })),
    ...['', '  ', 'x'.repeat(4001), 'Texto\u0000', 'Texto\u001b', 'Texto\u0085', '\ud800'].map(text => ({ ...valid, text })),
    { ...valid, text: 7 }, ...['false', 0, 1, null, undefined].map(active => ({ ...valid, active }))];
  const accessor = { ...valid }; Object.defineProperty(accessor, 'text', { enumerable: true, get() { throw new Error('Getter não deve executar'); } }); invalid.push(accessor);
  invalid.forEach(input => assert.throws(() => c.service.create(c.admin, c.tenantId, input), status(400)));
  assert.equal(JSON.stringify(state(c)), before); assert.equal(auditCount(c), count);
  const edge = create(c, { shortcut: 'A'.repeat(32), title: 'é'.repeat(80), text: '漢'.repeat(4000), active: false });
  assert.equal(edge.shortcut, 'a'.repeat(32)); assert.equal(edge.text.length, 4000);
});

test('edição valida versão inteira, identidade, limites e campos antes de gravar', t => {
  const c = fixture(t), reply = create(c), before = JSON.stringify(state(c)), count = auditCount(c);
  for (const version of [undefined, null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => c.service.update(c.admin, c.tenantId, reply.id, { version, text: 'Inválida' }), status(400));
  for (const replyId of [null, 7, '', ' id ', 'x'.repeat(121), 'id\u0000']) assert.throws(() => c.service.update(c.admin, c.tenantId, replyId, { version: 1, active: false }), status(400));
  for (const input of [{ version: 1, id: reply.id }, { version: 1, active: 'false' }, { version: 1, text: '' }, { version: 1, title: 'x'.repeat(81) }, { version: 1, text: 'x'.repeat(4001) }, { version: 1, shortcut: 'a' }, { version: 1, token: 'forjado' }]) assert.throws(() => c.service.update(c.admin, c.tenantId, reply.id, input), status(400));
  assert.throws(() => c.service.update(c.admin, c.tenantId, 'missing', { version: 1, active: false }), status(404));
  assert.equal(JSON.stringify(state(c)), before); assert.equal(auditCount(c), count);
  c.store.mutate(c.admin, c.tenantId, 'Fixture de overflow', tenant => { tenant.quickReplies[0].version = Number.MAX_SAFE_INTEGER; });
  assert.throws(() => c.service.update(c.admin, c.tenantId, reply.id, { version: Number.MAX_SAFE_INTEGER, text: 'Overflow' }), status(409));
  assert.equal(c.service.list(c.admin, c.tenantId)[0].text, reply.text);
});

test('limite de 200 inclui inativas, mantém edições e não deixa gravação parcial', t => {
  const c = fixture(t); let first;
  for (let index = 0; index < 200; index++) { const reply = create(c, { shortcut: `resposta_${index}`, active: index % 2 === 0 }); first ||= reply; }
  const before = JSON.stringify(state(c)), count = auditCount(c);
  assert.throws(() => create(c, { shortcut: 'excedente' }), status(409));
  assert.equal(JSON.stringify(state(c)), before); assert.equal(auditCount(c), count);
  assert.equal(c.service.list(c.admin, c.tenantId).length, 200);
  assert.equal(c.service.update(c.admin, c.tenantId, first.id, { version: 1, active: false }).version, 2);
  assert.equal(c.service.list(c.admin, c.tenantId).length, 200);
  assert.equal(c.service.list(user(c, 'limit-reader'), c.tenantId).length, 99);
});

test('auditoria usa ações genéricas sem atalho, título ou corpo', t => {
  const c = fixture(t), reply = create(c, { shortcut: 'sintetico_unico', title: 'Título reservado sintético 47291', text: 'Corpo reservado sintético 93847' });
  const renamed = user(c, 'second-admin', { role: 'reseller', tenantIds: [] });
  const updated = c.service.update(renamed, c.tenantId, reply.id, { version: 1, title: 'Título atualizado 83471', text: 'Corpo atualizado 82374', active: false });
  assert.equal(updated.createdBy, c.admin.userId); assert.equal(updated.updatedBy, renamed.userId);
  const events = c.store.audit(c.admin, c.tenantId).filter(event => event.action.startsWith('Resposta rápida'));
  assert.deepEqual(events.map(event => event.action).sort(), ['Resposta rápida atualizada', 'Resposta rápida criada']);
  const encoded = JSON.stringify(events);
  for (const sensitive of [reply.shortcut, reply.title, reply.text, updated.title, updated.text]) assert.equal(encoded.includes(sensitive), false);
  assert.equal(events.some(event => event.actor === renamed.name), true);
});

test('catálogo corrompido é recusado e dependências ausentes falham fechadas', t => {
  const c = fixture(t);
  assert.throws(() => new QuickReplies(c.store, { can: () => true }), TypeError);
  assert.throws(() => new QuickReplies(null, c.auth), TypeError);
  c.store.mutate(c.admin, c.tenantId, 'Fixture de catálogo inválido', tenant => { tenant.quickReplies = {}; });
  assert.throws(() => c.service.list(c.admin, c.tenantId), status(409));
  assert.throws(() => create(c), status(409));
});
