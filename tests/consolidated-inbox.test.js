import test from 'node:test';
import assert from 'node:assert/strict';
import { createConsolidatedInbox } from '../src/consolidated-inbox.js';
import { Store } from '../src/store.js';
import { createAttendanceService } from '../src/attendance.js';

const conversation = (id, extra = {}) => ({ id, contact: 'Contato sintético', channelId: 'shared-channel', departmentId: 'support',
  owner: 'queue', status: 'open', unread: 0, version: 2, tags: ['Cliente'], updatedAt: '2026-10-02T10:00:00Z',
  messages: [{ kind: 'customer', text: 'Mensagem pública sintética', createdAt: '2026-10-02T09:00:00Z' }], ...extra });

function fixture(extra = {}) {
  const tenants = [
    { id: 'company-a', resellerId: 'workspace-a', name: 'Empresa A', channels: [{ id: 'shared-channel', name: 'Número A', kind: 'whatsapp_qr', transport: 'baileys', expectedNumber: '5511000000000' }],
      departments: [{ id: 'support', name: 'Suporte' }], conversations: [conversation('shared-id')] },
    { id: 'company-b', resellerId: 'workspace-a', name: 'Empresa B', channels: [{ id: 'shared-channel', name: 'Número B', kind: 'telegram', transport: 'telegram-bot', token: 'synthetic-secret' }],
      departments: [{ id: 'support', name: 'Suporte' }], conversations: [conversation('shared-id', { owner: 'human', assignedUserId: 'actor', assignedUserName: 'Pessoa sintética' })] },
    { id: 'foreign-company', resellerId: 'workspace-b', name: 'Empresa estrangeira', channels: [], departments: [], conversations: [conversation('foreign-id')] }
  ];
  const store = { db: { prepare: () => ({ all: resellerId => tenants.filter(tenant => tenant.resellerId === resellerId).map(({ id }) => ({ id })) }) },
    tenant: (actor, tenantId) => { const tenant = tenants.find(tenant => tenant.id === tenantId && tenant.resellerId === actor.resellerId); assert.ok(tenant); return tenant; } };
  const actor = { userId: 'actor', role: 'operator', resellerId: 'workspace-a', tenantIds: ['company-a', 'company-b'] };
  const inbox = createConsolidatedInbox(store, { can: () => true, channelState: (tenantId, channel) => tenantId === 'company-a' && channel.id === 'shared-channel' ? 'connected' : 'disconnected', ...extra });
  return { tenants, actor, inbox, list: value => inbox.list(actor, new URLSearchParams(value)) };
}

test('caixa única preserva identidades compostas e origem entre empresas e revendas', () => {
  const c = fixture(), result = c.list('');
  assert.equal(result.workspaceId, 'workspace-a'); assert.equal(result.total, 2);
  assert.deepEqual(result.items.map(item => [item.tenantId, item.id, item.channelId, item.channelName, item.channelState]), [
    ['company-a', 'shared-id', 'shared-channel', 'Número A', 'connected'],
    ['company-b', 'shared-id', 'shared-channel', 'Número B', 'disconnected']
  ]);
  assert.deepEqual(result.countTabs, { all: 2, mine: 1, queue: 1, agent: 0 });
  assert.equal(c.list('tenantId=company-b&channelId=shared-channel').items[0].tenantId, 'company-b');
  assert.throws(() => c.list('tenantId=foreign-company'), error => error.status === 403);
  c.actor.tenantIds = ['company-a']; assert.equal(c.list('').total, 1);
});

test('autoridade por canal e departamento vem antes de ler texto, contar e paginar', () => {
  const seen = [], c = fixture({ can: (actor, permission, context) => { seen.push([permission, context]); return context.channelId !== 'blocked-channel' && context.departmentId !== 'blocked-department'; } });
  const hidden = conversation('hidden', { channelId: 'blocked-channel', contact: 'Não buscar' });
  Object.defineProperty(hidden, 'messages', { get() { throw Error('Conteúdo privado foi lido antes de autorizar'); } });
  const hiddenDepartment = conversation('hidden-department', { departmentId: 'blocked-department' });
  Object.defineProperty(hiddenDepartment, 'messages', { get() { throw Error('Departamento privado foi lido'); } });
  c.tenants[0].channels.push({ id: 'blocked-channel', name: 'Canal privado' });
  c.tenants[0].departments.push({ id: 'blocked-department', name: 'Departamento privado' });
  c.tenants[0].conversations.unshift(hidden, hiddenDepartment);
  const page = c.list('q=pública&limit=1&offset=1');
  assert.equal(page.total, 2); assert.equal(page.items.length, 1); assert.equal(page.items[0].tenantId, 'company-b');
  assert.deepEqual(page.countTabs, { all: 2, mine: 1, queue: 1, agent: 0 });
  assert.deepEqual(page.counts, { active: 2, open: 2, pending: 0, closed: 0, unread: 0 });
  assert.equal(page.channels.some(item => item.id === 'blocked-channel'), false);
  assert.equal(page.departments.some(item => item.id === 'blocked-department'), false);
  assert.ok(seen.some(([, context]) => context.channelId === 'blocked-channel' && context.departmentId === 'support'));
});

