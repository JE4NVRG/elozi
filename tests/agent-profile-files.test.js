import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentDetail, readAgentInstructionFile, agentProfileMarkdown } from '../public/agent-detail-ui.js';
import { setLocale } from '../public/i18n.js';
import { parseHash } from '../public/router.js';
import { toasts } from '../public/ui.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const textFile = (text, name = 'instrucoes.md', type = 'text/markdown') => new File([text], name, { type });
test.afterEach(() => setLocale('pt-BR', { persist: false, notify: false }));

function fixture(t, { provider = 'hermes', admin = true, features = [] } = {}) {
  const original = Object.fromEntries(['document', 'location'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])), show = toasts.show;
  const calls = [], notices = [], blobs = [], revoked = [], downloads = [], copies = [], events = new Map();
  const clipboard = { async writeText(text) { copies.push(text); } };
  const agent = { id: 'a1', name: 'Suporte Acácias', description: 'Atendimento da empresa.', provider, configured: true, mode: 'copilot', version: 7, instructions: 'Texto salvo.',
    apiKey: 'SYNTHETIC_PRIVATE_TOKEN', tools: ['SYNTHETIC_PRIVATE_TOOL'], runtime: { endpoint: 'SYNTHETIC_PRIVATE_ENDPOINT' } };
  const state = { workspaceId: 'w1', boot: { session: { userId: 'u1', role: admin ? 'reseller' : 'operator' } }, tenant: { id: 't1', name: 'Empresa A', agents: [agent,
    { id: 'a2', name: 'Outro', provider: 'hermes', version: 1, instructions: 'Texto B.' }], conversations: [{ id: 'private-conversation', text: 'SYNTHETIC_PRIVATE_CONVERSATION' }] } };
  const modal = { open: false }, importButton = { disabled: false }, status = { textContent: '' }, counter = { textContent: '', dataset: {} };
  const area = { value: agent.instructions, dataset: { agentsInstructions: 'a1' }, isConnected: true, selectionStart: 0, selectionEnd: 0,
    focus() {}, setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }, closest: selector => selector === '[data-agents-instructions]' ? area : null };
  const input = { dataset: { agentsProfileFile: 'a1' }, value: '', files: [], isConnected: true, clicked: 0, click() { this.clicked++; }, closest: selector => selector === 'form' || selector === 'form[data-form="agents:instructions"]' ? form : null };
  const form = { dataset: { form: 'agents:instructions', id: 'a1' }, isConnected: true, querySelector(selector) {
    return ({ '[data-agents-instructions]': area, '[data-agents-profile-file]': input, '[data-agents-import]': importButton, '[data-agents-counter]': counter, '[data-agents-status]': status })[selector] || null;
  } };
  let activeForm = form;
  const doc = { addEventListener() {}, querySelector(selector) {
    if (selector === '#modal') return modal;
    if (selector.startsWith('form[data-form="agents:instructions"]')) return activeForm;
    if (selector === '[data-agents-instructions="a1"]') return area;
    return null;
  }, defaultView: { navigator: { clipboard }, URL: { createObjectURL(blob) { blobs.push(blob); return `blob:profile-${blobs.length}`; }, revokeObjectURL(url) { revoked.push(url); } } },
  body: { append() {} }, createElement(tag) { assert.equal(tag, 'a'); return { click() { downloads.push({ href: this.href, filename: this.download }); }, remove() {} }; } };
  const main = { addEventListener(name, fn) { events.set(name, fn); }, querySelector() { return null; } };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hash: '#agents/a1/instructions' } });
  toasts.show = notice => notices.push(notice);
  t.after(() => { toasts.show = show; for (const [key, descriptor] of Object.entries(original)) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } });
  const detail = createAgentDetail({ state, context: () => ({ admin: state.boot?.session?.role === 'reseller', owner: false, scope: `${state.workspaceId}:${state.tenant.id}`, features: new Set(features) }),
    request: async (path, options) => { const body = JSON.parse(options.body); calls.push({ path, method: options.method, body }); return { instructions: body.instructions, version: body.version + 1 }; }, render() {} });
  const route = parseHash(globalThis.location.hash); detail.view(route); detail.mount(main, route);
  return { detail, state, agent, calls, notices, area, input, form, modal, blobs, revoked, downloads, copies, clipboard, importButton,
    view: () => detail.view(parseHash(globalThis.location.hash)), changeForm(value) { activeForm = value; },
    type(text) { area.value = text; events.get('input')({ target: area }); },
    async import(file) { input.files = [file]; events.get('change')({ target: input }); await tick(); },
    async choose(files) { input.files = files; events.get('change')({ target: input }); await tick(); } };
}

