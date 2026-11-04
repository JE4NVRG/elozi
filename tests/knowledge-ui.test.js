import test from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeUI } from '../public/knowledge-ui.js';
import { getLocale, setLocale } from '../public/i18n.js';

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

// A small DOM adapter exercises the actual module's local repaint and focus path,
// without mounting the app, replacing the editor, or issuing a real request.
function catalogDocument() {
  const nodes = new Map();
  for (const selector of ['#knowledge-library-items', '#knowledge-catalog-status', '#knowledge-retry', '#knowledge-totals', '#knowledge-result-count', '#knowledge-search', '.knowledge-library-foot>span']) {
    nodes.set(selector, { innerHTML: '', textContent: '', hidden: false, attributes: {}, writes: 0,
      setAttribute(key, value) { this.attributes[key] = value; },
      focus() { doc.activeElement = this; }
    });
  }
  const status = nodes.get('#knowledge-catalog-status');
  let text = '';
  Object.defineProperty(status, 'textContent', { get: () => text, set(value) { text = value; this.writes++; } });
  const editor = { value: 'Unsaved private draft', isConnected: true };
  const doc = { activeElement: null, querySelector: selector => nodes.get(selector) ?? null };
  return { doc, nodes, status, editor };
}

for (const language of ['pt-BR', 'en']) {
  for (const empty of [false, true]) {
    test(`catalog initial failure → local GET retry → ${empty ? 'empty' : 'success'} (${language})`, async () => {
      const previousLocale = getLocale(), previousDocument = globalThis.document;
      const dom = catalogDocument(); globalThis.document = dom.doc;
      setLocale(language, { persist: false, notify: false });
      try {
        const first = deferred(), next = deferred(), calls = [];
        let renders = 0, modals = 0;
        const { state, ui } = setup({ api: (path, options) => { calls.push({ path, options }); return calls.length === 1 ? first.promise : next.promise; }, render: () => { renders++; }, formModal: () => { modals++; } });
        const pending = ui.load();
        assert.match(dom.status.textContent, language === 'en' ? /Loading/ : /Carregando/);
        first.reject(new Error('<private server details>'));
        await assert.rejects(pending);
        const failed = ui.panel();
        assert.match(dom.status.textContent, language === 'en' ? /Could not load/ : /Não foi possível carregar/);
        assert.doesNotMatch(failed, /Carregando|Loading the|Nenhuma fonte ainda|No sources yet|private server/);
        assert.equal(state.knowledgeLoaded, false);
        assert.doesNotMatch(failed, /0\/50/,'unknown catalog is not a confirmed zero');
        assert.match(failed, /id="knowledge-catalog-status" role="status" aria-live="polite" aria-atomic="true"/);
        assert.match(failed, /id="knowledge-retry"[^>]*aria-controls="knowledge-library-items"[^>]*aria-describedby="knowledge-catalog-status"/);
        assert.match(failed, language === 'en' ? /Try loading the sources again/ : /Tentar carregar as fontes novamente/);
        const retryNode = dom.nodes.get('#knowledge-retry'); dom.doc.activeElement = retryNode;
        let hidden = retryNode.hidden;
        Object.defineProperty(retryNode, 'hidden', { get:()=>hidden, set(value) { hidden=value;if(value&&dom.doc.activeElement===retryNode)dom.doc.activeElement=null; } });
        const retry = ui.act('knowledge-retry'), duplicate = ui.act('knowledge-retry');
        assert.equal(calls.length, 2);
        assert.equal(dom.nodes.get('#knowledge-retry'), retryNode);
        assert.equal(retryNode.attributes['aria-disabled'], 'true');
        assert.equal(dom.nodes.get('#knowledge-library-items').attributes['aria-busy'], 'true');
        next.resolve({ sources: empty ? [] : [published] });
        assert.equal(await retry, true); assert.equal(await duplicate, true);
        assert.equal(state.knowledgeLoaded, true);
        assert.equal(retryNode.hidden, true);
        assert.equal(dom.doc.activeElement, dom.nodes.get('#knowledge-search'));
        assert.ok(dom.nodes.get('.knowledge-library-foot>span').textContent.endsWith(`${empty?0:1}/50 ${language==='en'?'sources':'fontes'}`));
        assert.equal(dom.status.textContent, '');
        assert.equal(dom.nodes.get('#knowledge-library-items').attributes['aria-busy'], 'false');
        if (empty) assert.match(ui.panel(), language === 'en' ? /A good reply starts/ : /Uma boa resposta começa/);
        else assert.match(ui.panel(), /Política de troca/);
        assert.ok(calls.every(call => call.path.endsWith('knowledge/sources?archived=true') && (!call.options || call.options.method === 'GET')));
        assert.equal(renders, 0); assert.equal(modals, 0);
        assert.equal(dom.editor.value, 'Unsaved private draft');
      } finally { globalThis.document = previousDocument; setLocale(previousLocale, { persist: false, notify: false }); }
    });
  }
}