test('resumo permite somente prévia pública limitada e não serializa notas, eventos ou identidades', () => {
  const c = fixture(), original = c.tenants[0].conversations[0];
  Object.assign(original, { remoteJid: 'synthetic@s.whatsapp.net', remoteAliases: ['synthetic-alias'], remoteChatId: '991', scheduledMessages: [{ text: 'Agendada privada' }], draft: 'Rascunho privado' });
  original.messages.push({ kind: 'human', text: 'x'.repeat(600), createdAt: '2026-10-02T09:30:00Z', attachments: [{ kind: 'image', name: 'Imagem sintética', path: 'private-path', secret: 'synthetic-key' }] },
    { kind: 'internal', text: 'nota confidencial', createdAt: '2026-10-02T10:00:00Z' }, { kind: 'system', text: 'evento confidencial' });
  const result = c.list('tenantId=company-a'), item = result.items[0], serialized = JSON.stringify(result);
  assert.deepEqual(item.preview, { text: 'x'.repeat(280), kind: 'human', createdAt: '2026-10-02T09:30:00Z', attachmentKind: 'image', attachmentName: 'Imagem sintética' });
  for (const hidden of ['messages', 'remoteJid', 'remoteAliases', 'remoteChatId', 'scheduledMessages', 'draft', 'nota confidencial', 'evento confidencial', 'synthetic-key', 'private-path', 'expectedNumber']) assert.equal(serialized.includes(hidden), false, hidden);
  assert.equal(c.list('q=confidencial').total, 0);
  original.messages = [{ kind: 'internal', text: 'Somente nota' }]; assert.equal(c.list('tenantId=company-a').items[0].preview, null);
});

test('filtros e abas contam somente o escopo antes da aba e paginação', () => {
  const c = fixture();
  c.tenants[0].conversations.push(conversation('closed', { status: 'closed', owner: 'human', unread: 1, assignedUserId: 'actor' }),
    conversation('agent', { status: 'pending', owner: 'agent', unread: 3, conversationKind: 'group', tags: ['Urgente'], updatedAt: '2026-10-02T11:00:00Z',
      messages: [{ kind: 'customer', text: 'Mensagem pública sintética', createdAt: '2026-10-02T11:00:00Z' }] }));
  const result = c.list('tab=queue&limit=1');
  assert.equal(result.total, 1); assert.deepEqual(result.countTabs, { all: 3, mine: 1, queue: 1, agent: 1 });
  assert.deepEqual(result.counts, { active: 3, open: 2, pending: 1, closed: 1, unread: 2 });
  assert.equal(c.list('kind=group&tag=urgente&unread=true').items[0].id, 'agent');
  assert.equal(c.list('assignedUserId=actor&status=all').total, 2);
  assert.equal(c.list('status=closed').total, 1);
  assert.equal(c.list('owner=agent').total, 1);
  assert.equal(c.list('status=all&sort=oldest').items.at(-1).id, 'agent');
  assert.equal(c.list('status=all&sort=unread').items[0].id, 'agent');
  assert.equal(c.list('status=all&offset=0&limit=1').hasMore, true);
  assert.equal(c.list('status=all&offset=99&limit=1').hasMore, false);
});

test('busca no CRM precisa de contacts.read no contexto específico e não usa notas', () => {
  let readable = false;
  const c = fixture({ can: (actor, permission) => permission !== 'contacts.read' || readable });
  const original = c.tenants[0].conversations[0]; original.contactId = 'contact-id';
  c.tenants[0].contacts = [{ id: 'contact-id', name: 'Cadastro sintético', phone: '5511900001234', email: 'test@example.invalid', notes: 'Notas CRM confidenciais' }];
  assert.equal(c.list('q=5511900001234').total, 0); readable = true;
  assert.equal(c.list('q=5511900001234').total, 1); assert.equal(c.list('q=Notas+CRM').total, 0);
  assert.equal(JSON.stringify(c.list('q=5511900001234')).includes('5511900001234'), false);
});

