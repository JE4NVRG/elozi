import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { createAttendanceService } from '../src/attendance.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { resolveReply } from '../src/replies.js';
import { createRepliesUI } from '../public/replies-ui.js';

const status = code => error => error.status === code;
const command = (extra = {}) => ({ version: 1, text: 'Orientação privada da equipe.', commandId: 'note-one', ...extra });

function fixture(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
  let userCount = 0;
  function addUser({ role = 'operator', tenantIds = [], permissions = null, scopeRules = null } = {}) {
    const n = ++userCount;
    const row = auth.insertUser({ username: `attendance-qa-${n}`, name: `Pessoa QA ${n}` }, Buffer.alloc(16, n), Buffer.alloc(64, n), role, tenantIds, 'mep-demo');
    store.db.prepare('UPDATE auth_users SET permissions=?,scope_rules=? WHERE id=?').run(permissions === null ? null : JSON.stringify(permissions), scopeRules === null ? null : JSON.stringify(scopeRules), row.id);
    return auth.actor(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(row.id));
  }
  const admin = addUser({ role: 'reseller' });
  const tenant = store.createTenant(admin, { name: 'Atendimento QA', segment: 'Sintético' });
  const other = store.createTenant(admin, { name: 'Outra empresa QA', segment: 'Sintético' });
  const scopeRules = { [tenant.id]: { channelIds: ['wa'], departmentIds: ['support'] } };
  const alice = addUser({ tenantIds: [tenant.id], scopeRules });
  const bob = addUser({ tenantIds: [tenant.id] });
  const reader = addUser({ tenantIds: [tenant.id], permissions: ['inbox.read'], scopeRules });
  store.mutate(admin, tenant.id, 'Fixture sintética de atendimento', state => {
    state.channels = [{ id: 'wa', kind: 'whatsapp_qr' }, { id: 'tg', kind: 'telegram' }];
    state.departments = [{ id: 'support', name: 'Suporte' }, { id: 'sales', name: 'Comercial' }];
    state.agents = [{ id: 'hermes', name: 'Copiloto QA', provider: 'hermes', configured: true, mode: 'copilot', description: 'Responda dúvidas.', version: 1 }];
    state.conversations = [{ id: 'conv', contact: 'Contato sintético', channelId: 'wa', departmentId: 'support', department: 'Suporte', status: 'open', owner: 'human', assignedUserId: alice.userId, assignedUserName: alice.name, agentId: null, version: 1, unread: 3, updatedAt: '2026-10-02T11:00:00.000Z', messages: [{ id: 'customer', kind: 'customer', text: 'Pergunta pública do cliente.', createdAt: '2026-10-02T11:00:00.000Z', delivery: 'received' }] }];
  });
  let queued = 0;
  store.queuePostgres = () => { queued++; };
  const calls = [];
  const authorize = (actor, id, conversation, permission) => {
    calls.push({ userId: actor.userId, tenantId: id, conversationId: conversation.id, permission });
    return auth.can(actor, permission, { tenantId: id, channelId: conversation.channelId, departmentId: conversation.departmentId || 'unassigned' });
  };
  const attendance = createAttendanceService(store, { authorize, now: () => Date.parse('2026-10-02T12:00:00Z') });
  return {
    store, auth, admin, tenant, other, alice, bob, reader, addUser, attendance, calls,
    current: () => store.getConversation(store.tenant(admin, tenant.id), 'conv'),
    change: change => store.mutate(admin, tenant.id, 'Fixture: mudança concorrente', state => change(state.conversations[0])),
    auditCount: () => store.db.prepare('SELECT count(*) AS n FROM audit WHERE tenant_id=?').get(tenant.id).n,
    queued: () => queued
  };
}

test('nota interna persiste autoria e data sem arquivo, outbox ou recibo de transporte', t => {
  const c = fixture(t), before = c.current();
  const result = c.attendance.addNote(c.alice, c.tenant.id, 'conv', command({ text: '  Nota privada\nSegunda linha.  ' }));
  const saved = c.current(), note = saved.messages.at(-1);
  assert.deepEqual(result, saved);
  assert.equal(saved.version, before.version + 1);
  assert.equal(saved.unread, before.unread);
  assert.equal(saved.updatedAt, '2026-10-02T12:00:00.000Z');
  assert.deepEqual(saved.messages[0], before.messages[0]);
  assert.deepEqual(note, { id: note.id, kind: 'internal', text: 'Nota privada\nSegunda linha.', userId: c.alice.userId, authorName: c.alice.name, createdAt: saved.updatedAt, commandId: 'note-one', commandVersion: 1 });
  assert.match(note.id, /^[0-9a-f-]{36}$/);
  assert.equal(c.queued(), 1);
  assert.deepEqual(c.calls.at(-1), { userId: c.alice.userId, tenantId: c.tenant.id, conversationId: 'conv', permission: 'inbox.reply' });
  assert.equal(c.store.db.prepare("SELECT name FROM sqlite_master WHERE name='outbound_commands'").get(), undefined);
});