test('catalog transient failure retains authorized metadata, filters and a stable status node', async () => {
  const previousDocument = globalThis.document, dom = catalogDocument(); globalThis.document = dom.doc;
  try {
    const next = deferred(); let calls = 0;
    const { state, ui } = setup({ api: () => ++calls === 1 ? Promise.resolve({ sources: [published] }) : next.promise });
    await ui.load();
    ui.handleInput({ target: { id: 'knowledge-search', value: 'troca' } });
    ui.handleChange({ target: { id: 'knowledge-filter', value: 'published' } });
    const metadata = state.knowledgeSources;
    const pending = ui.load({ force: true });
    assert.match(ui.panel(), /Política de troca/);
    next.reject(Object.assign(new Error('Unavailable'), { status: 503 }));
    await assert.rejects(pending);
    assert.equal(state.knowledgeSources, metadata);
    assert.equal(state.knowledgeSources[0].content, undefined);
    const html = ui.panel();
    assert.match(html, /pode estar desatualizado/);
    assert.match(html, /value="troca"/); assert.match(html, /value="published" selected/);
    const writes = dom.status.writes;
    ui.handleInput({ target: { id: 'knowledge-search', value: 'Política' } });
    assert.equal(dom.status.writes, writes, 'unchanged failure is not announced on filtering');
    assert.equal(dom.nodes.get('#knowledge-retry').hidden, false);
  } finally { globalThis.document = previousDocument; }
});

for (const status of [401, 403, 404]) {
  test(`catalog authority refusal ${status} discards last successful catalog`, async () => {
    let calls = 0;
    const { state, ui } = setup({ api: async () => { if (++calls === 1) return { sources: [published] }; throw Object.assign(new Error('Private diagnostic'), { status }); } });
    await ui.load(); await assert.rejects(ui.load({ force: true }));
    assert.deepEqual(state.knowledgeSources, []); assert.equal(state.knowledgeLoaded, false);
    assert.match(ui.panel(), /Confira sua sessão e suas permissões/);
    assert.doesNotMatch(ui.panel(), /Política de troca|Private diagnostic|Carregando/);
  });
}

test('synchronous reentrant load shares the reserved catalog GET', async () => {
  const transport = deferred(); let ui, nested, calls = 0;
  ({ ui } = setup({ api: () => { calls++; nested = ui.load({ force: true }); return transport.promise; } }));
  const pending = ui.load();
  assert.equal(pending, nested); assert.equal(calls, 1);
  transport.resolve({ sources: [] }); assert.equal(await pending, true);
});