test('local UTF-8 text import preserves literal Markdown, accepts BOM/CRLF and never truncates its 4,000-character boundary', async () => {
  const text = '# Papel\r\nOlá, cliente.\r\n<script>literal</script>\t';
  assert.equal(await readAgentInstructionFile(textFile('\ufeff' + text)), text.replace(/\r\n/g, '\n'));
  assert.equal((await readAgentInstructionFile(textFile('a'.repeat(4000), 'perfil.TXT', 'text/plain'))).length, 4000);
  await assert.rejects(readAgentInstructionFile(textFile('a'.repeat(4001))), /4\.000.*Base de conhecimento.*nada foi cortado/);
});

test('file metadata, binary bytes, invalid UTF-8, controls, oversized input and mismatched byte lengths are refused', async () => {
  for (const file of [textFile('abc', 'arquivo.pdf'), textFile('abc', 'arquivo.md', 'text/html'), textFile('', 'vazio.txt'), textFile('x'.repeat(16385)),
    textFile('a\x00b'), textFile('a\x1bb'), textFile('a\x85b'), new File([new Uint8Array([0xff, 0xfe])], 'utf8.txt', { type: 'text/plain' }),
    { name: 'instrucoes.md', type: 'text/markdown', size: 4, arrayBuffer: async () => new ArrayBuffer(3) }]) await assert.rejects(readAgentInstructionFile(file));
  let read = false;
  await assert.rejects(readAgentInstructionFile({ name: 'binary.exe', type: '', size: 2, arrayBuffer: async () => { read = true; return new ArrayBuffer(2); } }));
  assert.equal(read, false, 'Invalid metadata is refused before reading bytes.');
});

test('import changes only the current editor and requires an explicit save with the original CAS version', async t => {
  const f = fixture(t), imported = '## Tom\nSeja cordial. <script>literal</script>';
  await f.detail.act('agents:instructions-import', 'a1'); assert.equal(f.input.clicked, 1);
  await f.import(textFile(imported));
  assert.equal(f.area.value, imported); assert.equal(f.agent.instructions, 'Texto salvo.'); assert.equal(f.agent.version, 7); assert.equal(f.calls.length, 0);
  assert.match(f.view(), /data-state="dirty"/); assert.match(f.view(), /&lt;script&gt;literal&lt;\/script&gt;/); assert.match(f.notices.at(-1).message, /revisão.*Salve/);
  assert.equal(f.importButton.disabled, true);
  await f.detail.submit(f.form);
  assert.deepEqual(f.calls, [{ path: '/api/tenants/t1/agents/a1', method: 'PATCH', body: { version: 7, instructions: imported } }]);
  assert.equal(f.agent.instructions, imported); assert.equal(f.agent.version, 8);
});

test('existing drafts and too-long files stay intact with a knowledge route instead of auto-saving or silently truncating', async t => {
  const f = fixture(t);
  await f.import(textFile('x'.repeat(4001))); assert.equal(f.area.value, 'Texto salvo.'); assert.match(f.notices.at(-1).message, /Base de conhecimento.*nada foi cortado/);
  assert.match(f.view(), /href="#agents\/knowledge"/); assert.equal(f.calls.length, 0);
  f.type('Rascunho que deve continuar.');
  await assert.rejects(f.detail.act('agents:instructions-import', 'a1'), /Salve ou descarte/);
  await f.import(textFile('Não substituir.')); assert.equal(f.area.value, 'Rascunho que deve continuar.'); assert.equal(f.calls.length, 0);
  assert.match(f.notices.at(-1).message, /Salve ou descarte/);
});

test('imported instructions cannot start inference before review and explicit CAS save; multi-file selection leaves the draft intact', async t => {
  const f = fixture(t, { features: ['agent-preview'] });
  await f.choose([textFile('Um.'), textFile('Dois.')]); assert.equal(f.area.value, 'Texto salvo.'); assert.match(f.notices.at(-1).message, /único arquivo/);
  await f.import(textFile('Texto importado.')); await f.detail.submit({ dataset: { form: 'agents:preview', id: 'a1' } });
  assert.equal(f.calls.length, 0); assert.match(f.notices.at(-1).message, /Revise e salve.*antes de testar/);
  assert.match(f.view(), /Revise e salve as instruções importadas antes de testar/);
  await f.detail.submit(f.form); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.version, 7);
  assert.doesNotMatch(f.view(), /Revise e salve as instruções importadas antes de testar/);
});