test('payload inválido ou campos de envio injetados não alteram dados nem audit', t => {
  const c = fixture(t), before = c.current(), audit = c.auditCount();
  for (const input of [null, [], command({ version: 0 }), command({ version: 1.5 }), command({ version: Number.MAX_SAFE_INTEGER + 1 }), command({ text: '' }), command({ text: ' \n ' }), command({ text: 'x'.repeat(2001) }), command({ text: 'Nota\u0000privada' }), command({ text: 23 }), command({ commandId: '' }), command({ commandId: ' key ' }), command({ commandId: 'x'.repeat(121) }), command({ attachmentIds: ['private-file'] }), command({ transport: 'whatsapp' }), command({ userId: c.bob.userId }), command({ authorName: 'Autor forjado' })]) {
    assert.throws(() => c.attendance.addNote(c.alice, c.tenant.id, 'conv', input), status(400));
  }
  const symbolInput = command(); symbolInput[Symbol('transport')] = 'whatsapp';
  assert.throws(() => c.attendance.addNote(c.alice, c.tenant.id, 'conv', symbolInput), status(400));
  assert.deepEqual(c.current(), before);
  assert.equal(c.auditCount(), audit);
  assert.equal(c.queued(), 0);
  assert.equal(c.attendance.addNote(c.alice, c.tenant.id, 'conv', command({ text: 'x'.repeat(2000) })).messages.at(-1).text.length, 2000);
});

test('CAS impede nota e leitura concorrentes sem persistir alteração parcial', t => {
  const c = fixture(t);
  c.attendance.addNote(c.alice, c.tenant.id, 'conv', command());
  const before = c.current(), audit = c.auditCount(), queued = c.queued();
  assert.throws(() => c.attendance.addNote(c.alice, c.tenant.id, 'conv', command({ commandId: 'note-two' })), status(409));
  assert.throws(() => c.attendance.readState(c.reader, c.tenant.id, 'conv', { version: 1, unread: false }), status(409));
  assert.deepEqual(c.current(), before);
  assert.equal(c.auditCount(), audit);
  assert.equal(c.queued(), queued);
});

test('replay confirmado após nova revisão mantém a única nota e não grava audit ou spool', t => {
  const c = fixture(t), original = c.attendance.addNote(c.alice, c.tenant.id, 'conv', command()).messages.at(-1);
  c.attendance.readState(c.reader, c.tenant.id, 'conv', { version: 2, unread: false });
  const current = c.current(), audit = c.auditCount(), queued = c.queued();
  const replay = c.attendance.addNote(c.alice, c.tenant.id, 'conv', command());
  assert.deepEqual(replay, current);
  assert.deepEqual(replay.messages.at(-1), original);
  assert.equal(replay.messages.filter(message => message.kind === 'internal').length, 1);
  assert.equal(c.auditCount(), audit);
  assert.equal(c.queued(), queued);
  for (const input of [command({ text: 'Outra nota.' }), command({ version: 3 })]) {
    assert.throws(() => c.attendance.addNote(c.alice, c.tenant.id, 'conv', input), status(409));
  }
  c.change(conversation => { conversation.assignedUserId = c.bob.userId; conversation.version++; });
  assert.throws(() => c.attendance.addNote(c.bob, c.tenant.id, 'conv', command()), status(409));
  assert.deepEqual(c.current().messages.at(-1), original);
});