for (const change of ['tenant', 'workspace', 'user', 'role', 'support']) {
  for (const outcome of ['success', 'error']) {
    test(`stale ${outcome}/finally cannot modify current catalog after ${change} change`, async () => {
      const old = deferred(), fresh = deferred(); let calls = 0;
      const { state, ui } = setup({ api: () => ++calls === 1 ? old.promise : fresh.promise });
      const pending = ui.load();
      if (change === 'tenant') state.tenant = { ...state.tenant, id: 'tenant-2' };
      if (change === 'workspace') state.workspaceId = 'reseller-2';
      if (change === 'user') state.boot.session.userId = 'admin-2';
      if (change === 'role') state.boot.session.role = 'operator';
      if (change === 'support') state.supportGrantId = 'grant-1';
      const current = ui.load();
      if (outcome === 'success') old.resolve({ sources: [published] });
      else old.reject(Object.assign(new Error('Old failure'), { status: 403 }));
      assert.equal(await pending, false);
      assert.deepEqual(state.knowledgeSources, []);
      if (change === 'role') {
        assert.equal(await current, false); assert.equal(ui.panel(), ''); assert.equal(calls, 1);
        await assert.rejects(ui.act('knowledge-retry'), /administrador/);
      } else {
        assert.match(ui.panel(), /aria-busy="true"/);
        const duplicate = ui.load({ force: true }); assert.equal(duplicate, current); assert.equal(calls, 2);
        fresh.resolve({ sources: [{ ...published, title: 'Current company source' }] });
        assert.equal(await current, true); assert.match(ui.panel(), /Current company source/);
        assert.doesNotMatch(ui.panel(), /Política de troca|Old failure|Confira sua sessão/);
      }
    });
  }
}

test('old success cannot clear the newer scope error; switching user drops cached metadata before repaint', async () => {
  const old = deferred(), next = deferred(); let calls = 0;
  const { state, ui } = setup({ api: () => ++calls === 1 ? old.promise : next.promise });
  const pending = ui.load(); state.boot.session.userId = 'admin-2';
  const current = ui.load(); next.reject(new Error('New failure')); await assert.rejects(current);
  old.resolve({ sources: [published] }); assert.equal(await pending, false);
  assert.match(ui.panel(), /Não foi possível carregar/); assert.deepEqual(state.knowledgeSources, []);
  const cached = setup({ api: async () => ({ sources: [published] }) }); await cached.ui.load();
  cached.state.boot.session.userId = 'admin-3';
  assert.doesNotMatch(cached.ui.panel(), /Política de troca/);
  assert.deepEqual(cached.state.knowledgeSources, []); assert.equal(cached.state.knowledgeLoaded, false);
});

test('local catalog retry never reconstructs an open unsaved source editor', async () => {
  const fake = fakeSourceDocument({ title: published.title, category: published.category, content: published.content });
  const previousDocument = globalThis.document; globalThis.document = fake.document;
  try {
    let reads = 0, modals = 0, renders = 0;
    const { ui } = setup({ formModal: () => { modals++; }, render: () => { renders++; }, api: async path => {
      if (path.endsWith('/source-1')) return published;
      if (++reads === 1) throw new Error('Offline');
      return { sources: [published] };
    } });
    await ui.act('knowledge-edit', published.id);
    fake.form.elements.content.value = 'My unsaved source text';
    await assert.rejects(ui.load());
    assert.equal(await ui.act('knowledge-retry'), true);
    assert.equal(fake.form.elements.content.value, 'My unsaved source text');
    assert.equal(modals, 1); assert.equal(renders, 0); assert.equal(reads, 2);
    await assert.rejects(ui.act('knowledge-publish', published.id), /Salve o rascunho/);
  } finally { globalThis.document = previousDocument; }
});

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function setup(overrides = {}) {
  const state = { workspaceId: 'reseller-1', boot: { session: { role: 'reseller', resellerId: 'reseller-1', userId: 'admin-1' } }, tenant: { id: 'tenant-1', name: 'Empresa teste', agents: [{ id: 'hermes-1', name: 'Hermes', provider: 'hermes', version: 1 }] }, view: 'knowledge' };
  const context = { state, escape, icon: name => `<svg data-icon="${name}"/>`, badge: (text, tone) => `<span class="badge ${tone}">${escape(text)}</span>`, pageHeading: (_eyebrow, title, description, actions) => `<h1>${title}</h1><p>${description}</p>${actions}`, tenantApi: path => `/api/tenants/${state.tenant.id}/${path}`, api: async () => ({ sources: [] }), formModal: () => {}, toast: () => {}, render: () => {}, ...overrides };
  return { state, context, ui: createKnowledgeUI(context) };
}
const published = { id: 'source-1', title: 'Política de troca', category: 'Atendimento', version: 3, contentChars: 45, draftChanged: true, archived: false, content: 'O prazo é de 7 dias.', published: { version: 2, title: 'Política aprovada', content: 'Texto publicado privado', hash: 'a'.repeat(64), publishedAt: '2026-10-02T12:00:00Z' } };