test('late imports are discarded after tenant, workspace, agent, version, session, role, modal, form, route, reset or draft changes', { timeout: 3000 }, async t => {
  for (const [boundary, change] of [
    ['tenant', f => { f.state.tenant.id = 't2'; }], ['workspace', f => { f.state.workspaceId = 'w2'; }],
    ['agent', f => { globalThis.location.hash = '#agents/a2/instructions'; f.view(); }], ['version', f => { f.agent.version++; }],
    ['session', f => { f.state.boot.session = { ...f.state.boot.session }; }], ['user', f => { f.state.boot.session.userId = 'u2'; }],
    ['role', f => { f.state.boot.session.role = 'operator'; }], ['modal', f => { f.modal.open = true; }],
    ['detached form', f => { f.form.isConnected = false; }], ['replaced form', f => { f.changeForm({ ...f.form }); }],
    ['route', () => { globalThis.location.hash = '#inbox'; }], ['reset', f => { f.detail.reset(); }],
    ['draft', f => { f.type('Minha digitação durante a leitura.'); }], ['draft restored', f => { f.type('Mudança.'); f.type('Texto salvo.'); }]
  ]) await t.test(boundary, async child => {
    const f = fixture(child), wait = deferred(), started = deferred(), buffer = await textFile('Importação tardia.').arrayBuffer();
    const pending = f.import({ name: 'tardio.md', type: 'text/markdown', size: buffer.byteLength, arrayBuffer: () => { started.resolve(); return wait.promise; } });
    await started.promise; change(f); wait.resolve(buffer); await pending; await tick();
    assert.notEqual(f.area.value, 'Importação tardia.'); assert.equal(f.agent.instructions, 'Texto salvo.'); assert.equal(f.calls.length, 0);
    assert.equal(f.notices.some(notice => /Arquivo importado/.test(notice.message)), false);
  });
});

test('export downloads only visible name, description and unsaved instructions, then revokes its local URL without API calls', async t => {
  const f = fixture(t); f.type('## Papel\nTexto visível ainda não salvo.');
  await f.detail.act('agents:instructions-export', 'a1');
  assert.equal(f.blobs.length, 1); const markdown = await f.blobs[0].text();
  assert.equal(markdown, '# Perfil do agente\n\n## Nome\nSuporte Acácias\n\n## Descrição\nAtendimento da empresa.\n\n## Instruções\n## Papel\nTexto visível ainda não salvo.\n');
  assert.doesNotMatch(markdown, /SYNTHETIC_PRIVATE|apiKey|tools|runtime|private-conversation/); assert.equal(f.calls.length, 0);
  assert.deepEqual(f.downloads, [{ href: 'blob:profile-1', filename: 'perfil-Suporte-Acacias.md' }]); assert.deepEqual(f.revoked, ['blob:profile-1']);
  assert.equal(f.agent.instructions, 'Texto salvo.');
  assert.throws(() => agentProfileMarkdown({ name: 'Nome\nInjetado', description: '' }, 'Texto'), /Confira/);
});

test('explicit native clipboard copy includes only visible profile fields and the unsaved editor without API or download calls', async t => {
  const f = fixture(t); f.type('## Papel\nRevisão visível ainda não salva.');
  assert.match(f.view(), /Exportar perfil Markdown[\s\S]*data-action="agents:instructions-copy"[\s\S]*Copiar perfil Markdown/);
  await f.detail.act('agents:instructions-copy', 'a1');
  assert.deepEqual(f.copies, [agentProfileMarkdown(f.agent, f.area.value)]);
  assert.doesNotMatch(f.copies[0], /SYNTHETIC_PRIVATE|apiKey|tools|runtime|private-conversation/);
  assert.equal(f.agent.instructions, 'Texto salvo.'); assert.equal(f.agent.version, 7);
  assert.equal(f.calls.length, 0); assert.equal(f.blobs.length, 0); assert.equal(f.downloads.length, 0);
  assert.match(f.notices.at(-1).message, /Perfil Markdown copiado/); assert.equal(f.notices.at(-1).tone, 'success');
});

test('unavailable or denied clipboard returns a localized actionable error without echoing provider errors', async t => {
  const f = fixture(t);
  f.clipboard.writeText = undefined;
  await assert.rejects(f.detail.act('agents:instructions-copy', 'a1'), /Selecione e copie.*Exportar perfil Markdown/);
  f.clipboard.writeText = async () => { throw new Error('SYNTHETIC_PRIVATE_PROVIDER_ERROR'); };
  await assert.rejects(f.detail.act('agents:instructions-copy', 'a1'), error => /Selecione e copie.*Exportar perfil Markdown/.test(error.message) && !error.message.includes('SYNTHETIC_PRIVATE'));
  assert.equal(f.copies.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.notices.length, 0);
  setLocale('en', { persist: false, notify: false });
  await assert.rejects(f.detail.act('agents:instructions-copy', 'a1'), /Select and copy the editor text or use Export Markdown profile/);
});

