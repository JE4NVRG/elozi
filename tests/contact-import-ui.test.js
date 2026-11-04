import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContactImportUI } from '../public/contact-import-ui.js';
import { Store } from '../src/store.js';
import { ContactImportService } from '../src/contact-import.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const row = extra => ({ row: 1, status: 'valid', name: 'Pessoa sintética', phone: '5511987654321', email: '', tags: [], ...extra });
const preview = extra => ({ previewId: 'synthetic-preview', hash: 'a'.repeat(64), version: 'b'.repeat(64), channelId: 'wa-a', counts: { total: 1, valid: 1, duplicate: 0, conflict: 0, invalid: 0 }, rows: [row()], truncated: false, ...extra });
const receipt = { imported: 1, duplicate: 0, conflict: 0, invalid: 0, contactIds: ['synthetic-contact'] };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function setup(overrides = {}) {
  const context = { workspaceId: 'workspace-1', tenantId: 'tenant-1', canWrite: true, channels: [{ id: 'wa-a', name: 'Agenda MEPChat', kind: 'whatsapp_qr', state: 'planned' }, { id: 'wa-b', name: 'Segundo canal', kind: 'whatsapp_cloud' }, { id: 'tg', name: 'Telegram', kind: 'telegram' }] };
  const modals = [], calls = [], toasts = [], refreshes = [];
  const params = { getContext: () => context, request: async (path, options) => { calls.push({ path, options }); return path.endsWith('/preview') ? preview() : receipt; }, openModal: (...args) => modals.push(args), escape, icon: name => `<svg data-icon="${name}"></svg>`, refresh: async tenantId => refreshes.push(tenantId), toast: (...args) => toasts.push(args), ...overrides };
  const ui = createContactImportUI(params);
  const html = () => modals.at(-1)?.[2] || '';
  const form = (mode = 'preview', values = {}) => {
    const generation = /data-contact-import-session="(\d+)"/.exec(html())?.[1];
    const fields = { channelId: { name: 'channelId', value: 'wa-a' }, content: { name: 'content', value: JSON.stringify([{ name: 'Pessoa sintética', phone: '11987654321' }]) }, file: { name: 'file', value: '', files: [] }, preserveInvalid: { name: 'preserveInvalid', type: 'checkbox', checked: false } };
    for (const [name, value] of Object.entries(values)) Object.assign(fields[name], typeof value === 'object' ? value : { value });
    const result = { dataset: { contactImportForm: mode, contactImportSession: generation }, isConnected: true, elements: { namedItem: name => fields[name] }, querySelector: selector => fields[/\[name="([^"]+)"\]/.exec(selector)?.[1]] || null };
    for (const value of Object.values(fields)) value.form = result;
    return result;
  };
  return { ui, context, params, calls, toasts, refreshes, modals, html, form };
}

test('planned WhatsApp channel is selectable; scoped choices and source inputs are accessible', () => {
  const f = setup(); assert.equal(f.ui.open(), true);
  assert.match(f.html(), /Agenda MEPChat/); assert.match(f.html(), /Segundo canal/); assert.doesNotMatch(f.html(), /Telegram/);
  assert.match(f.html(), /name="file" type="file" accept="\.csv,\.json/);
  assert.match(f.html(), /Canal de destino nesta empresa/); assert.match(f.html(), /Selecione o canal correspondente à origem/);
  assert.match(f.html(), /Ou colar uma lista JSON/); assert.match(f.html(), /role="alert"/); assert.match(f.html(), /aria-live="polite"/);
  assert.match(f.html(), /name="preserveInvalid"\s+\/>Preservar telefones inválidos/);
  f.context.canWrite = channelId => channelId === 'wa-a'; f.ui.open(); assert.doesNotMatch(f.html(), /Segundo canal/);
  f.context.canWrite = false; assert.equal(f.ui.open(), false); assert.equal(f.toasts.at(-1)[1], true);
});

test('preview and explicit apply pin company/workspace and update only after confirmation', async () => {
  const f = setup(); f.ui.open();
  await f.ui.submit(f.form());
  assert.equal(f.calls.length, 1); assert.match(f.calls[0].path, /^\/api\/tenants\/tenant-1\/contacts\/import\/preview$/);
  const input = JSON.parse(f.calls[0].options.body); assert.equal(input.channelId, 'wa-a'); assert.equal(input.format, 'json');
  assert.equal(input.preserveInvalid, false);
  assert.equal(f.calls[0].options.headers['X-Elozi-Workspace'], 'workspace-1');
  assert.match(f.html(), /Confirmar importação de 1/); assert.equal(f.refreshes.length, 0);
  await f.ui.submit(f.form('apply'));
  assert.deepEqual(JSON.parse(f.calls[1].options.body), { previewId: 'synthetic-preview', hash: 'a'.repeat(64), version: 'b'.repeat(64) });
  assert.deepEqual(f.refreshes, ['tenant-1']); assert.match(f.html(), /Importação concluída/);
  assert.match(f.html(), /Nenhuma mensagem foi enviada e nenhum atendimento foi aberto/);
  assert.doesNotMatch(f.html(), /Pessoa sintética|synthetic-contact|textarea|type="file"/);
  await f.ui.submit(f.form('apply')); assert.equal(f.calls.length, 2);
});

test('bounded escaped preview keeps complete counts and never trusts returned executable markup', async () => {
  const malicious = row({ name: '<script>bad()</script>', phone: '<img src=x onerror=bad()>', email: '" onclick="bad()', tags: ['<svg onload=bad()>'], reason: '<iframe src=bad>' });
  const f = setup({ request: async () => preview({ counts: { total: 9544, valid: 9541, duplicate: 1, conflict: 1, invalid: 1 }, rows: Array.from({ length: 150 }, (_, index) => index ? row({ name: `Pessoa ${index}` }) : malicious), truncated: true }) });
  f.ui.open(); await f.ui.submit(f.form());
  assert.match(f.html(), /9\.544 registros analisados · exibindo os primeiros 100/); assert.match(f.html(), /Confirmar importação de 9\.541/);
  assert.match(f.html(), /&lt;script&gt;bad\(\)&lt;\/script&gt;/); assert.match(f.html(), /&lt;img src=x onerror=bad\(\)&gt;/);
  assert.match(f.html(), /&lt;svg onload=bad\(\)&gt;/); assert.doesNotMatch(f.html(), /<script>|<img |<iframe |Pessoa 100/);
  assert.match(f.html(), /class="pg-settings__table-wrap pg-settings__import-preview" tabindex="0" role="region" aria-label="Registros da prévia"/);
  // P8: the bounded preview height lives in screen-settings.css instead of an inline style.
  assert.match(readFileSync(new URL('../public/screen-settings.css', import.meta.url), 'utf8'), /\.pg-settings__import-preview \{\s*max-height: min\(38vh, 320px\);\s*overflow: auto;/);
});

test('CSV file is read privately; unsafe type/size/empty files fail before API', async () => {
  const f = setup(); f.ui.open();
  const csv = { name: 'contatos.csv', size: 46, text: async () => 'nome;telefone\nPessoa sintética;11987654321' };
  await f.ui.submit(f.form('preview', { content: '', file: { files: [csv] } }));
  const input = JSON.parse(f.calls[0].options.body); assert.equal(input.format, 'csv'); assert.match(input.content, /nome;telefone/);
  for (const file of [{ name: 'agenda.xlsx', size: 1, text: async () => 'x' }, { name: 'agenda.json', size: 5 * 1024 * 1024 + 1, text: async () => { throw Error('Não deveria ler'); } }, { name: 'agenda.json', size: 0, text: async () => '' }]) {
    f.ui.open(); const before = f.calls.length;
    await f.ui.submit(f.form('preview', { content: '', file: { files: [file] } }));
    assert.equal(f.calls.length, before); assert.match(f.html(), /CSV ou JSON|até 5 MiB|está vazio/);
  }
});

test('UTF8 byte limit handles pasted unicode and actual file text, not just stated size', async () => {
  const f = setup(); f.ui.open();
  await f.ui.submit(f.form('preview', { content: '🙂'.repeat(1400000) }));
  assert.equal(f.calls.length, 0); assert.match(f.html(), /conteúdo deve ter até 5 MiB/);
  f.ui.open(); await f.ui.submit(f.form('preview', { content: '', file: { files: [{ name: 'agenda.json', size: 1, text: async () => 'x'.repeat(5 * 1024 * 1024 + 1) }] } }));
  assert.equal(f.calls.length, 0); assert.match(f.html(), /conteúdo deve ter até 5 MiB/);
});

test('busy blocks duplicate requests; transient apply error retains same idempotent token', async () => {
  const pending = deferred(); let applying = 0;
  const f = setup({ request: async (path, options) => {
    f.calls.push({ path, options });
    if (path.endsWith('/preview')) return pending.promise;
    if (!applying++) throw Object.assign(Error('Falha temporária'), { status: 503 });
    return receipt;
  } });
  f.ui.open(); const form = f.form(), first = f.ui.submit(form);
  assert.equal(f.ui.busy, true); await f.ui.submit(form); assert.equal(f.calls.length, 1);
  pending.resolve(preview()); await first;
  await f.ui.submit(f.form('apply')); assert.match(f.html(), /Falha temporária/); assert.match(f.html(), /Confirmar importação de 1/);
  await f.ui.submit(f.form('apply'));
  assert.equal(f.calls.length, 3); assert.equal(f.calls[1].options.body, f.calls[2].options.body); assert.match(f.html(), /Importação concluída/);
});

test('revision/expiry conflict requires new preview rather than silently applying another payload', async () => {
  const f = setup({ request: async (path, options) => { f.calls.push({ path, options }); if (path.endsWith('/preview')) return preview(); throw Object.assign(Error('A prévia expirou. Gere outra prévia.'), { status: 409 }); } });
  f.ui.open(); await f.ui.submit(f.form()); await f.ui.submit(f.form('apply'));
  assert.match(f.html(), /A prévia expirou/); assert.doesNotMatch(f.html(), /Confirmar importação/);
  await f.ui.submit(f.form('apply')); assert.equal(f.calls.length, 2);
  assert.match(f.html(), /Gere uma prévia com contatos válidos/);
  await f.ui.submit(f.form()); assert.equal(f.calls.length, 3); assert.match(f.html(), /Confirmar importação de 1/);
});

test('file-read completion cannot request data in another company/workspace or a reopened session', async () => {
  const reading = deferred(), f = setup(); f.ui.open();
  const pending = f.ui.submit(f.form('preview', { content: '', file: { files: [{ name: 'agenda.json', size: 2, text: () => reading.promise }] } }));
  f.context.workspaceId = 'workspace-2'; f.context.tenantId = 'tenant-2'; f.ui.reset(); f.ui.open();
  const latest = f.html(); reading.resolve('[]'); await pending;
  assert.equal(f.calls.length, 0); assert.equal(f.html(), latest); assert.equal(f.ui.busy, false);
});

test('preview response from earlier company is discarded; channel/permission revocation also clears state', async () => {
  for (const change of [f => { f.context.tenantId = 'tenant-2'; }, f => { f.context.canWrite = false; }, f => { f.context.channels = []; }]) {
    const response = deferred(), f = setup({ request: async () => response.promise }); f.ui.open();
    const pending = f.ui.submit(f.form()); change(f); response.resolve(preview({ rows: [row({ name: 'Privado da empresa anterior' })] })); await pending;
    assert.equal(f.ui.busy, false); await f.ui.submit(f.form('apply'));
    assert.equal(f.refreshes.length, 0); assert.doesNotMatch(f.html(), /Privado da empresa anterior|Confirmar importação/);
  }
});

test('apply completion in another workspace never refreshes or announces old-company contacts', async () => {
  const response = deferred(), f = setup({ request: async path => path.endsWith('/preview') ? preview() : response.promise });
  f.ui.open(); await f.ui.submit(f.form()); const pending = f.ui.submit(f.form('apply'));
  f.context.workspaceId = 'workspace-2'; f.context.tenantId = 'tenant-2'; f.ui.reset(); f.ui.open();
  const latest = f.html(); response.resolve(receipt); await pending;
  assert.deepEqual(f.refreshes, []); assert.equal(f.html(), latest); assert.equal(f.toasts.length, 0);
});

test('changes invalidate preview, preserve typing cursor and make file/paste mutually exclusive', async () => {
  const f = setup(); f.ui.open(); await f.ui.submit(f.form());
  const form = f.form(), content = form.elements.namedItem('content');
  content.value = '[{"name":"Novo"}]'; content.selectionStart = 5;
  assert.equal(f.ui.handleChange({ target: content }), true); assert.equal(content.selectionStart, 5);
  const before = f.calls.length; await f.ui.submit(f.form('apply')); assert.equal(f.calls.length, before);
  const input = form.elements.namedItem('file'); input.files = [{ name: 'agenda.csv', size: 2, text: async () => 'ok' }];
  f.ui.handleChange({ target: input }); assert.equal(content.value, '');
  content.value = '[]'; f.ui.handleChange({ target: content }); assert.equal(input.value, '');
  assert.equal(f.ui.handleChange({ target: { name: 'other', form } }), false);
  assert.equal(await f.ui.submit({ dataset: { dialogForm: 'other' } }), false);
});

test('successful apply remains complete if refreshing the list fails; no accidental second import', async () => {
  const f = setup({ refresh: async () => { throw Error('Lista indisponível'); } });
  f.ui.open(); await f.ui.submit(f.form()); await f.ui.submit(f.form('apply'));
  assert.match(f.html(), /Importação concluída/); assert.match(f.html(), /Os contatos foram importados. Atualize a lista: Lista indisponível/);
  assert.doesNotMatch(f.html(), /Confirmar importação|Pessoa sintética/);
  await f.ui.submit(f.form('apply')); assert.equal(f.calls.length, 2);
});

test('reset clears owned contact markup and close listener without mutating another dialog', async () => {
  const original = globalThis.document, listeners = new Map();
  const dialog = { open: true, addEventListener: (event, listener) => listeners.set(event, listener), removeEventListener: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); } };
  const target = { dataset: { contactImportSession: '2' }, innerHTML: 'Conteúdo privado sintético', closest: () => dialog, querySelector: () => null, set outerHTML(value) { this.lastMarkup = value; } };
  try {
    globalThis.document = { querySelector: selector => selector === '[data-contact-import-host]' ? target : null };
    const f = setup(); f.ui.open(); await f.ui.submit(f.form());
    assert.equal(typeof listeners.get('close'), 'function');
    target.innerHTML = 'Nome privado da agenda'; listeners.get('close')();
    assert.doesNotMatch(target.innerHTML, /Nome privado/); assert.equal(listeners.size, 0); assert.equal(f.ui.busy, false);
  } finally { globalThis.document = original; }
});

test('review is explicit opt-in, shows original phone/notes safely and confirms valid plus review counts', async () => {
  const review = row({ status: 'review', name: 'Pessoa para revisão', phone: '', originalPhone: '<img src=x onerror=bad()>', notes: 'Nome original completo\nTelefone original MEPChat: <img src=x onerror=bad()>', tags: ['Revisar telefone'] });
  const f = setup({ request: async (path, options) => {
    f.calls.push({ path, options });
    return path.endsWith('/preview') ? preview({ counts: { total: 2, valid: 1, review: 1, duplicate: 0, conflict: 0, invalid: 0 }, rows: [row(), review] }) : { ...receipt, imported: 2, reviewImported: 1 };
  } });
  f.ui.open(); await f.ui.submit(f.form('preview', { preserveInvalid: { checked: true } }));
  assert.equal(JSON.parse(f.calls[0].options.body).preserveInvalid, true);
  assert.match(f.html(), /name="preserveInvalid" checked/); assert.match(f.html(), /Confirmar importação de 2/);
  assert.match(f.html(), /sem telefone válido e sem identidade de canal/); assert.match(f.html(), /Original: &lt;img/);
  assert.match(f.html(), /Nome original completo\nTelefone original MEPChat: &lt;img/); assert.doesNotMatch(f.html(), /<img /);
  await f.ui.submit(f.form('apply')); assert.match(f.html(), /deles para revisão/);
  assert.deepEqual(f.toasts.at(-1), ['2 contatos importados, 1 para revisão.']);
  assert.doesNotMatch(f.html(), /Pessoa para revisão|Telefone original MEPChat/);
});

test('unexpected review response or unchecked preservation cannot silently create review contacts', async () => {
  const f = setup({ request: async (path, options) => { f.calls.push({ path, options }); return preview({ counts: { total: 1, valid: 0, review: 1, duplicate: 0, conflict: 0, invalid: 0 }, rows: [row({ status: 'review', phone: '', originalPhone: '123' })] }); } });
  f.ui.open(); await f.ui.submit(f.form());
  assert.match(f.html(), /escolha explicitamente preservar telefones inválidos/); assert.doesNotMatch(f.html(), /Confirmar importação/);
  await f.ui.submit(f.form('preview', { preserveInvalid: { checked: true } })); assert.match(f.html(), /Confirmar importação de 1/);
  const form = f.form(), checkbox = form.elements.namedItem('preserveInvalid'); checkbox.checked = false;
  assert.equal(f.ui.handleChange({ target: checkbox }), true);
  await f.ui.submit(f.form('apply')); assert.equal(f.calls.length, 2);
});

test('UI/core contract imports a review-only file without digits, identity or any conversation', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const actor = { userId: 'synthetic-review-admin', name: 'Admin sintético', role: 'reseller', resellerId: 'mep-demo' };
  const tenantId = store.createTenant(actor, { name: 'Empresa revisão sintética', segment: 'Teste' }).id;
  store.mutate(actor, tenantId, 'Fixture: canal planejado', state => { state.channels = [{ id: 'wa-a', kind: 'whatsapp_qr', state: 'planned', name: 'Agenda sintética' }]; });
  const service = new ContactImportService(store, { can: () => true });
  const context = { workspaceId: 'mep-demo', tenantId, canWrite: true, channels: store.tenant(actor, tenantId).channels };
  const f = setup({ getContext: () => context, request: async (path, options) => path.endsWith('/preview') ? service.preview(actor, tenantId, JSON.parse(options.body)) : service.apply(actor, tenantId, JSON.parse(options.body)) });
  f.ui.open();
  const content = JSON.stringify([{ name: 'Pessoa sem DDD confirmado', phone: '8765-4321', sourceRef: 'synthetic-source-id', notes: 'Nota preservada' }]);
  await f.ui.submit(f.form('preview', { content, preserveInvalid: { checked: true } }));
  assert.match(f.html(), /Confirmar importação de 1/); assert.match(f.html(), /Original: 8765-4321/);
  await f.ui.submit(f.form('apply'));
  const state = store.tenant(actor, tenantId);
  assert.equal(state.contacts.length, 1); assert.equal(state.contacts[0].phone, ''); assert.deepEqual(state.contacts[0].identities, []);
  assert.equal(state.contacts[0].notes, 'Nota preservada\n\nTelefone original MEPChat: 8765-4321');
  assert.deepEqual(state.contacts[0].importSource, { provider: 'mepchat', ref: 'synthetic-source-id' }); assert.deepEqual(state.conversations, []);
  assert.match(f.html(), /Importação concluída/);
});
