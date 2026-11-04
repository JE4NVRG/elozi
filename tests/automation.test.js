import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { FlowService } from '../src/flows.js';
import { Operations } from '../src/operations.js';
import { AutomationService, normalizeCalendar, withinCalendar, businessElapsedMinutes, businessDeadline } from '../src/automation.js';

const status = value => error => error.status === value;
const at = '2026-10-01T13:00:00.000Z';
const graph = tag => ({ nodes: [
  { id: 'start', type: 'start', config: {} },
  { id: 'check', type: 'condition', config: { field: 'text', operator: 'contains', value: 'plano' } },
  { id: 'tag', type: 'tag', config: { tag } },
  { id: 'route', type: 'department', config: { department: 'Comercial' } },
  { id: 'handoff', type: 'handoff', config: { owner: 'human' } },
  { id: 'end', type: 'end', config: {} }
], edges: [{ from: 'start', to: 'check' }, { from: 'check', to: 'tag', when: 'true' }, { from: 'check', to: 'end', when: 'false' }, { from: 'tag', to: 'route' }, { from: 'route', to: 'handoff' }, { from: 'handoff', to: 'end' }] });

function fixture(t, automationOptions = {}) {
  let now = Date.parse(at);
  const store = new Store(':memory:'), auth = new Auth(store.db, { validateTenant: (actor, tenantId) => store.tenant(actor, tenantId) });
  t.after(() => store.close());
  const user = (id, role, resellerId = 'mep-demo', tenantIds = []) => {
    store.db.prepare(`INSERT INTO auth_users(id,username,name,role,reseller_id,tenant_ids,password_salt,password_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?)`).run(id, id, id, role, resellerId, JSON.stringify(tenantIds), Buffer.alloc(16), Buffer.alloc(64), now);
    return auth.actor(store.db.prepare('SELECT * FROM auth_users WHERE id=?').get(id));
  };
  const admin = user('admin-qa', 'reseller'), tenant = store.createTenant(admin, { name: 'Automação QA', segment: 'Sintético' });
  store.mutate(admin, tenant.id, 'Fixture', state => {
    state.departments = [{ id: 'support', name: 'Suporte', active: true }, { id: 'sales', name: 'Comercial', active: true }];
    state.channels = [{ id: 'tg', kind: 'telegram', transport: 'telegram-bot', state: 'connected' }, { id: 'wa', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' }];
    state.conversations = [{ id: 'conv', channelId: 'tg', contact: 'Cliente sintético', department: 'Suporte', departmentId: 'support', owner: 'queue', assignedUserId: null, agentId: null, status: 'open', version: 2, tags: [], messages: [{ id: 'm1', kind: 'customer', text: 'Quero um plano', delivery: 'received', createdAt: '2026-10-01T12:59:30.000Z' }] }];
  });
  const flows = new FlowService(store), created = flows.create(admin, tenant.id, { name: 'Comercial', graph: graph('Vendas') });
  const flow = flows.publish(admin, tenant.id, created.id, { version: 1 });
  const service = new AutomationService(store, auth, flows, { now: () => now, ...automationOptions });
  const config = (bindings, sla = { enabled: true, firstReplyMinutes: 15, resolutionMinutes: 240, calendar: null }, version = service.get(admin, tenant.id).version) => service.configure(admin, tenant.id, { version, bindings, sla });
  const binding = (overrides = {}) => ({ name: 'Rota comercial', enabled: true, channelId: 'tg', flowId: flow.id, flowVersion: 1, trigger: 'incoming', ...overrides });
  const receive = (overrides = {}) => service.onIncoming(tenant.id, { conversationId: 'conv', messageId: 'm1', conversationVersion: 2, newConversation: true, ...overrides });
  const conversation = () => store.tenant(admin, tenant.id).conversations[0];
  return { store, auth, admin, tenant, flows, flow, service, user, config, binding, receive, conversation, clock: value => { now = Date.parse(value); } };
}

test('configuração é administrativa, CAS e somente vínculos da própria empresa são aceitos', t => {
  const c = fixture(t), operator = c.user('operator-qa', 'operator', 'mep-demo', [c.tenant.id]);
  assert.equal(c.service.get(c.admin, c.tenant.id).version, 1);
  assert.throws(() => c.service.get(operator, c.tenant.id), status(403));
  assert.throws(() => c.service.configure({ ...operator, role: 'reseller' }, c.tenant.id, { version: 1, bindings: [] }), status(403));
  const saved = c.config([c.binding()]); assert.equal(saved.version, 2); assert.equal(saved.bindings[0].authorizedBy, c.admin.userId);
  assert.throws(() => c.config([], undefined, 1), status(409));
  assert.throws(() => c.config([c.binding({ channelId: 'foreign' })]), status(400));
  assert.throws(() => c.config([c.binding({ flowVersion: 2 })]), status(400));
  assert.throws(() => c.config([c.binding({ authorizedBy: 'forged' })]), status(400));
  saved.bindings[0].enabled = false; assert.equal(c.service.get(c.admin, c.tenant.id).bindings[0].enabled, true);
  c.store.db.prepare('INSERT INTO resellers VALUES (?,?)').run('other-reseller', JSON.stringify({ name: 'Outra' }));
  const other = c.user('other-admin', 'reseller', 'other-reseller');
  assert.throws(() => c.service.get(other, c.tenant.id), status(404));
});

test('vínculo novo exige canal real conectado; regra existente pode ser desativada offline', t => {
  const c = fixture(t), saved = c.config([c.binding()]), existing = saved.bindings[0];
  c.store.mutate(c.admin, c.tenant.id, 'Desconexão sintética', state => {
    state.channels.find(channel => channel.id === 'tg').state = 'disconnected';
    state.channels.push(
      { id: 'demo', kind: 'telegram', transport: 'demo', state: 'connected' },
      { id: 'wrong-kind', kind: 'email', transport: 'elozi-webchat', state: 'connected' },
      { id: 'site-unconfigured', kind: 'webchat', transport: 'elozi-webchat', state: 'connected' },
      { id: 'site-disabled', kind: 'webchat', transport: 'elozi-webchat', state: 'connected', webchat: { enabled: false, version: 1, origins: ['https://site.example.test'] } }
    );
  });
  const wire = { ...c.binding(), id: existing.id };
  assert.throws(() => c.config([wire]), status(400));
  for (const channelId of ['tg', 'demo', 'wrong-kind', 'site-unconfigured', 'site-disabled', 'missing']) {
    assert.throws(() => c.config([c.binding({ channelId, enabled: false })]), status(400), channelId);
  }
  const disabled = c.config([{ ...wire, enabled: false }]);
  assert.equal(disabled.bindings[0].id, existing.id); assert.equal(disabled.bindings[0].channelId, 'tg'); assert.equal(disabled.bindings[0].enabled, false);
  assert.equal(c.receive().outcome, 'no-match'); assert.deepEqual(c.conversation().tags, []); assert.equal(c.conversation().departmentId, 'support');
});

test('adaptador síncrono precisa estar disponível na configuração e de novo na entrada', t => {
  let available = false; const observations = [];
  const c = fixture(t, { channelAvailable: (tenantId, channel) => { observations.push([tenantId, channel.id]); return available; } });
  assert.throws(() => c.config([c.binding()]), status(400)); available = true;
  c.config([c.binding()]); available = false;
  const result = c.receive(); assert.equal(result.outcome, 'no-match'); assert.equal(result.applied, false);
  assert.deepEqual(c.conversation().tags, []); assert.equal(c.conversation().departmentId, 'support'); assert.equal(c.conversation().owner, 'queue');
  assert.ok(observations.length >= 3); assert.ok(observations.every(([tenantId, channelId]) => tenantId === c.tenant.id && channelId === 'tg'));
  const asyncAdapter = fixture(t, { channelAvailable: async () => true });
  assert.throws(() => asyncAdapter.config([asyncAdapter.binding()]), status(400), 'An unresolved promise cannot authorize routing');
});

test('entrada aplica a versão publicada fixada, uma rota e recibo atômico sem enviar resposta', t => {
  const c = fixture(t); c.config([c.binding(), c.binding({ name: 'Segundo vínculo' })]);
  const saved = c.flows.save(c.admin, c.tenant.id, c.flow.id, { version: 2, graph: graph('Versão nova') });
  c.flows.publish(c.admin, c.tenant.id, c.flow.id, { version: saved.version });
  const result = c.receive(), current = c.conversation();
  assert.equal(result.applied, true); assert.equal(result.flowVersion, 1); assert.equal(result.steps.filter(step => step.type === 'handoff').length, 1);
  assert.deepEqual(current.tags, ['Vendas']); assert.equal(current.departmentId, 'sales'); assert.equal(current.owner, 'queue');
  assert.equal(current.assignedUserId, null); assert.equal(current.agentId, null); assert.equal(current.version, 3);
  assert.equal(current.messages.filter(message => message.kind === 'human').length, 0);
  assert.equal(current.attendantEvents.length, 1); assert.equal(current.messages[0].automationReceipt.bindingId, result.bindingId);
  const replay = c.receive(); assert.equal(replay.replayed, true); assert.equal(replay.applied, false);
  assert.deepEqual(c.conversation(), current);
});

test('nó de handoff fora do ramo não cria evento nem altera responsabilidade', t => {
  const c = fixture(t); c.config([c.binding()]);
  c.store.mutate(c.admin, c.tenant.id, 'Texto sintético', state => { state.conversations[0].messages[0].text = 'Olá'; });
  assert.equal(c.receive().applied, true);
  const current = c.conversation(); assert.equal(current.departmentId, 'support'); assert.equal(current.owner, 'queue');
  assert.equal(current.attendantEvents, undefined); assert.deepEqual(current.tags, []);
  assert.deepEqual(current.messages[0].automationReceipt.steps.map(step => step.type), ['start', 'condition', 'end']);
});

test('automação da publicação legada mantém o ID aprovado após rename e reutilização do nome', t => {
  const c = fixture(t), operations = new Operations(c.store, c.auth);
  c.store.mutate(c.admin, c.tenant.id, 'Grafo legado sintético', state => {
    const flow = state.flows[0];
    delete flow.graph.departmentReferenceFormat; delete flow.versions[0].graph.departmentReferenceFormat;
    flow.graph.nodes.find(node => node.id === 'route').config.department = 'Comercial';
    flow.versions[0].graph.nodes.find(node => node.id === 'route').config.department = 'Comercial';
  });
  const published = c.flows.list(c.admin, c.tenant.id)[0]; c.config([c.binding()]);
  const configured = c.service.get(c.admin, c.tenant.id);
  operations.update(c.admin, c.tenant.id, 'sales', { version: 1, name: 'Vendas atuais' });
  const replacement = operations.create(c.admin, c.tenant.id, { name: 'Comercial' });
  const result = c.receive(), current = c.conversation();
  assert.equal(result.applied, true); assert.equal(result.flowVersion, 1);
  assert.equal(current.departmentId, 'sales'); assert.notEqual(current.departmentId, replacement.id); assert.equal(current.department, 'Vendas atuais');
  assert.equal(current.owner, 'queue'); assert.equal(current.assignedUserId, null); assert.equal(current.agentId, null); assert.equal(current.version, 3);
  assert.equal(current.attendantEvents.length, 1); assert.equal(current.attendantEvents[0].to.departmentId, 'sales');
  assert.equal(current.messages.filter(message => message.kind === 'human').length, 0);
  assert.deepEqual(c.service.get(c.admin, c.tenant.id), configured);
  const after = c.flows.list(c.admin, c.tenant.id)[0];
  assert.equal(after.version, published.version); assert.equal(after.publishedVersion, published.publishedVersion); assert.deepEqual(after.versions, published.versions);
  assert.equal(c.receive().replayed, true); assert.deepEqual(c.conversation(), current);
});

test('vínculo legado preservado não restaura departamento removido ou inativo nem autoridade revogada', t => {
  for (const restriction of ['deleted', 'inactive', 'authority-revoked']) {
    const c = fixture(t), operations = new Operations(c.store, c.auth);
    c.store.mutate(c.admin, c.tenant.id, 'Grafo legado sintético', state => {
      delete state.flows[0].graph.departmentReferenceFormat; delete state.flows[0].versions[0].graph.departmentReferenceFormat;
      state.flows[0].graph.nodes.find(node => node.id === 'route').config.department = 'Comercial';
      state.flows[0].versions[0].graph.nodes.find(node => node.id === 'route').config.department = 'Comercial';
    });
    c.config([c.binding()]); operations.update(c.admin, c.tenant.id, 'sales', { version: 1, name: 'Vendas atuais' });
    operations.create(c.admin, c.tenant.id, { name: 'Comercial' });
    if (restriction === 'deleted') c.store.mutate(c.admin, c.tenant.id, 'Remoção sintética', state => { state.departments = state.departments.filter(item => item.id !== 'sales'); });
    if (restriction === 'inactive') operations.update(c.admin, c.tenant.id, 'sales', { version: 2, active: false });
    if (restriction === 'authority-revoked') c.store.db.prepare('UPDATE auth_users SET disabled_at=? WHERE id=?').run(Date.parse(at), c.admin.userId);
    const previous = structuredClone(c.conversation()), result = c.receive(), current = c.conversation();
    assert.equal(result.applied, false, restriction); assert.equal(result.outcome, 'blocked', restriction);
    assert.equal(current.departmentId, previous.departmentId, restriction); assert.equal(current.department, previous.department, restriction);
    assert.equal(current.owner, 'queue'); assert.equal(current.assignedUserId, null); assert.equal(current.agentId, null); assert.equal(current.version, previous.version);
    assert.deepEqual(current.tags, previous.tags); assert.equal(current.attendantEvents, undefined);
    assert.equal(current.messages.length, previous.messages.length); assert.equal(current.messages[0].automationReceipt.applied, false);
  }
});

test('mensagens de saída, responsáveis humanos, copiloto, encerramento e CAS não são sobrescritos', t => {
  const c = fixture(t); c.config([c.binding()]);
  c.store.mutate(c.admin, c.tenant.id, 'Saída', state => { state.conversations[0].messages[0].kind = 'human'; });
  assert.equal(c.receive().outcome, 'not-incoming'); assert.equal(c.conversation().messages[0].automationReceipt, undefined);
  for (const [owner, assignedUserId, agentId, statusName] of [['human', 'person', null, 'open'], ['agent', null, 'agent', 'open'], ['queue', null, null, 'closed']]) {
    c.store.mutate(c.admin, c.tenant.id, 'Estado', state => { Object.assign(state.conversations[0], { owner, assignedUserId, agentId, status: statusName }); state.conversations[0].messages[0].kind = 'customer'; delete state.conversations[0].messages[0].automationReceipt; });
    assert.equal(c.receive().outcome, 'not-in-queue'); assert.equal(c.conversation().owner, owner); assert.equal(c.conversation().assignedUserId, assignedUserId);
  }
  c.store.mutate(c.admin, c.tenant.id, 'Nova revisão', state => { Object.assign(state.conversations[0], { owner: 'queue', assignedUserId: null, agentId: null, status: 'open', version: 7 }); delete state.conversations[0].messages[0].automationReceipt; });
  assert.equal(c.receive().outcome, 'conversation-changed'); assert.equal(c.conversation().version, 7); assert.deepEqual(c.conversation().tags, []);
});

test('autoridade revogada e falha tardia revertem todos os efeitos e gravam bloqueio sem retry', t => {
  const c = fixture(t); c.config([c.binding()]);
  c.store.db.prepare("UPDATE auth_users SET role='operator',tenant_ids=? WHERE id=?").run(JSON.stringify([c.tenant.id]), c.admin.userId);
  const blocked = c.receive(); assert.equal(blocked.outcome, 'blocked'); assert.equal(blocked.errorStatus, 403);
  assert.equal(c.conversation().departmentId, 'support'); assert.equal(c.conversation().version, 2); assert.equal(c.conversation().slaCycle.source, 'gateway-new-conversation');
  c.store.db.prepare("UPDATE auth_users SET role='reseller',tenant_ids='[]' WHERE id=?").run(c.admin.userId);
  c.store.mutate(c.admin, c.tenant.id, 'Remover recibo sintético', state => { delete state.conversations[0].messages[0].automationReceipt; });
  c.flows.routeOutput = (_actor, _id, _tenant, conversation) => { conversation.tags = ['Não persistir']; throw Object.assign(new Error('Permissão revogada'), { status: 403 }); };
  assert.equal(c.receive().outcome, 'blocked'); assert.deepEqual(c.conversation().tags, []); assert.equal(c.conversation().messages.length, 1);
  const receipt = c.conversation().messages[0].automationReceipt; assert.equal(c.receive().replayed, true); assert.deepEqual(c.conversation().messages[0].automationReceipt, receipt);
});

test('gatilhos por comando, nova conversa e calendário são determinísticos; fluxos arquivados ficam bloqueados', t => {
  const c = fixture(t), calendar = { timezone: 'America/Sao_Paulo', days: [4], start: '09:00', end: '18:00' };
  c.config([c.binding({ trigger: 'command', command: '/ajuda', calendar })]);
  assert.equal(c.receive().outcome, 'no-match');
  c.store.mutate(c.admin, c.tenant.id, 'Comando sintético', state => { state.conversations[0].messages[0].text = '/AJUDA@Elozi_bot plano'; delete state.conversations[0].messages[0].automationReceipt; });
  assert.equal(c.receive().applied, true);
  c.store.mutate(c.admin, c.tenant.id, 'Outra entrada', state => { const conversation = state.conversations[0]; conversation.messages.push({ id: 'm2', kind: 'customer', text: 'plano', createdAt: at }); conversation.version++; });
  c.config([c.binding({ trigger: 'new_conversation' })]);
  assert.equal(c.receive({ messageId: 'm2', conversationVersion: 4, newConversation: false }).outcome, 'no-match');
  c.config([c.binding({ calendar })]); c.clock('2026-10-01T22:00:00Z');
  c.store.mutate(c.admin, c.tenant.id, 'Entrada fora do horário', state => { state.conversations[0].messages.push({ id: 'm3', kind: 'customer', text: 'plano', createdAt: '2026-10-01T22:00:00Z' }); state.conversations[0].version++; });
  assert.equal(c.receive({ messageId: 'm3', conversationVersion: 5, newConversation: false }).outcome, 'no-match');
  c.clock(at); c.flows.remove(c.admin, c.tenant.id, c.flow.id, { version: c.flow.version });
  c.store.mutate(c.admin, c.tenant.id, 'Entrada após arquivar', state => { state.conversations[0].messages.push({ id: 'm4', kind: 'customer', text: 'plano', createdAt: at }); state.conversations[0].version++; });
  assert.equal(c.receive({ messageId: 'm4', conversationVersion: 6, newConversation: false }).outcome, 'flow-unavailable');
});

test('mesmo no-match é deduplicado e não executa retroativamente depois de ativar um vínculo', t => {
  const c = fixture(t);
  assert.equal(c.receive({ newConversation: false }).outcome, 'no-match');
  assert.equal(c.conversation().messages[0].automationReceipt.outcome, 'no-match');
  c.config([c.binding()]); const replay = c.receive({ newConversation: false });
  assert.equal(replay.replayed, true); assert.equal(replay.applied, false); assert.deepEqual(c.conversation().tags, []);
});

test('calendário IANA acumula tempo útil, fim de semana e segundos sem depender do timezone da máquina', () => {
  const calendar = normalizeCalendar({ timezone: 'America/Sao_Paulo', days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' });
  assert.equal(withinCalendar(calendar, Date.parse('2026-10-02T20:59:59Z')), true);
  assert.equal(withinCalendar(calendar, Date.parse('2026-10-02T21:00:00Z')), false);
  assert.equal(withinCalendar(calendar, Date.parse('2026-10-03T13:00:00Z')), false);
  assert.equal(businessDeadline('2026-10-02T20:50:30Z', 20, calendar), '2026-10-05T12:10:30.000Z');
  assert.equal(businessElapsedMinutes('2026-10-02T20:50:30Z', '2026-10-05T12:10:30Z', calendar), 20);
  assert.equal(businessElapsedMinutes('2024-01-01T00:00:00Z', at, calendar), null);
  assert.throws(() => normalizeCalendar({ ...calendar, timezone: 'Not/A_Zone' }), status(400));
  assert.throws(() => normalizeCalendar({ ...calendar, start: '18:00', end: '09:00' }), status(400));
  assert.throws(() => normalizeCalendar({ ...calendar, days: [] }), status(400));
});

test('calendário considera hora repetida e hora inexistente nas transições DST', () => {
  const spring = normalizeCalendar({ timezone: 'America/New_York', days: [0], start: '01:00', end: '04:00' });
  assert.equal(businessElapsedMinutes('2026-03-08T06:00:00Z', '2026-03-08T08:00:00Z', spring), 120);
  assert.equal(businessDeadline('2026-03-08T06:00:00Z', 120, spring), '2026-03-08T08:00:00.000Z');
  const missing = normalizeCalendar({ ...spring, start: '02:30' });
  assert.equal(businessElapsedMinutes('2026-03-08T06:00:00Z', '2026-03-08T08:00:00Z', missing), 60);
  const fall = normalizeCalendar({ ...spring, end: '03:00' });
  assert.equal(businessElapsedMinutes('2026-11-01T05:00:00Z', '2026-11-01T08:00:00Z', fall), 180);
  assert.equal(businessDeadline('2026-11-01T05:00:00Z', 180, fall), '2026-11-01T08:00:00.000Z');
});

test('SLA atual usa somente resposta confirmada e evento de encerramento; mídia humana também conta', t => {
  const c = fixture(t); c.config([]); c.receive();
  c.clock('2026-10-01T13:16:00Z');
  let row = c.service.sla(c.admin, c.tenant.id).conversations[0]; assert.equal(row.startedAt, at); assert.equal(row.firstReply.state, 'breached'); assert.equal(row.resolution.state, 'pending');
  c.store.mutate(c.admin, c.tenant.id, 'Respostas sintéticas', state => {
    const conversation = state.conversations[0];
    conversation.messages.push({ id: 'failed', kind: 'human', delivery: 'failed', text: 'Falhou', createdAt: '2026-10-01T13:01:00Z' });
    conversation.messages.push({ id: 'legacy', kind: 'human', text: 'Sem confirmação', createdAt: '2026-10-01T13:02:00Z' });
    conversation.messages.push({ id: 'media', kind: 'human', delivery: 'sent', media: { type: 'image' }, createdAt: '2026-10-01T13:10:00Z' });
    conversation.status = 'closed'; conversation.attendantEvents = [{ id: 'closed', type: 'closed', from: { status: 'open' }, to: { status: 'closed' }, createdAt: '2026-10-01T13:15:00Z' }];
  });
  row = c.service.sla(c.admin, c.tenant.id).conversations[0]; assert.equal(row.firstReply.state, 'met'); assert.equal(row.firstReply.completedAt, '2026-10-01T13:10:00.000Z'); assert.equal(row.resolution.state, 'met');
  c.store.mutate(c.admin, c.tenant.id, 'Legado sem evento', state => { state.conversations[0].attendantEvents = []; });
  assert.equal(c.service.sla(c.admin, c.tenant.id).conversations[0].resolution.state, 'insufficient-data');
});

test('reabertura observada ancora ciclo local mesmo com timestamp externo atrasado; legado não é inventado', t => {
  const c = fixture(t); c.config([]); c.receive(); c.clock('2026-10-02T13:00:00Z');
  c.store.mutate(c.admin, c.tenant.id, 'Reabertura sintética', state => {
    const conversation = state.conversations[0]; conversation.version = 3;
    conversation.messages.push({ id: 'm2', kind: 'customer', text: 'Mais uma dúvida', createdAt: '2026-10-02T12:58:00Z' });
    conversation.attendantEvents = [{ id: 'reopen-2', type: 'reopened', from: { status: 'closed' }, to: { status: 'open' }, createdAt: '2026-10-02T13:00:00Z' }];
  });
  assert.equal(c.service.sla(c.admin, c.tenant.id).conversations[0].coverage, 'insufficient-cycle');
  c.receive({ messageId: 'm2', conversationVersion: 3, newConversation: false, reopened: true });
  const row = c.service.sla(c.admin, c.tenant.id).conversations[0]; assert.equal(row.coverage, 'gateway-cycle'); assert.equal(row.startedAt, '2026-10-02T13:00:00.000Z'); assert.equal(row.firstReply.elapsedMinutes, 0);
  const marker = c.conversation().slaCycle; c.clock('2026-10-02T14:00:00Z'); c.receive({ messageId: 'm2', conversationVersion: 3, newConversation: false, reopened: true });
  assert.deepEqual(c.conversation().slaCycle, marker);
});

test('SLA filtra canal e departamento pelo acesso atual e exige indicadores e atendimento', t => {
  const c = fixture(t); c.config([]);
  const operator = c.user('scope-qa', 'operator', 'mep-demo', [c.tenant.id]);
  c.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ [c.tenant.id]: { channelIds: ['wa'], departmentIds: ['support'] } }), operator.userId);
  assert.equal(c.service.sla(operator, c.tenant.id).totals.tracked, 0);
  c.store.db.prepare('UPDATE auth_users SET scope_rules=? WHERE id=?').run(JSON.stringify({ [c.tenant.id]: { channelIds: ['tg'], departmentIds: ['support'] } }), operator.userId);
  assert.equal(c.service.sla(operator, c.tenant.id).totals.tracked, 1);
  c.store.db.prepare('UPDATE auth_users SET permissions=? WHERE id=?').run(JSON.stringify(['inbox.read']), operator.userId);
  assert.throws(() => c.service.sla(operator, c.tenant.id), status(403));
});

test('horários futuros não comprovam resposta ou encerramento antecipados', t => {
  const c = fixture(t); c.config([]); c.receive();
  c.store.mutate(c.admin, c.tenant.id, 'Dados futuros sintéticos', state => {
    const conversation = state.conversations[0]; conversation.status = 'closed';
    conversation.messages.push({ id: 'future', kind: 'human', delivery: 'sent', createdAt: '2026-10-01T13:05:00Z' });
    conversation.attendantEvents = [{ id: 'future-close', type: 'closed', from: { status: 'open' }, to: { status: 'closed' }, createdAt: '2026-10-01T13:06:00Z' }];
  });
  const row = c.service.sla(c.admin, c.tenant.id).conversations[0]; assert.equal(row.firstReply.state, 'pending'); assert.equal(row.firstReply.completedAt, null); assert.equal(row.resolution.state, 'insufficient-data');
});
