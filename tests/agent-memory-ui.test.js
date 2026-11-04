import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentMemoryUI } from '../public/agent-memory-ui.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity]));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const item = overrides => ({ id: 'fact-a', agentId: 'hermes-a', scope: 'contact', title: 'Preferência confirmada', content: 'Prefere atendimento pela manhã.', version: 1,
  status: 'active', expiresAt: null, expired: false, createdBy: 'Pessoa da equipe', reviewedBy: 'Pessoa da equipe', createdAt: '2026-10-03T12:00:00Z', updatedAt: '2026-10-03T12:00:00Z',
  origin: { conversationId: 'conversation-a', contactId: 'contact-a', channelId: 'channel-a', departmentId: 'department-a' }, ...overrides });

function setup(t, options = {}) {
  const before = globalThis.document, events = new Map(), mounted = [], calls = [], toasts = [], closeHandlers = [];
  const conversation = { id: 'conversation-a', contactId: 'contact-a', channelId: 'channel-a', departmentId: 'department-a', version: 3, status: 'open', owner: 'human', assignedUserId: 'user-a', agentId: null };
  const state = { workspaceId: 'workspace-a', view: 'inbox', conversation: conversation.id, boot: { csrfToken: 'synthetic-authority', session: { userId: 'user-a', resellerId: 'workspace-a', role: 'operator', permissions: ['inbox.read', 'inbox.reply', 'contacts.read', 'contacts.write'], scopeRules: null } },
    tenant: { id: 'tenant-a', name: 'Empresa própria', conversations: [conversation], channels: [{ id: 'channel-a', name: 'Canal próprio' }], departments: [{ id: 'department-a', name: 'Equipe própria' }],
      agents: [{ id: 'hermes-a', name: 'Hermes próprio', provider: 'hermes', mode: 'copilot', configured: true, version: 1 }, { id: 'hermes-b', name: 'Outro copiloto', provider: 'hermes', mode: 'copilot', configured: true, version: 1 }] } };
  let form = null, items = [item()], envelope = { canWrite: true, canManageOperation: false };
  const modal = { open: false, closes: 0, querySelector: selector => selector === '[data-dialog-form]' ? form : null,
    addEventListener(name, callback) { if (name === 'close') closeHandlers.push(callback); },
    close() { this.open = false; this.closes++; for (const callback of closeHandlers) callback(); } };
  function mount(title, description, kind, html, submitLabel) {
    if (form) { form.isConnected = false; form.submit.isConnected = false; }
    const fields = new Map(), submit = { disabled: false, hidden: false, isConnected: true }, conflict = { hidden: true, innerHTML: '', insertAdjacentHTML(_position, value) { this.innerHTML += value; } };
    for (const [, attrs] of html.matchAll(/<input\b([^>]*)>/g)) {
      const name = attrs.match(/\bname="([^"]+)"/)?.[1]; if (!name) continue;
      fields.set(name, { name, value: decode(attrs.match(/\bvalue="([^"]*)"/)?.[1] || (attrs.includes('checkbox') ? 'on' : '')), checked: /\bchecked\b/.test(attrs), type: attrs.match(/type="([^"]+)"/)?.[1] || 'text', disabled: /\bdisabled\b/.test(attrs) });
    }
    for (const [, attrs, content] of html.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g)) {
      const name = attrs.match(/name="([^"]+)"/)?.[1]; if (name) fields.set(name, { name, value: decode(content), type: 'textarea', disabled: false });
    }
    for (const [, attrs, body] of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/g)) {
      const name = attrs.match(/name="([^"]+)"/)?.[1]; if (!name) continue;
      const entries = [...body.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map(([, opts, label]) => ({ value: decode(opts.match(/value="([^"]*)"/)?.[1] || ''), selected: /\bselected\b/.test(opts), label }));
      fields.set(name, { name, value: entries.find(e => e.selected)?.value || entries[0]?.value || '', type: 'select', options: entries, disabled: /\bdisabled\b/.test(attrs) });
    }
    const captured = { dataset: { dialogForm: kind }, isConnected: true, fields, submit, conflict, html, title, description, submitLabel,
      querySelector(selector) { return selector === '.memory-conflict' ? conflict : selector === '[type="submit"]' ? submit : null; },
      replaceChildren() { this.html = ''; this.fields.clear(); this.conflict.innerHTML = ''; },
      get innerHTML() { return this.html; }, set innerHTML(value) { this.html = value; },
      elements: { namedItem: name => fields.get(name) || null } };
    for (const field of fields.values()) { field.closest = selector => selector === '[data-dialog-form]' ? captured : null; field.matches = selector => selector === '[data-memory-agent]' && field.name === 'memoryAgent'; }
    form = captured; modal.open = true; mounted.push(captured); return captured;
  }
  globalThis.document = { querySelector: selector => selector === '#modal' ? modal : null, addEventListener(name, callback) { events.set(name, callback); } };
  t.after(() => { globalThis.document = before; });
  const normal = (path, config = {}) => {
    const body = config.body ? JSON.parse(config.body) : null, agentId = new URL('http://synthetic.invalid' + path).searchParams.get('agentId') || body?.agentId || 'hermes-a';
    if (config.method === 'GET') return { ...envelope, items: items.filter(i => i.agentId === agentId).map(i => structuredClone(i)) };
    if (config.method === 'POST' && !path.endsWith('/archive') && !path.endsWith('/reactivate')) { const created = item({ id: 'fact-new', agentId: body.agentId, scope: body.scope, title: body.title, content: body.content, expiresAt: body.expiresAt }); items.push(created); return structuredClone(created); }
    const old = items.find(i => path.includes('/' + i.id)); assert.ok(old, 'Existing synthetic fact');
    if (path.endsWith('/archive')) Object.assign(old, { version: old.version + 1, status: 'archived' });
    else if (path.endsWith('/reactivate')) Object.assign(old, { version: old.version + 1, status: 'active' });
    else Object.assign(old, { ...body, version: old.version + 1, expired: false });
    return structuredClone(old);
  };
  const ui = createAgentMemoryUI({ state, escape, attr: escape, icon: name => `<svg data-icon="${escape(name)}"></svg>`,
    tenantApi: path => `/api/tenants/${state.tenant.id}/${path}`, formModal: mount, closeModal: () => modal.close(), toast: (...args) => toasts.push(args),
    api: async (path, config = {}) => { calls.push({ path, config, body: config.body ? JSON.parse(config.body) : null }); return options.respond ? options.respond(path, config, normal) : normal(path, config); } });
  return { ui, state, conversation, calls, mounted, modal, toasts, events, mount, normal,
    get form() { return form; }, get items() { return items; }, set items(value) { items = value; }, set envelope(value) { envelope = value; },
    el(id = '') { return { dataset: { id }, closest: () => form }; },
    data(values = {}) { const data = new FormData(); for (const field of form.fields.values()) if (!field.disabled && (field.type !== 'checkbox' || field.checked)) data.set(field.name, field.value); for (const [k,v] of Object.entries(values)) if (v === null) data.delete(k); else data.set(k, v); return data; },
    field(name, value) { const field = form.fields.get(name); assert.ok(field, 'Editor field ' + name); if (field.type === 'checkbox') field.checked = value; else field.value = value; },
    async open() { return ui.open(conversation); }, async act(name, id) { return ui.action(name, this.el(id)); },
    async save(values) { return ui.submit(form.dataset.dialogForm, this.data(values), form); } };
}

test('own memory catalog uses scoped GET and displays escaped cards without granting operation controls', async t => {
  const h = setup(t); h.items = [item({ title: '<img onerror="alert(1)">', content: '<script>privado</script>\n![file](https://unsafe.invalid)' })];
  await h.open();
  assert.equal(h.calls[0].path, '/api/tenants/tenant-a/conversations/conversation-a/memories?agentId=hermes-a');
  assert.equal(h.calls[0].config.headers['X-Elozi-Workspace'], 'workspace-a');
  assert(h.form.html.includes('&lt;script&gt;privado&lt;/script&gt;')); assert(!h.form.html.includes('<img onerror')); assert(!h.form.html.includes('<script>'));
  assert(h.form.html.includes('De cliente')); assert(h.form.html.includes('Canal próprio')); assert(h.form.submit.hidden); assert(h.form.submit.disabled);
  await h.act('memory-new'); assert(!h.form.html.includes('value="operation"')); assert(h.form.html.includes('name="reviewed" required'));
});

test('catalog empty state and configured Hermes copilot picker do not manufacture facts', async t => {
  const h = setup(t); h.items = []; h.state.tenant.agents.push({ id: 'not-configured', provider: 'hermes', mode: 'copilot', configured: false }, { id: 'autonomous', provider: 'hermes', mode: 'autonomous', configured: true }, { id: 'other-provider', provider: 'other', mode: 'copilot', configured: true });
  await h.open(); assert(h.form.html.includes('Nenhum fato salvo')); assert(!h.form.html.includes('not-configured')); assert(!h.form.html.includes('autonomous')); assert(!h.form.html.includes('other-provider'));
  assert.equal(h.calls.length, 1);
});

test('create submits only reviewed authoritative context fields and preserves multiline literal content', async t => {
  const h = setup(t); await h.open(); await h.act('memory-new');
  await assert.rejects(h.save({ title: 'Fato', content: 'Confirmado', reviewed: null }), /autorize/); assert.equal(h.calls.length, 1);
  await h.save({ title: ' Preferência ', content: 'Texto <literal>\nsegunda linha', reviewed: 'on', agentId: 'forged-agent', tenantId: 'forged-tenant', version: '999', conversationVersion: '999', context: 'forbidden', memorySnapshot: 'forbidden', endpoint: 'forbidden' });
  assert.deepEqual(h.calls[1].body, { conversationVersion: 3, agentId: 'hermes-a', scope: 'contact', title: 'Preferência', content: 'Texto <literal>\nsegunda linha', expiresAt: null, reviewed: true });
  assert.equal(h.calls[1].config.method, 'POST'); assert(!h.calls[1].path.includes('forged'));
  assert(h.form.html.includes('Texto &lt;literal&gt;')); assert.equal(h.toasts.length, 1);
});

test('local datetime is converted to ISO, empty validity remains null and invalid/past values cause no request', async t => {
  const h = setup(t); await h.open(); await h.act('memory-new');
  for (const expiresAt of ['2027-02-30T09:00', '2000-01-01T00:00', 'not-a-date']) await assert.rejects(h.save({ title: 'Fato', content: 'Confirmado', reviewed: 'on', expiresAt }), /validade|data e hora/);
  assert.equal(h.calls.length, 1);
  const tooLate = new Date(Date.now() + 366 * 86400000).toISOString().slice(0, 16);
  await assert.rejects(h.save({ title: 'Fato', content: 'Confirmado', reviewed: 'on', expiresAt: tooLate }), /365 dias/);
  const later = new Date(Date.now() + 30 * 86400000), pad = n => String(n).padStart(2, '0');
  const future = `${later.getFullYear()}-${pad(later.getMonth()+1)}-${pad(later.getDate())}T${pad(later.getHours())}:${pad(later.getMinutes())}`;
  await h.save({ title: 'Fato', content: 'Confirmado', reviewed: 'on', expiresAt: future }); assert.equal(h.calls[1].body.expiresAt, new Date(future).toISOString());
});

test('operation permission requires both server capability and current administrative role', async t => {
  const h = setup(t); h.envelope = { canWrite: true, canManageOperation: true }; await h.open(); await h.act('memory-new');
  await assert.rejects(h.save({ title: 'Global', content: 'Texto', scope: 'operation', reviewed: 'on' }), /gestão/); assert.equal(h.calls.length, 1);
  h.ui.reset(); h.state.boot.session.role = 'reseller'; await h.open(); await h.act('memory-new'); assert(h.form.html.includes('value="operation"'));
  await h.save({ title: 'Operação', content: 'Fato da operação', scope: 'operation', reviewed: 'on' }); assert.equal(h.calls.at(-2).body.scope, 'operation');
});

for (const [name, alter] of Object.entries({ withoutContact: h => { h.conversation.contactId = null; }, otherResponsible: h => { h.conversation.assignedUserId = 'other-human'; } })) test(`operation-only admin can create reviewed facts ${name} without granting client writes`, async t => {
  const h = setup(t); h.state.boot.session.role = 'reseller'; alter(h); h.items = []; h.envelope = { canWrite: false, canManageOperation: true };
  await h.open(); assert(h.form.html.includes('data-action="memory-new"')); await h.ui.action('memory-new', '');
  assert.equal(h.form.fields.get('scope').value, 'operation'); assert(!h.form.html.includes('value="contact"'));
  await assert.rejects(h.save({ title: 'Cliente', content: 'Forçado', scope: 'contact', reviewed: 'on' }), /cliente/); assert.equal(h.calls.length, 1);
  await h.save({ title: 'Operação', content: 'Revisado pela gestão', reviewed: 'on' });
  assert.deepEqual(h.calls[1].body, { conversationVersion: 3, agentId: 'hermes-a', scope: 'operation', title: 'Operação', content: 'Revisado pela gestão', expiresAt: null, reviewed: true });
});

test('operation-only admin can update/archive/reactivate operation cards while client cards remain readonly', async t => {
  const h = setup(t); h.state.boot.session.role = 'reseller'; h.envelope = { canWrite: false, canManageOperation: true };
  h.items = [item(), item({ id: 'operation-a', scope: 'operation' })]; await h.open();
  assert(!h.form.html.includes('data-id="fact-a"')); assert(h.form.html.includes('data-id="operation-a"'));
  await assert.rejects(h.act('memory-edit', 'fact-a'), /acesso/); await h.ui.action('memory-edit', 'operation-a');
  await h.save({ title: 'Operação atual', content: 'Fato atual', reviewed: 'on' });
  await h.act('memory-archive', 'operation-a'); await h.save();
  await h.act('memory-reactivate', 'operation-a'); await h.save({ reviewed: 'on' });
  const mutations = h.calls.filter(c => c.config.method !== 'GET');
  assert.deepEqual(mutations.map(c => c.config.method), ['PATCH','POST','POST']);
  assert(mutations.every(c => c.path.includes('/operation-a'))); assert.equal(h.items[1].status, 'active'); assert.equal(h.items[1].version, 4);
});

test('operation authority revoked during 409 reconciliation discards operation draft independently of contact authority', async t => {
  const h = setup(t, { respond: (path, config, normal) => { if (config.method === 'PATCH') { h.envelope = { canWrite: true, canManageOperation: false }; throw Object.assign(Error('Mudou'), { status: 409 }); } return normal(path, config); } });
  h.state.boot.session.role = 'reseller'; h.envelope = { canWrite: false, canManageOperation: true }; h.items = [item({ scope: 'operation' })];
  await h.open(); await h.act('memory-edit', 'fact-a'); await assert.rejects(h.save({ title: 'Rascunho operação', content: 'Privado rascunho', reviewed: 'on' }), error => error.status === 409);
  assert(!h.form.html.includes('Privado rascunho')); assert(!h.form.html.includes('data-id="fact-a"')); assert(h.form.html.includes('data-action="memory-new"'));
});

test('update preserves captured fact/version and cannot accept browser-supplied scope or authority', async t => {
  const h = setup(t); await h.open(); await h.act('memory-edit', 'fact-a');
  await h.save({ title: 'Título novo', content: 'Texto novo', scope: 'operation', reviewed: 'on', id: 'other-id', version: '99', conversationVersion: '99', agentId: 'other-agent' });
  assert.deepEqual(h.calls[1].body, { conversationVersion: 3, version: 1, title: 'Título novo', content: 'Texto novo', expiresAt: null, reviewed: true });
  assert.equal(h.calls[1].config.method, 'PATCH'); assert(h.calls[1].path.endsWith('/memories/fact-a'));
});

test('obsolete form A cannot submit its text into editor B after awaiting another hook of the same form kind', async t => {
  const h = setup(t), hook = deferred(); h.items = [item(), item({ id: 'fact-b', title: 'Fato B', content: 'Texto B original', version: 7 })];
  await h.open(); await h.act('memory-edit', 'fact-a'); const formA = h.form, dataA = h.data({ title: 'Rascunho A', content: 'Texto privado A', reviewed: 'on' });
  const submittedA = (async () => { await hook.promise; return h.ui.submit(formA.dataset.dialogForm, dataA, formA); })();
  await h.act('memory-edit', 'fact-b'); const formB = h.form; h.field('title', 'Rascunho B'); h.field('content', 'Texto privado B'); h.field('reviewed', true);
  assert.equal(formA.dataset.dialogForm, formB.dataset.dialogForm); hook.resolve();
  await assert.rejects(submittedA, /A janela mudou/);
  assert.equal(h.calls.length, 1); assert.equal(h.form, formB); assert.equal(h.ui.syncContext(), true); assert(!formB.submit.disabled);
  assert.equal(formB.fields.get('title').value, 'Rascunho B'); assert.equal(formB.fields.get('content').value, 'Texto privado B'); assert(formB.fields.get('reviewed').checked);
  await h.save(); assert(h.calls[1].path.endsWith('/fact-b')); assert.equal(h.calls[1].body.version, 7); assert.equal(h.calls[1].body.content, 'Texto privado B');
});

test('missing, foreign, disconnected or wrong-kind source form is rejected before reading draft fields', async t => {
  const h = setup(t); await h.open(); await h.act('memory-edit', 'fact-a'); const form = h.form; let reads = 0;
  const unread = { get() { reads++; throw Error('Must not read obsolete draft'); } };
  await assert.rejects(h.ui.submit('memory-update', unread), /A janela mudou/);
  await assert.rejects(h.ui.submit('memory-update', unread, { ...form }), /A janela mudou/);
  form.isConnected = false; await assert.rejects(h.ui.submit('memory-update', unread, form), /A janela mudou/); form.isConnected = true;
  await assert.rejects(h.ui.submit('memory-create', unread, form), /A janela mudou/);
  assert.equal(reads, 0); assert.equal(h.calls.length, 1); assert.equal(h.form, form); assert.equal(h.ui.syncContext(), true);
});

test('archive keeps content and reactivation requires a new explicit review', async t => {
  const h = setup(t); await h.open(); await h.act('memory-archive', 'fact-a'); assert(h.form.html.includes('conteúdo e a autoria permanecem'));
  await h.save(); assert.deepEqual(h.calls[1].body, { conversationVersion: 3, version: 1 }); assert(h.calls[1].path.endsWith('/fact-a/archive'));
  assert.equal(h.items[0].content, 'Prefere atendimento pela manhã.'); assert(h.form.html.includes('Arquivado'));
  await h.act('memory-reactivate', 'fact-a'); await assert.rejects(h.save(), /autorize/);
  await h.save({ reviewed: 'on' }); assert.deepEqual(h.calls[3].body, { conversationVersion: 3, version: 2, reviewed: true }); assert(h.calls[3].path.endsWith('/fact-a/reactivate'));
});

test('expired archived fact must be edited before reactivation and does not expose direct reactivate', async t => {
  const h = setup(t); h.items = [item({ status: 'archived', expired: true, expiresAt: '2020-01-01T00:00:00Z' })]; await h.open();
  assert(!h.form.html.includes('data-action="memory-reactivate"')); await assert.rejects(h.act('memory-reactivate', 'fact-a'), /validade/); assert.equal(h.calls.length, 1);
  await h.act('memory-edit', 'fact-a'); await h.save({ title: 'Preferência confirmada', content: 'Texto revisado', expiresAt: '', reviewed: 'on' });
  assert.equal(h.items[0].status, 'archived'); assert.equal(h.items[0].expired, false); await h.act('memory-reactivate', 'fact-a'); await h.save({ reviewed: 'on' });
  assert.equal(h.items[0].status, 'active');
});

test('409 refreshes current facts without replacing draft and requires review before retry', async t => {
  let conflict = true;
  const h = setup(t, { respond: (path, config, normal) => { if (config.method === 'PATCH' && conflict) { conflict = false; h.items[0].version = 2; h.items[0].content = 'Versão concorrente <segura>'; h.conversation.version = 4; throw Object.assign(Error('CAS mudou'), { status: 409 }); } return normal(path, config); } });
  await h.open(); await h.act('memory-edit', 'fact-a'); const form = h.form; h.field('title', 'Meu título'); h.field('content', 'Meu rascunho <próprio>'); h.field('reviewed', true);
  await assert.rejects(h.save(), error => error.status === 409);
  assert.equal(h.form, form); assert.equal(h.form.fields.get('content').value, 'Meu rascunho <próprio>'); assert(h.form.conflict.innerHTML.includes('Versão concorrente &lt;segura&gt;')); assert.equal(h.calls.length, 3); assert(h.form.submit.disabled);
  await assert.rejects(h.save(), /versão atual/); assert.equal(h.calls.length, 3);
  await h.act('memory-review'); assert.equal(h.form.fields.get('content').value, 'Meu rascunho <próprio>'); assert.equal(h.form.fields.get('reviewed').checked, false);
  await assert.rejects(h.save(), /autorize/); await h.save({ reviewed: 'on' });
  assert.equal(h.calls[3].body.version, 2); assert.equal(h.calls[3].body.conversationVersion, 4); assert.equal(h.calls[3].body.content, 'Meu rascunho <próprio>');
});

test('conversation polling version alone keeps editor and original CAS until an explicit conflict review', async t => {
  const h = setup(t); await h.open(); await h.act('memory-edit', 'fact-a'); const form = h.form;
  h.conversation.version = 4; assert.equal(h.ui.syncContext(), true); assert.equal(h.form, form);
  await h.save({ title: 'Fato', content: 'Texto', reviewed: 'on' }); assert.equal(h.calls[1].body.conversationVersion, 3);
});

test('uncertain mutation never auto-replays; draft is locked until explicit read and review', async t => {
  const h = setup(t, { respond: (path, config, normal) => { if (config.method === 'PATCH') throw Error('Resposta perdida'); return normal(path, config); } });
  await h.open(); await h.act('memory-edit', 'fact-a');
  await assert.rejects(h.save({ title: 'Meu fato', content: 'Meu texto', reviewed: 'on' }), /perdida/); assert.equal(h.calls.length, 2);
  await assert.rejects(h.save(), /versão atual/); assert.equal(h.calls.length, 2); await h.act('memory-refresh'); assert.equal(h.calls.length, 3);
  await h.act('memory-review'); assert.equal(h.form.fields.get('content').value, 'Meu texto'); assert(!h.form.fields.get('reviewed').checked);
});

for (const [name, change] of Object.entries({
  workspace: h => { h.state.workspaceId = 'workspace-b'; }, company: h => { h.state.tenant.id = 'tenant-b'; },
  user: h => { h.state.boot.session.userId = 'user-b'; }, authority: h => { h.state.boot.session.permissions = ['inbox.read']; },
  conversation: h => { h.state.conversation = 'conversation-b'; }, contact: h => { h.conversation.contactId = 'contact-b'; },
  channel: h => { h.conversation.channelId = 'channel-b'; }, department: h => { h.conversation.departmentId = 'department-b'; },
  responsible: h => { h.conversation.assignedUserId = 'user-b'; }, agent: h => { h.state.tenant.agents[0].configured = false; }
})) test(`late GET cannot reopen memory after ${name} changes; sync clears owned private DOM`, async t => {
  const gate = deferred(), h = setup(t, { respond: () => gate.promise }); const pending = h.open(), form = h.form;
  change(h); assert.equal(h.ui.syncContext(), false); assert.equal(form.html, ''); assert.equal(h.modal.open, false);
  gate.resolve({ items: [item({ content: 'Privado tardio' })], canWrite: true, canManageOperation: false }); await pending;
  assert.equal(h.mounted.length, 1); assert.equal(h.form.html, '');
});

test('late mutation after context change cannot render old private content or toast a success', async t => {
  const gate = deferred(), h = setup(t, { respond: (path, config, normal) => config.method === 'PATCH' ? gate.promise : normal(path, config) });
  await h.open(); await h.act('memory-edit', 'fact-a'); const pending = h.save({ title: 'Fato', content: 'Texto', reviewed: 'on' });
  h.state.tenant.id = 'tenant-b'; h.ui.syncContext(); gate.resolve(item({ title: 'Fato', content: 'Texto', version: 2 })); await pending;
  assert.equal(h.form.html, ''); assert.equal(h.toasts.length, 0); assert.equal(h.calls.length, 2);
});

test('another modal survives a late memory response and reset does not erase its draft', async t => {
  const gate = deferred(), h = setup(t, { respond: () => gate.promise }); const pending = h.open();
  const other = h.mount('Outro editor', 'Próprio', 'other', '<textarea name="content">Rascunho de outra tarefa</textarea>', 'Salvar');
  gate.resolve({ items: [item()], canWrite: true, canManageOperation: false }); await pending; h.ui.reset();
  assert.equal(h.form, other); assert.equal(h.form.fields.get('content').value, 'Rascunho de outra tarefa'); assert.equal(h.modal.open, true);
});

test('switching selected agent clears previous content and stale earlier response cannot overwrite new list', async t => {
  const old = deferred(), next = deferred(); let calls = 0;
  const h = setup(t, { respond: () => (++calls === 1 ? old.promise : next.promise) }); const first = h.open();
  const choice = h.form.fields.get('memoryAgent'); choice.value = 'hermes-b'; const second = h.ui.action('memory-agent', choice);
  old.resolve({ items: [item({ content: 'Agente antigo privado' })], canWrite: true, canManageOperation: false }); await first;
  next.resolve({ items: [item({ id: 'fact-b', agentId: 'hermes-b', content: 'Agente atual' })], canWrite: true, canManageOperation: false }); await second;
  assert(h.form.html.includes('Agente atual')); assert(!h.form.html.includes('Agente antigo privado')); assert(h.calls[1].path.includes('agentId=hermes-b'));
});

test('native modal close clears both private editor DOM and pending state', async t => {
  const h = setup(t); await h.open(); await h.act('memory-edit', 'fact-a'); const form = h.form; h.modal.close();
  assert.equal(form.html, ''); assert.equal(h.ui.syncContext(), false); await assert.rejects(h.save({ reviewed: 'on' }), /novamente/);
});

for (const status of [401,403,404]) test(`fresh ${status} during a mutation closes private modal and cannot retain stale facts`, async t => {
  const h = setup(t, { respond: (path, config, normal) => { if (config.method === 'PATCH') throw Object.assign(Error('Sem acesso'), { status }); return normal(path, config); } });
  await h.open(); await h.act('memory-edit', 'fact-a'); await h.save({ title: 'Fato', content: 'Texto', reviewed: 'on' });
  assert.equal(h.modal.open, false); assert.equal(h.form.html, ''); assert.equal(h.toasts.length, 0);
});

test('server write revocation while reconciling removes private edit draft and shows only fresh readonly catalog', async t => {
  const h = setup(t, { respond: (path, config, normal) => { if (config.method === 'PATCH') { h.envelope = { canWrite: false, canManageOperation: false }; throw Object.assign(Error('Mudou'), { status: 409 }); } return normal(path, config); } });
  await h.open(); await h.act('memory-edit', 'fact-a'); await assert.rejects(h.save({ title: 'Rascunho antigo', content: 'Texto não autorizado', reviewed: 'on' }), error => error.status === 409);
  assert(!h.form.html.includes('Texto não autorizado')); assert(!h.form.html.includes('memory-new')); assert(h.form.html.includes('Preferência confirmada'));
});

test('malformed catalog, cross-agent DTO and duplicate facts fail closed without displaying data', async t => {
  for (const data of [{ items: null, canWrite: true, canManageOperation: false }, { items: [item({ agentId: 'hermes-other', content: 'Privado proibido' })], canWrite: true, canManageOperation: false }, { items: [item(),item()], canWrite: true, canManageOperation: false }]) {
    const h = setup(t, { respond: () => data }); await assert.rejects(h.open(), /consulta|servidor|repetidos/); assert(!h.form.html.includes('Privado proibido')); h.ui.reset();
  }
});

test('mutation receipt mismatch locks editor and makes no blind replay', async t => {
  const h = setup(t, { respond: (path, config, normal) => config.method === 'PATCH' ? item({ id: 'wrong-id', version: 2 }) : normal(path, config) });
  await h.open(); await h.act('memory-edit', 'fact-a'); await assert.rejects(h.save({ title: 'Fato', content: 'Texto', reviewed: 'on' }), /recibo/);
  assert.equal(h.calls.length, 2); assert(h.form.submit.disabled); await assert.rejects(h.save(), /versão atual/); assert.equal(h.calls.length, 2);
});

test('run memory receipts show escaped metadata only and hide revoked pins/content', t => {
  const h = setup(t), run = { memoryReferences: [{ id: '<id>', title: '<svg onload=attack()>', scope: 'contact', version: 2, content: 'PRIVADO nunca renderizar', excerpt: 'também privado', publicationHash: 'hash-privado' }] };
  const html = h.ui.runReferences(run); assert(html.includes('&lt;svg')); assert(html.includes('&lt;id&gt;')); assert(html.includes('v2')); assert(!html.includes('PRIVADO')); assert(!html.includes('hash-privado')); assert(!html.includes('<svg onload'));
  const unavailable = h.ui.runReferences({ ...run, memoryUnavailable: true }); assert(unavailable.includes('não está mais disponível')); assert(!unavailable.includes('&lt;id&gt;'));
  assert.equal(h.ui.runReferences({ memoryReferences: [] }), ''); assert.equal(h.ui.runReferences({ memoryReferences: [{ id: 'a', title: 'x', scope: 'invalid', version: 1 }] }), '');
  const generic = h.ui.runReferences({ memoryReferences: [{ id: 'fact-own', scope: 'contact', version: 2 }, { id: 'operation-own', scope: 'operation', version: 1 }] });
  assert(generic.includes('Fato de cliente')); assert(generic.includes('Fato da operação')); assert(generic.includes('fact-own'));
});

test('invalid or overlong draft, readonly catalog and stale foreign-form action never mutate', async t => {
  const h = setup(t); await h.open(); await h.act('memory-new');
  for (const values of [{ title: 'x', content: 'x'.repeat(1501), reviewed: 'on' }, { title: 'x'.repeat(101), content: 'x', reviewed: 'on' }, { title: '', content: 'x', reviewed: 'on' }, { title: 'Título\nindevido', content: 'x', reviewed: 'on' }, { title: 'x', content: '\0', reviewed: 'on' }]) await assert.rejects(h.save(values), /título|fato/);
  assert.equal(h.calls.length, 1); await assert.rejects(h.ui.action('memory-new', { closest: () => ({}) }), /outra janela/);
  h.ui.reset(); h.envelope = { canWrite: false, canManageOperation: false }; await h.open(); await assert.rejects(h.act('memory-new'), /acesso/); assert.equal(h.calls.length, 2);
});