test('paginação, enums e texto rejeitam filtros inválidos sem amplificar a resposta', () => {
  const c = fixture();
  for (const params of ['limit=0', 'limit=201', 'offset=-1', 'offset=100001', 'offset=1.2', 'limit=1&limit=2', 'status=private', 'sort=random', 'tab=admin', 'unread=maybe', 'q=' + 'x'.repeat(201)]) assert.throws(() => c.list(params), error => error.status === 400, params);
  assert.equal(c.list('status=all&tab=all&owner=all&kind=all').total, 2);
});

test('permissões por empresa: um verificador por empresa e permissão, mesmas decisões do can e síncrono', () => {
  const rule = (actor, permission, context) => permission !== 'contacts.read' && context.channelId !== 'blocked-channel' && context.departmentId !== 'blocked-department';
  const created = [], checked = [];
  const permissions = (actor, permission, tenantId) => { created.push([permission, tenantId]); return context => { checked.push(context); assert.equal(context.tenantId, tenantId); return rule(actor, permission, context); }; };
  const build = extra => {
    const c = fixture(extra);
    c.tenants[0].channels.push({ id: 'blocked-channel', name: 'Canal privado' });
    c.tenants[0].departments.push({ id: 'blocked-department', name: 'Departamento privado' });
    c.tenants[0].conversations.push(conversation('hidden', { channelId: 'blocked-channel' }), conversation('hidden-department', { department: 'Departamento privado', departmentId: undefined }), conversation('legacy', { departmentId: undefined, department: 'Suporte' }));
    c.tenants[1].conversations.push(conversation('extra', { contactId: 'contact-b' }));
    return c;
  };
  const reference = build({ can: rule }), snapshot = build({ can: () => assert.fail('Com permissões por empresa o can por item não é usado'), permissions });
  for (const params of ['status=all', 'status=all&q=sint%C3%A9tica', 'tenantId=company-a&status=all', 'status=all&departmentId=support']) {
    created.length = 0;
    assert.deepEqual(snapshot.list(params), reference.list(params), params);
    const keys = created.map(item => item.join('|'));
    assert.equal(new Set(keys).size, keys.length, 'no máximo um verificador por empresa e permissão: ' + params);
  }
  assert.ok(checked.length > 0);
  created.length = 0; snapshot.list('status=all');
  assert.deepEqual(created, [['inbox.read', 'company-a'], ['inbox.read', 'company-b']], 'contatos só são consultados quando há busca');
  created.length = 0; snapshot.list('status=all&q=sint%C3%A9tica');
  assert.deepEqual(created.filter(([permission]) => permission === 'contacts.read'), [['contacts.read', 'company-b']]);
  assert.throws(() => fixture({ permissions: 'all' }), TypeError);
  assert.throws(() => fixture({ permissions: () => Promise.resolve(() => true) }).list(''), TypeError);
  assert.throws(() => fixture({ permissions: () => () => Promise.resolve(true) }).list(''), TypeError);
  assert.throws(() => fixture({ permissions: () => true }).list(''), TypeError);
});