test('permissão atual e escopo de empresa, canal e departamento protegem notas e leitura', t => {
  const c = fixture(t);
  assert.throws(() => c.attendance.addNote(c.reader, c.tenant.id, 'conv', command()), status(403));
  assert.throws(() => c.attendance.readState(c.alice, c.other.id, 'conv', { version: 1, unread: false }), status(403));
  assert.throws(() => c.attendance.addNote(c.admin, c.other.id, 'conv', command()), status(404));
  const foreign = { ...c.admin, resellerId: 'outro-workspace' };
  assert.throws(() => c.attendance.readState(foreign, c.tenant.id, 'conv', { version: 1, unread: false }), status(404));
  for (const changed of [{ channelId: 'tg' }, { departmentId: 'sales' }]) {
    c.change(conversation => Object.assign(conversation, { channelId: 'wa', departmentId: 'support' }, changed));
    const before = c.current();
    assert.throws(() => c.attendance.addNote(c.alice, c.tenant.id, 'conv', command()), status(403));
    assert.throws(() => c.attendance.readState(c.alice, c.tenant.id, 'conv', { version: 1, unread: false }), status(403));
    assert.deepEqual(c.current(), before);
  }
  c.change(conversation => Object.assign(conversation, { channelId: 'wa', departmentId: 'support' }));
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify([]), c.alice.userId);
  assert.throws(() => c.attendance.addNote(c.alice, c.tenant.id, 'conv', command()), status(403));
  assert.throws(() => c.attendance.readState(c.alice, c.tenant.id, 'conv', { version: 1, unread: false }), status(403));
});

test('nota exige responsável humano inclusive administrador e bloqueia conversa encerrada', t => {
  const c = fixture(t);
  assert.throws(() => c.attendance.addNote(c.admin, c.tenant.id, 'conv', command()), status(409));
  for (const patch of [{ status: 'closed' }, { owner: 'queue' }, { owner: 'agent' }, { assignedUserId: null }, { assignedUserId: c.bob.userId }]) {
    c.change(conversation => Object.assign(conversation, { status: 'open', owner: 'human', assignedUserId: c.alice.userId }, patch));
    assert.throws(() => c.attendance.addNote(c.alice, c.tenant.id, 'conv', command()), status(409));
    assert.equal(c.current().messages.length, 1);
  }
  c.change(conversation => Object.assign(conversation, { status: 'pending', owner: 'human', assignedUserId: c.admin.userId }));
  assert.equal(c.attendance.addNote(c.admin, c.tenant.id, 'conv', command()).messages.at(-1).userId, c.admin.userId);
});

test('replay revalida encerramento, responsável e autorização após confirmação', t => {
  const c = fixture(t);
  c.attendance.addNote(c.alice, c.tenant.id, 'conv', command());
  c.change(conversation => { conversation.status = 'closed'; });
  assert.throws(() => c.attendance.addNote(c.alice, c.tenant.id, 'conv', command()), status(409));
  c.change(conversation => { conversation.status = 'open'; conversation.assignedUserId = c.bob.userId; });
  assert.throws(() => c.attendance.addNote(c.alice, c.tenant.id, 'conv', command()), status(409));
  c.change(conversation => { conversation.assignedUserId = c.alice.userId; });
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read']), c.alice.userId);
  assert.throws(() => c.attendance.addNote(c.alice, c.tenant.id, 'conv', command()), status(403));
  assert.equal(c.current().messages.filter(message => message.kind === 'internal').length, 1);
});

test('leitura é interna, preserva mensagens e contador positivo, sem exigir titular', t => {
  const c = fixture(t), before = c.current();
  const unread = c.attendance.readState(c.reader, c.tenant.id, 'conv', { version: 1, unread: true });
  assert.equal(unread.unread, 3);
  assert.equal(unread.version, 2);
  assert.deepEqual(unread.messages, before.messages);
  assert.equal(c.calls.at(-1).permission, 'inbox.read');
  const read = c.attendance.readState(c.reader, c.tenant.id, 'conv', { version: 2, unread: false });
  assert.equal(read.unread, 0);
  assert.equal(read.version, 3);
  const marked = c.attendance.readState(c.reader, c.tenant.id, 'conv', { version: 3, unread: true });
  assert.equal(marked.unread, 1);
  assert.deepEqual(marked.messages, before.messages);
  assert.equal(marked.assignedUserId, c.alice.userId);
  c.change(conversation => { conversation.status = 'closed'; });
  assert.equal(c.attendance.readState(c.reader, c.tenant.id, 'conv', { version: 4, unread: false }).unread, 0);
  assert.equal(c.store.db.prepare("SELECT name FROM sqlite_master WHERE name='outbound_commands'").get(), undefined);
});

test('marcar WhatsApp Baileys como não lido grava fence local sem mudar mensagens, status ou responsável', t => {
  const c = fixture(t); c.store.mutate(c.admin, c.tenant.id, 'Transporte Baileys sintético', tenant => { tenant.channels.find(channel => channel.id === 'wa').transport = 'baileys'; });
  const before = structuredClone(c.current()), marked = c.attendance.readState(c.reader, c.tenant.id, 'conv', { version: 1, unread: true });
  assert.equal(marked.whatsappManualUnreadAt, '2026-10-02T12:00:00.000Z');
  for (const field of ['messages','status','owner','assignedUserId']) assert.deepEqual(marked[field], before[field]);
  const read = c.attendance.readState(c.reader, c.tenant.id, 'conv', { version: marked.version, unread: false });
  assert.equal(read.unread, 0); assert.equal(read.whatsappManualUnreadAt, undefined);
  assert.equal(c.store.db.prepare("SELECT name FROM sqlite_master WHERE name='outbound_commands'").get(), undefined);
});