function fakeSourceDocument(fields) {
  const nodes = new Map();
  const node = () => ({ hidden: false, innerHTML: '', textContent: '', toggleAttribute() {}, insertAdjacentHTML() {}, remove() {} });
  const form = { dataset: { dialogForm: 'knowledge-source' }, elements: Object.fromEntries(Object.entries(fields).map(([name, value]) => [name, { name, value, readOnly: false }])), isConnected: true, querySelector(selector) { if (selector === '.knowledge-publication') return null; if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); }, querySelectorAll() { return Object.values(this.elements); }, setAttribute() {}, removeAttribute() {} };
  const modal = { addEventListener() {}, close() {} };
  return { form, nodes, document: { querySelector: selector => selector === '#modal' ? modal : selector === '#modal form[data-dialog-form="knowledge-source"]' ? form : null } };
}

test('knowledge library retains only metadata and escapes source titles', async () => {
  const source = { ...published, title: '<img src=x onerror=alert(1)>', category: '<script>1</script>' };
  const { state, ui } = setup({ api: async () => ({ sources: [source] }) });
  await ui.load();
  assert.equal(state.knowledgeSources[0].content, undefined);
  assert.equal(state.knowledgeSources[0].published.content, undefined);
  const html = ui.panel();
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;script&gt;1&lt;/script&gt;'));
  assert.ok(!html.includes('Texto publicado privado'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('Rascunho alterado'));
  assert.ok(html.includes('v2'));
});

test('knowledge load discards an earlier workspace response', async () => {
  let resolve;
  const { state, ui } = setup({ api: () => new Promise(done => { resolve = done; }) });
  const pending = ui.load();
  state.workspaceId = 'reseller-2'; state.tenant.id = 'tenant-2';
  resolve({ sources: [published] });
  assert.equal(await pending, false);
  assert.deepEqual(state.knowledgeSources, []);
  assert.equal(state.knowledgeLoaded, false);
});

test('operators cannot load, edit or see the private library', async () => {
  let calls = 0;
  const { state, ui } = setup({ api: async () => { calls++; return {}; } });
  state.boot.session.role = 'operator';
  assert.equal(await ui.load(), false);
  assert.equal(ui.panel(), '');
  await assert.rejects(ui.act('knowledge-edit', 'source-1'), /administrador/);
  assert.equal(calls, 0);
});

test('knowledge load shares the same in-flight catalog request', async () => {
  let calls = 0, resolve;
  const { ui } = setup({ api: () => { calls++; return new Promise(done => { resolve = done; }); } });
  const first = ui.load(), second = ui.load(); resolve({ sources: [] });
  assert.equal(await first, true); assert.equal(await second, true); assert.equal(calls, 1);
});

test('run references escape excerpts and do not claim every source was used', () => {
  const { ui } = setup();
  const html = ui.runReferences({ knowledgeState: 'matched', knowledgeReferences: [{ sourceId: '<id>', title: '<script>attack</script>', publicationVersion: 2, publicationHash: 'a'.repeat(64), chunkId: 'chunk-1', excerpt: '<img src="https://external.test/" onerror="attack()">\n[link](javascript:attack())' }] });
  assert.ok(html.includes('Fontes consultadas'));
  assert.ok(html.includes('Publicação v2'));
  assert.ok(html.includes('&lt;script&gt;attack&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('href='));
  assert.ok(html.includes('Trechos recuperados para o contexto'));
});

test('revoked references are hidden even when an old run still carries excerpts', () => {
  const { ui } = setup();
  const html = ui.runReferences({ knowledgeUnavailable: true, knowledgeState: 'matched', knowledgeReferences: [{ title: 'Privado', excerpt: 'Não pode aparecer' }] });
  assert.ok(html.includes('não estão mais disponíveis'));
  assert.ok(!html.includes('Privado'));
  assert.ok(!html.includes('Não pode aparecer'));
  assert.equal(ui.runReferences({ knowledgeState: 'not_configured' }), '');
  assert.ok(ui.runReferences({ knowledgeState: 'no_match' }).includes('sem correspondência'));
});

test('source editor displays Markdown and published text as escaped literal text', async () => {
  const fake = fakeSourceDocument({ title: 'Teste', category: '', content: 'Texto' });
  const original = globalThis.document; globalThis.document = fake.document;
  try {
    let markup;
    const { ui } = setup({ api: async () => ({ ...published, content: '<svg onload=attack()>![img](https://external.test/)', published: { ...published.published, content: '<iframe src="https://external.test/">' } }), formModal: (_title, _description, _type, fields) => { markup = fields; } });
    await ui.act('knowledge-edit', 'source-1');
    assert.ok(markup.includes('&lt;svg onload=attack()&gt;'));
    assert.ok(markup.includes('&lt;iframe'));
    assert.ok(!markup.includes('<svg onload='));
    assert.ok(!markup.includes('<iframe'));
    assert.ok(markup.includes('![img](https://external.test/)'));
  } finally { globalThis.document = original; }
});

test('CAS conflict retains unsaved text and exposes an explicit comparison action', async () => {
  const fake = fakeSourceDocument({ title: 'Política de troca', category: 'Atendimento', content: 'Minha edição que não pode desaparecer.' });
  const original = globalThis.document; globalThis.document = fake.document;
  try {
    const requests = [];
    const { ui } = setup({ api: async (path, options) => { requests.push({ path, options }); if (!options) return published; throw Object.assign(new Error('Versão desatualizada.'), { status: 409 }); } });
    await ui.act('knowledge-edit', 'source-1');
    await assert.rejects(ui.submit(fake.form), error => error.status === 409);
    assert.equal(fake.form.elements.content.value, 'Minha edição que não pode desaparecer.');
    assert.equal(JSON.parse(requests[1].options.body).version, 3);
    assert.ok(fake.nodes.get('.knowledge-editor-conflict').innerHTML.includes('knowledge-compare'));
    assert.equal(fake.nodes.get('.knowledge-editor-conflict').hidden, false);
  } finally { globalThis.document = original; }
});

test('publishing from the editor never silently saves an unsaved draft', async () => {
  const fake = fakeSourceDocument({ title: 'Política de troca', category: 'Atendimento', content: 'Minha alteração ainda não salva.' });
  const original = globalThis.document; globalThis.document = fake.document;
  try {
    let calls = 0;
    const { ui } = setup({ api: async () => { calls++; return published; } });
    await ui.act('knowledge-edit', 'source-1');
    await assert.rejects(ui.act('knowledge-publish', 'source-1'), /Salve o rascunho/);
    assert.equal(calls, 1);
    assert.equal(fake.form.elements.content.value, 'Minha alteração ainda não salva.');
  } finally { globalThis.document = original; }
});

test('stale workspace submission makes no request and preserves editor fields', async () => {
  const fake = fakeSourceDocument({ title: 'Política de troca', category: 'Atendimento', content: 'Texto local' });
  const original = globalThis.document; globalThis.document = fake.document;
  try {
    let calls = 0;
    const { state, ui } = setup({ api: async () => { calls++; return published; } });
    await ui.act('knowledge-edit', 'source-1'); state.workspaceId = 'reseller-2'; state.tenant.id = 'tenant-2';
    await assert.rejects(ui.submit(fake.form), /empresa mudou/);
    assert.equal(calls, 1);
    assert.equal(fake.form.elements.content.value, 'Texto local');
  } finally { globalThis.document = original; }
});

function knowledgeRun(id = 'run-1', agentId = 'hermes-1', sourceId = 'source-1') {
  return { id, agentId, conversationId: 'conversation-1', state: 'draft', draft: 'Rascunho anterior', knowledgeState: 'matched', knowledgeReferences: [{ sourceId, title: 'Fonte privada', publicationVersion: 2, publicationHash: 'a'.repeat(64), excerpt: 'Trecho que precisa desaparecer imediatamente.' }] };
}

for (const [action, mutation] of [['knowledge-publish', 'publish'], ['knowledge-unpublish', 'unpublish'], ['knowledge-confirm-archive', 'archive'], ['knowledge-reactivate', 'reactivate']]) {
  test(`${mutation} immediately blocks cached references and only refreshes runs and agents`, async () => {
    const fake = fakeSourceDocument({ title: published.title, category: published.category, content: published.content });
    const original = globalThis.document; globalThis.document = fake.document;
    try {
      let state, globalRenders = 0, globalRefreshes = 0, tenantReads = 0, runRenders = 0;
      const source = mutation === 'reactivate' ? { ...published, archived: true, published: undefined } : published;
      const changed = { ...source, version: 4, archived: mutation === 'archive', published: mutation === 'publish' ? { ...published.published, version: 3 } : undefined };
      const freshRun = { ...knowledgeRun(), knowledgeUnavailable: true, knowledgeReferences: [] };
      const setupResult = setup({
        render: () => { globalRenders++; }, refresh: () => { globalRefreshes++; }, renderRuns: () => { runRenders++; },
        api: async (path, options) => {
          if (options?.method === 'POST') {
            assert.equal(state.tenant.runs[0].knowledgeUnavailable, true);
            assert.deepEqual(state.tenant.runs[0].knowledgeReferences, []);
            assert.ok(path.endsWith(`/${mutation}`));
            return changed;
          }
          if (path === '/api/tenants/tenant-1/') {
            tenantReads++;
            return { id: 'tenant-1', runs: [freshRun], agents: [{ id: 'hermes-1', provider: 'hermes', version: 8, knowledgeGrants: [] }], conversations: ['must not replace the composer context'], name: 'must not replace the tenant metadata' };
          }
          return source;
        }
      });
      state = setupResult.state; state.view = 'inbox'; state.tenant.runs = [knowledgeRun()]; state.tenant.conversations = [{ id: 'conversation-1', text: 'Mensagem manual ainda não enviada.' }];
      const originalConversations = state.tenant.conversations, manualDraft = 'Texto manual no compositor'; state.manualComposerDraft = manualDraft;
      await setupResult.ui.act('knowledge-edit', source.id);
      await setupResult.ui.act(action, source.id);
      assert.deepEqual(state.tenant.runs, [freshRun]);
      assert.equal(state.tenant.agents[0].version, 8);
      assert.equal(state.tenant.conversations, originalConversations);
      assert.equal(state.tenant.name, 'Empresa teste');
      assert.equal(state.manualComposerDraft, manualDraft);
      assert.equal(fake.form.elements.content.value, published.content);
      assert.equal(tenantReads, 1); assert.equal(globalRenders, 0); assert.equal(globalRefreshes, 0); assert.equal(runRenders, 2);
    } finally { globalThis.document = original; }
  });
}

test('a failed tenant reread keeps cached drafts and private references blocked', async () => {
  const fake = fakeSourceDocument({ title: published.title, category: published.category, content: published.content });
  const original = globalThis.document; globalThis.document = fake.document;
  try {
    const notifications = [];
    const { state, ui } = setup({ api: async (path, options) => { if (options) return { ...published, version: 4, published: undefined }; if (path.endsWith('/source-1')) return published; throw new Error('Consulta indisponível.'); }, toast: (message, error) => notifications.push({ message, error }) });
    state.view = 'inbox'; state.tenant.runs = [knowledgeRun()];
    await ui.act('knowledge-edit', 'source-1'); await ui.act('knowledge-unpublish', 'source-1');
    assert.equal(state.tenant.runs[0].knowledgeUnavailable, true);
    assert.deepEqual(state.tenant.runs[0].knowledgeReferences, []);
    assert.equal(state.tenant.runs[0].draft, 'Rascunho anterior');
    assert.equal(fake.form.elements.content.value, published.content);
    assert.equal(notifications.at(-1).error, true);
    assert.ok(notifications.at(-1).message.includes('continuam bloqueados'));
  } finally { globalThis.document = original; }
});

test('a rejected CAS mutation rereads authority before restoring a valid cached draft', async () => {
  const fake = fakeSourceDocument({ title: published.title, category: published.category, content: published.content });
  const original = globalThis.document; globalThis.document = fake.document;
  try {
    let state, reads = 0;
    const validRun = knowledgeRun();
    const created = setup({ api: async (path, options) => {
      if (options) { assert.equal(state.tenant.runs[0].knowledgeUnavailable, true); throw Object.assign(new Error('Versão desatualizada.'), { status: 409 }); }
      if (path.endsWith('/source-1')) return published;
      reads++; return { id: 'tenant-1', runs: [validRun] };
    } });
    state = created.state; state.view = 'inbox'; state.tenant.runs = [knowledgeRun()];
    await created.ui.act('knowledge-edit', 'source-1');
    await assert.rejects(created.ui.act('knowledge-unpublish', 'source-1'), error => error.status === 409);
    assert.equal(reads, 1);
    assert.deepEqual(state.tenant.runs, [validRun]);
    assert.equal(state.tenant.runs[0].knowledgeUnavailable, undefined);
    assert.equal(fake.form.elements.content.value, published.content);
  } finally { globalThis.document = original; }
});

test('tenant reread after a source change cannot overwrite another workspace', async () => {
  const fake = fakeSourceDocument({ title: published.title, category: published.category, content: published.content });
  const original = globalThis.document; globalThis.document = fake.document;
  try {
    let resolveFresh, startedFresh;
    const freshStarted = new Promise(resolve => { startedFresh = resolve; });
    const { state, ui } = setup({ api: (path, options) => {
      if (options) return Promise.resolve({ ...published, version: 4, published: undefined });
      if (path.endsWith('/source-1')) return Promise.resolve(published);
      startedFresh(); return new Promise(resolve => { resolveFresh = resolve; });
    } });
    state.view = 'inbox'; state.tenant.runs = [knowledgeRun()];
    await ui.act('knowledge-edit', 'source-1'); const pending = ui.act('knowledge-unpublish', 'source-1'); await freshStarted;
    const nextRuns = [{ id: 'run-from-another-tenant' }]; state.workspaceId = 'reseller-2'; state.tenant = { id: 'tenant-2', agents: [], runs: nextRuns };
    resolveFresh({ id: 'tenant-1', runs: [{ ...knowledgeRun(), knowledgeUnavailable: true }], agents: [{ id: 'old-agent' }] }); await pending;
    assert.equal(state.tenant.runs, nextRuns);
    assert.deepEqual(state.tenant.agents, []);
  } finally { globalThis.document = original; }
});

test('saving agent grants blocks that agent before PUT and rereads the tenant without rendering the app', async () => {
  const fake = fakeSourceDocument({ title: '', category: '', content: '' }); fake.form.dataset.dialogForm = 'knowledge-grants';
  const originalDocument = globalThis.document, OriginalFormData = globalThis.FormData;
  globalThis.document = fake.document; globalThis.FormData = class { getAll() { return []; } };
  try {
    let state, renders = 0, tenantReads = 0;
    const targetRun = knowledgeRun(), otherRun = knowledgeRun('run-other', 'another-agent', 'source-other');
    const freshRun = { ...targetRun, knowledgeReferences: [], knowledgeUnavailable: true };
    const created = setup({ render: () => { renders++; }, api: async (path, options) => {
      if (options?.method === 'PUT') {
        assert.equal(state.tenant.runs[0].knowledgeUnavailable, true); assert.deepEqual(state.tenant.runs[0].knowledgeReferences, []);
        assert.equal(state.tenant.runs[1].knowledgeUnavailable, undefined);
        return { version: 2, grants: [] };
      }
      if (path.endsWith('knowledge-grants')) return { version: 1, grants: [{ sourceId: 'source-1', publicationVersion: 2, publicationHash: 'a'.repeat(64) }] };
      if (path.includes('knowledge/sources')) return { sources: [published] };
      tenantReads++; return { id: 'tenant-1', runs: [freshRun, otherRun], agents: [{ id: 'hermes-1', provider: 'hermes', version: 2, knowledgeGrants: [] }] };
    } });
    state = created.state; state.view = 'agents'; state.tenant.runs = [targetRun, otherRun];
    await created.ui.act('knowledge-grants', 'hermes-1'); await created.ui.submit(fake.form);
    assert.deepEqual(state.tenant.runs, [freshRun, otherRun]); assert.equal(state.tenant.agents[0].version, 2);
    assert.equal(renders, 0); assert.equal(tenantReads, 1);
  } finally { globalThis.document = originalDocument; globalThis.FormData = OriginalFormData; }
});

test('overlapping source changes keep a still-pending mutation blocked during the first reread', async () => {
  const original = globalThis.document; globalThis.document = { querySelector: () => null };
  try {
    let state, resolveFirst, resolveSecond;
    const firstSource = published, secondSource = { ...published, id: 'source-2', title: 'Outra fonte' };
    const firstRun = knowledgeRun(), secondRun = knowledgeRun('run-2', 'hermes-2', 'source-2');
    const created = setup({ api: (path, options) => {
      if (options && path.includes('/source-1/')) return new Promise(resolve => { resolveFirst = resolve; });
      if (options && path.includes('/source-2/')) return new Promise(resolve => { resolveSecond = resolve; });
      if (path.includes('knowledge/sources')) return Promise.resolve({ sources: [firstSource, secondSource] });
      return Promise.resolve({ id: 'tenant-1', runs: [{ ...firstRun, knowledgeReferences: [], knowledgeUnavailable: true }, resolveSecond ? secondRun : { ...secondRun, knowledgeReferences: [], knowledgeUnavailable: true }] });
    } });
    state = created.state; state.view = 'inbox'; state.tenant.runs = [firstRun, secondRun]; await created.ui.load();
    const first = created.ui.act('knowledge-unpublish', 'source-1'), second = created.ui.act('knowledge-unpublish', 'source-2');
    resolveFirst({ ...firstSource, version: 4, published: undefined }); await first;
    assert.equal(state.tenant.runs[1].knowledgeUnavailable, true); assert.deepEqual(state.tenant.runs[1].knowledgeReferences, []);
    const finishSecond = resolveSecond; resolveSecond = null; finishSecond({ ...secondSource, version: 4, published: undefined }); await second;
    assert.equal(state.tenant.runs[0].knowledgeUnavailable, true); assert.equal(state.tenant.runs[1].knowledgeUnavailable, true);
  } finally { globalThis.document = original; }
});