test('ler e adicionar nota atualizam a revisão/CAS sem promover conversa nem trocar seu horário público', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const actor = { resellerId: 'mep-demo', role: 'reseller', userId: 'synthetic-attendant', name: 'Pessoa sintética' };
  const tenant = store.createTenant(actor, { name: 'Relógio sintético', segment: 'QA' });
  store.mutate(actor, tenant.id, 'Preparar relógio sintético', state => {
    state.channels = [{ id: 'shared-channel', kind: 'whatsapp_qr' }];
    state.conversations = [
      conversation('old', { version: 1, unread: 3, owner: 'human', assignedUserId: actor.userId,
        messages: [{ kind: 'customer', text: 'Pergunta antiga', createdAt: '2026-10-02T09:00:00Z' }] }),
      conversation('new', { version: 1, messages: [{ kind: 'customer', text: 'Pergunta recente', createdAt: '2026-10-03T09:00:00Z' }] })
    ];
  });
  const inbox = createConsolidatedInbox(store, { can: () => true, channelState: () => 'connected' });
  const list = params => inbox.list(actor, new URLSearchParams(`tenantId=${tenant.id}&${params || ''}`));
  const attendance = createAttendanceService(store, { authorize: () => true, now: () => Date.parse('2026-10-08T10:00:00Z') });
  const first = list('delta=1'); assert.deepEqual(first.items.map(item => item.id), ['new', 'old']);
  attendance.readState(actor, tenant.id, 'old', { version: 1, unread: false });
  const read = list('delta=1&since=' + first.revision), old = read.items[0];
  assert.equal(read.delta, true); assert.deepEqual(read.order, [[tenant.id, 'new'], [tenant.id, 'old']]);
  assert.equal(old.id, 'old'); assert.equal(old.unread, 0); assert.equal(old.version, 2);
  assert.equal(old.updatedAt, '2026-10-08T10:00:00.000Z'); assert.equal(old.lastMessageAt, '2026-10-02T09:00:00Z');
  assert.notEqual(read.revision, first.revision, 'o poll ainda entrega o estado de leitura novo');
  assert.throws(() => attendance.readState(actor, tenant.id, 'old', { version: 1, unread: false }), error => error.status === 409, 'CAS continua exigindo a versão atual');
  attendance.addNote(actor, tenant.id, 'old', { version: 2, text: 'Nota interna sintética', commandId: 'synthetic-note' });
  const noted = list('delta=1&since=' + read.revision);
  assert.deepEqual(noted.order, read.order); assert.equal(noted.items[0].version, 3);
  assert.equal(noted.items[0].lastMessageAt, old.lastMessageAt); assert.equal(noted.items[0].preview.text, 'Pergunta antiga');
  assert.equal(JSON.stringify(noted).includes('Nota interna sintética'), false);
  store.mutate(actor, tenant.id, 'Nova mensagem pública sintética', state => {
    const current = store.getConversation(state, 'old', 3);
    current.messages.push({ kind: 'human', text: 'Resposta pública nova', createdAt: '2026-10-08T10:01:00Z' });
    current.version++; current.updatedAt = '2026-10-08T10:01:00Z';
  });
  const replied = list('delta=1&since=' + noted.revision);
  assert.deepEqual(replied.order, [[tenant.id, 'old'], [tenant.id, 'new']]);
  assert.equal(replied.items[0].lastMessageAt, '2026-10-08T10:01:00Z'); assert.equal(replied.items[0].preview.text, 'Resposta pública nova');
  assert.equal(list('sort=oldest&limit=1').items[0].id, 'new', 'paginação usa a mesma ordem por mensagem');
});

test('prévia e horário seguem a mensagem pública mais nova apesar de backlog, notas e recibos', () => {
  const c = fixture(), current = c.tenants[0].conversations[0];
  current.messages.push({ kind: 'agent', text: 'Resposta pública recente', createdAt: '2026-10-04T11:00:00Z' },
    { kind: 'customer', text: 'Backlog público antigo', createdAt: '2026-10-01T08:00:00Z' },
    { kind: 'internal', text: 'Nota privada recente', createdAt: '2026-10-08T11:00:00Z' },
    { kind: 'system', text: 'Recibo recente', createdAt: '2026-10-08T12:00:00Z' });
  current.updatedAt = '2026-10-08T12:00:00Z';
  const row = c.list('').items[0];
  assert.equal(row.tenantId, 'company-a'); assert.equal(row.lastMessageAt, '2026-10-04T11:00:00Z');
  assert.equal(row.preview.text, 'Resposta pública recente'); assert.equal(row.preview.createdAt, row.lastMessageAt);
  assert.equal(row.updatedAt, current.updatedAt, 'relógio operacional preservado');
  current.messages.push({ kind: 'customer', text: 'Mensagem recebida agora', createdAt: '2026-10-08T12:01:00Z' });
  assert.equal(c.list('tenantId=company-a').items[0].lastMessageAt, '2026-10-08T12:01:00Z');
});

test('conversa vazia ou mensagem sem data não usa leitura/nota como horário da última mensagem', () => {
  const c = fixture(), current = c.tenants[0].conversations[0];
  current.messages = []; current.updatedAt = '2026-10-08T12:00:00Z';
  let row = c.list('tenantId=company-a').items[0]; assert.equal(row.lastMessageAt, null); assert.equal(row.preview, null);
  current.messages = [{ kind: 'internal', createdAt: '2026-10-08T13:00:00Z' }, { kind: 'customer', text: 'Legado sem data', createdAt: 'inválida' }];
  row = c.list('tenantId=company-a').items[0]; assert.equal(row.lastMessageAt, null); assert.equal(row.preview.createdAt, null);
  current.createdAt = '2026-10-01T08:00:00Z';
  assert.equal(c.list('tenantId=company-a').items[0].lastMessageAt, current.createdAt, 'data de criação real é fallback estável');
  current.updatedAt = '2026-10-09T12:00:00Z'; assert.equal(c.list('tenantId=company-a').items[0].lastMessageAt, current.createdAt);
});