test('clipboard completion never confirms success in a stale authority or replaced profile view', async t => {
  for (const [boundary, change] of [
    ['tenant', f => { f.state.tenant.id = 't2'; }], ['workspace', f => { f.state.workspaceId = 'w2'; }],
    ['agent', f => { globalThis.location.hash = '#agents/a2/instructions'; f.view(); }], ['version', f => { f.agent.version++; }],
    ['session', f => { f.state.boot.session = { ...f.state.boot.session }; }], ['user', f => { f.state.boot.session.userId = 'u2'; }],
    ['role', f => { f.state.boot.session.role = 'operator'; }], ['support grant', f => { f.state.supportGrantId = 'other-grant'; }],
    ['modal', f => { f.modal.open = true; }], ['detached form', f => { f.form.isConnected = false; }], ['replaced form', f => { f.changeForm({ ...f.form }); }],
    ['route', () => { globalThis.location.hash = '#inbox'; }], ['reset', f => { f.detail.reset(); }], ['draft', f => { f.type('Texto alterado.'); }],
    ['name', f => { f.agent.name = 'Nome alterado'; }], ['description', f => { f.agent.description = 'Descrição alterada'; }]
  ]) await t.test(boundary, async child => {
    const f = fixture(child), wait = deferred();
    f.clipboard.writeText = text => { f.copies.push(text); return wait.promise; };
    const pending = f.detail.act('agents:instructions-copy', 'a1');
    assert.equal(f.copies.length, 1); change(f); wait.resolve(); await pending;
    assert.equal(f.notices.length, 0); assert.equal(f.calls.length, 0);
  });
});

test('profile actions refuse operators, other providers, detached views and open modals without reading or downloading files', async t => {
  for (const options of [{ admin: false }, { provider: 'mcp' }, { provider: 'codex' }]) await t.test(JSON.stringify(options), async child => {
    const f = fixture(child, options); await assert.rejects(f.detail.act('agents:instructions-import', 'a1'), /administração/);
    await assert.rejects(f.detail.act('agents:instructions-export', 'a1'), /administração/); assert.equal(f.calls.length, 0); assert.equal(f.blobs.length, 0);
    await assert.rejects(f.detail.act('agents:instructions-copy', 'a1'), /administração/); assert.equal(f.copies.length, 0);
  });
  const f = fixture(t); f.modal.open = true; await assert.rejects(f.detail.act('agents:instructions-export', 'a1'), /administração/); assert.equal(f.blobs.length, 0);
  await assert.rejects(f.detail.act('agents:instructions-copy', 'a1'), /administração/); assert.equal(f.copies.length, 0);
});

test('PT/EN guidance distinguishes managed stateless context from native Hermes memory and keeps the existing generic connection journey', () => {
  const state = { tenant: { id: 't1', agents: [{ id: 'a1', name: 'Suporte', provider: 'hermes', version: 1, instructions: '' }] } };
  let owner = false;
  const detail = createAgentDetail({ state, context: () => ({ admin: true, owner, scope: 'w1:t1', features: new Set() }) });
  let html = detail.view(parseHash('#agents/a1/instructions'));
  assert.match(html, /sem sessão ou memória nativa persistente/); assert.match(html, /não é a memória nativa do seu agente/); assert.match(html, /href="#agents\/connect"[^>]*>Conectar meu agente/);
  assert.match(html, /Importar só preenche o editor/); assert.doesNotMatch(html, /Hermes|Elozi/);
  owner = true; html = detail.view(parseHash('#agents/a1/instructions')); assert.match(html, /não é a memória nativa do Hermes/); assert.match(html, /Conectar Hermes próprio/);
  setLocale('en', { persist: false, notify: false }); html = detail.view(parseHash('#agents/a1/instructions'));
  assert.match(html, /without a persistent session or native memory/); assert.match(html, /not native Hermes memory/); assert.match(html, /Import TXT \/ MD/); assert.match(html, /Export Markdown profile/); assert.match(html, /Copy Markdown profile/); assert.match(html, /Connect your own Hermes/);
  assert.doesNotMatch(html, /Importar só|Importar TXT|Conectar Hermes próprio|Perfil e memória/);
  owner = false; html = detail.view(parseHash('#agents/a1/instructions')); assert.doesNotMatch(html, /Hermes|Elozi/); assert.match(html, /not your agent&#39;s native memory/); assert.match(html, /Connect my agent/);
});