test('leitura de outro transporte não cria fence do WhatsApp', t => {
  const c = fixture(t), marked = c.attendance.readState(c.reader, c.tenant.id, 'conv', { version: 1, unread: true });
  assert.equal(marked.whatsappManualUnreadAt, undefined);
});

test('leitura aceita somente booleano explícito e revisão válida', t => {
  const c = fixture(t), before = c.current(), audit = c.auditCount();
  for (const input of [null, [], { version: 1 }, { version: 1, unread: 0 }, { version: 1, unread: 'false' }, { version: 1, unread: null }, { version: 0, unread: false }, { version: 1, unread: true, sendReceipt: true }, { version: 1, unread: true, text: 'Mensagem' }]) {
    assert.throws(() => c.attendance.readState(c.reader, c.tenant.id, 'conv', input), status(400));
  }
  assert.deepEqual(c.current(), before);
  assert.equal(c.auditCount(), audit);
});

test('nota salva fica fora do contexto do provedor e de referências externas no servidor e UI', async t => {
  const c = fixture(t), marker = 'CONTEUDO_PRIVADO_NUNCA_ENVIAR_ao_cliente';
  const conversation = c.attendance.addNote(c.alice, c.tenant.id, 'conv', command({ text: marker }));
  const note = conversation.messages.at(-1);
  let sent;
  const runtime = new AgentRuntime(c.store, { providerCall: async context => { sent = context.messages; return 'Resposta para revisão humana.'; } });
  const result = await runtime.start(c.alice, c.tenant.id, 'conv', { agentId: 'hermes', version: conversation.version, runId: 'note-privacy-run' });
  assert.equal(result.state, 'draft');
  assert.ok(sent.some(message => message.content.includes('Pergunta pública do cliente.')));
  assert.equal(JSON.stringify(sent).includes(marker), false);
  assert.throws(() => resolveReply(conversation, { replyToMessageId: note.id }), status(404));
  assert.equal(resolveReply(conversation, { replyToMessageId: 'customer' }).text, 'Pergunta pública do cliente.');
  const ui = createRepliesUI({ escape: value => String(value ?? ''), icon: () => '' });
  ui.syncContext({ workspaceId: 'mep-demo', tenantId: c.tenant.id, conversationId: 'conv', messages: conversation.messages });
  assert.equal(ui.messageReplyButton(note), '');
  assert.equal(ui.selectQuote(note.id), false);
  assert.equal(ui.quoteComposer().includes(marker), false);
  assert.equal(ui.selectQuote('customer'), true);
  assert.equal(c.current().messages.filter(message => message.kind === 'internal').length, 1);
});

test('factory exige autorização síncrona e rollback impede alteração com callback assíncrono', t => {
  const c = fixture(t), before = c.current(), audit = c.auditCount();
  assert.throws(() => createAttendanceService(c.store), TypeError);
  const service = createAttendanceService(c.store, { authorize: async () => true });
  assert.throws(() => service.addNote(c.alice, c.tenant.id, 'conv', command()), TypeError);
  assert.throws(() => service.readState(c.reader, c.tenant.id, 'conv', { version: 1, unread: false }), TypeError);
  assert.deepEqual(c.current(), before);
  assert.equal(c.auditCount(), audit);
});

test('notas internas recentes não expulsam o histórico público do contexto do copiloto', async t=>{
  const c=fixture(t);
  for(let i=0;i<25;i++)c.attendance.addNote(c.alice,c.tenant.id,'conv',command({version:c.current().version,commandId:'many-notes-'+i,text:'Privado canário '+i}));
  let prompt;
  const runtime=new AgentRuntime(c.store,{providerCall:async context=>{prompt=context.messages;return 'Resposta de revisão.';}});
  await runtime.start(c.alice,c.tenant.id,'conv',{agentId:'hermes',version:c.current().version,runId:'many-notes-run'});
  assert.ok(prompt.some(m=>m.content.includes('Pergunta pública do cliente.')));
  assert.equal(JSON.stringify(prompt).includes('Privado canário'),false);
});
