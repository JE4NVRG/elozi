import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// Reproduce the production wizard loading before the journey.
import '../public/locales-agent-connect.js';
import { createServicePrincipalsUI } from '../public/service-principals-ui.js';
import { setLocale } from '../public/i18n.js';

const locale = value => setLocale(value, { persist: false, notify: false });
test.afterEach(() => locale('pt-BR'));
function fixture() {
  const context = { workspaceId: 'workspace-a', tenantId: 'company-a', userId: 'admin-a', authorityKey: 'authority-a', isAdmin: true, publicOrigin: 'https://elozi.example.test', agents: [{ id: 'hermes-a', name: 'Assistente interno', provider: 'hermes', mode: 'copilot', configured: true }, { id: 'mcp-a', name: 'Meu agente via MCP <cliente>', provider: 'mcp', mode: 'copilot', configured: true }], channels: [{ id: 'wa-a', name: 'Canal <próprio>' }, { id: 'tg-a', name: 'Telegram' }], departments: [{ id: 'support-a', name: 'Departamento próprio', active: true }] };
  const modal = { html: '', addEventListener() {}, querySelector() { return null; } }, calls = [], errors = [], updates = [];
  const ui = createServicePrincipalsUI({ getContext: () => context, request: async (path, init) => { calls.push({ path, init }); return { principals: [] }; }, openModal: (title, subtitle, html) => Object.assign(modal, { title, subtitle, html }), getModal: () => modal, onError: value => errors.push(value), onUpdate: () => updates.push(true) });
  return { ui, context, modal, calls, errors, updates };
}

test('journey distinguishes internal and external agents in PT/EN/PT without requests or data translation', () => {
  const f = fixture(), before = JSON.stringify(f.context); locale('pt-BR'); const pt = f.ui.markup();
  locale('en'); const en = f.ui.markup();
  assert.match(pt, /Assistente interno/); assert.match(en, /Internal assistant/); assert.match(en, /My agent via MCP/);
  assert.match(en, /data-view="agents"/); assert.match(en, /data-service-principal-action="start-external"/);
  assert.match(en, /multiple authorized channels/); assert.match(en, /Connecting to the panel does not grant that access automatically/);
  for (const copy of [pt, en]) assert.doesNotMatch(copy, /Hermes|Elozi/, 'motor e marca da plataforma fora dos workspaces de clientes');
  locale('pt-BR'); assert.equal(f.ui.markup(), pt); assert.equal(JSON.stringify(f.context), before); assert.equal(f.calls.length, 0);
});

test('external entry selects MCP rather than configured Hermes and never creates an identity on entry', async () => {
  const f = fixture(); await f.ui.action('start-external');
  assert.match(f.modal.html, /value="mcp-a" selected/); assert.match(f.modal.html, /Meu agente via MCP &lt;cliente&gt;/);
  assert.match(f.modal.html, /value="conversation\.read" checked/); assert.doesNotMatch(f.modal.html, /value="reply\.submit" checked/); assert.doesNotMatch(f.modal.html, /value="reply\.draft"/);
  for (const capability of ['reply.send', 'message.schedule', 'company.read', 'company.propose', 'handoff.request']) {
    const input = f.modal.html.match(new RegExp('<input[^>]*value="' + capability.replace('.', '\\.') + '"[^>]*>'));
    assert.ok(input); assert.equal(input[0].includes(' checked'), false);
  }
  assert.equal(f.calls.length, 0);
});

test('missing MCP adapter shows preparation steps without silently falling back to internal assistant', async () => {
  const f = fixture(); f.context.agents = f.context.agents.filter(agent => agent.provider !== 'mcp');
  await f.ui.action('start-external'); assert.equal(f.modal.html, ''); assert.equal(f.updates.length, 1);
  assert.match(f.ui.markup(), /Prepare a conexão do seu agente/); assert.match(f.ui.markup(), /Nenhuma identidade ou chave foi criada/);
  locale('en'); assert.match(f.ui.markup(), /No identity or key has been created/);
  f.context.tenantId = 'company-b'; assert.doesNotMatch(f.ui.markup(), /class="service-journey-preparation"/);
  assert.equal(f.calls.length, 0); assert.equal(f.errors.length, 0);
});

test('operator cannot start external setup or see administrative journey', async () => {
  const f = fixture(); f.context.isAdmin = false;
  assert.equal(f.ui.markup(), ''); await f.ui.action('start-external'); assert.equal(f.modal.html, '');
  assert.equal(f.calls.length, 0); assert.equal(f.updates.length, 0); assert.match(f.errors[0], /administrador/);
});

test('editor explains company, scope, private sending and group-only scheduling in both languages', async () => {
  const f = fixture(); await f.ui.action('start-external');
  assert.match(f.modal.html, /empresa atual/); assert.match(f.modal.html, /canais atuais e futuros/);
  assert.match(f.modal.html, /Consulta de contexto/); assert.match(f.modal.html, /Rascunhos e propostas/); assert.match(f.modal.html, /Envio e agendamento/);
  assert.match(f.modal.html, /Eventos e gestão do atendimento/); assert.match(f.modal.html, /atendimentos privados atribuídos a eles/); assert.match(f.modal.html, /Agendamento é exclusivo dos grupos/);
  assert.match(f.modal.html, /sem revisão de cada mensagem/); assert.match(f.modal.html, /Canal &lt;próprio&gt;/);
  locale('en'); await f.ui.action('start-external');
  assert.match(f.modal.html, /current company/); assert.match(f.modal.html, /current and future channels/);
  assert.match(f.modal.html, /Read context/); assert.match(f.modal.html, /Drafts and proposals/); assert.match(f.modal.html, /Sending and scheduling/);
  assert.match(f.modal.html, /Events and conversation management/); assert.match(f.modal.html, /private conversations assigned to them/); assert.match(f.modal.html, /Scheduling is available only for groups/);
  assert.match(f.modal.html, /Canal &lt;próprio&gt;/); assert.match(f.modal.html, /Departamento próprio/);
  assert.doesNotMatch(f.modal.html, /name="channelIds-all" value="all" checked/); assert.doesNotMatch(f.modal.html, /name="departmentIds-all" value="all" checked/); assert.equal(f.calls.length, 0);
});

for (const scope of ['channelIds', 'departmentIds']) test('specific ' + scope + ' deselects all and selecting all clears specifics without automatic broadening', async () => {
  const f = fixture(); await f.ui.action('start-external');
  const token = f.modal.html.match(/data-service-principal-token="([^"]+)"/)[1];
  const all = { name: scope + '-all', checked: true }, one = { name: scope, checked: false }, two = { name: scope, checked: false };
  const form = { dataset: { servicePrincipalToken: token }, querySelector: selector => selector === 'input[name="' + scope + '-all"]' ? all : null, querySelectorAll: () => [one, two] };
  const change = field => f.ui.handleChange({ target: { ...field, matches: selector => selector.includes('input[type="checkbox"]'), closest: () => form } });
  one.checked = true; assert.equal(change(one), true); assert.equal(all.checked, false);
  all.checked = true; two.checked = true; change(all); assert.equal(one.checked, false); assert.equal(two.checked, false);
  all.checked = false; change(all); assert.equal(all.checked, false); assert.equal(one.checked, false);
  f.context.authorityKey = 'new-authority'; one.checked = true; all.checked = true; change(one); assert.equal(all.checked, true);
  assert.equal(f.calls.length, 0);
});

const selectedCapabilities = html => [...html.matchAll(/<input[^>]*name="capabilities"[^>]*value="([^"]+)"[^>]* checked/g)].map(match => match[1]);
test('four objectives suggest minimum capabilities without wildcard scope, direct sending or remote actions', async () => {
  const profiles = { consult: ['conversation.read'], draft: ['conversation.read','reply.draft'], team: ['conversation.read','handoff.request'], management: ['company.read'] };
  for (const [objective, capabilities] of Object.entries(profiles)) {
    const f = fixture(); await f.ui.action('choose-objective', objective);
    assert.deepEqual(selectedCapabilities(f.modal.html), capabilities, objective);
    assert.match(f.modal.html, new RegExp('name="objective"[^>]*>[\\s\\S]*value="' + objective + '" selected'));
    for (const name of ['channelIds','channelIds-all','departmentIds','departmentIds-all','reviewAccess']) assert.doesNotMatch(f.modal.html, new RegExp('name="' + name + '"[^>]* checked'), name);
    assert.match(f.modal.html, /name="reviewAccess"[^>]*required/);
    for (const step of ['1. Objetivo','2. Adaptador','3. Capacidades e escopo','4. Limites e validade','5. Revise o acesso']) assert.ok(f.modal.html.includes(step), step);
    assert.equal(f.calls.length, 0);
  }
});

test('draft objective uses the existing MCP adapter contract and leaves publishing unselected', async () => {
  const f = fixture(); f.context.agents.reverse(); await f.ui.action('choose-objective', 'draft');
  assert.deepEqual(selectedCapabilities(f.modal.html), ['conversation.read','reply.submit']);
  assert.match(f.modal.html, /value="mcp-a" selected/);
  assert.doesNotMatch(f.modal.html, /value="(?:reply\.send|message\.schedule|company\.propose)" checked/);
  assert.match(f.modal.html, /A equipe revisa e envia os rascunhos|Preparar rascunhos para a equipe revisar e enviar/);
  assert.equal(f.calls.length, 0);
});

test('draft objective explains unsupported adapters without implying an automatic reply runtime', async () => {
  const f = fixture(); f.context.agents[0].mode = 'automatic'; await f.ui.action('choose-objective', 'draft');
  assert.deepEqual(selectedCapabilities(f.modal.html), ['conversation.read']);
  assert.match(f.modal.html, /Este adaptador não prepara rascunhos/); assert.equal(f.calls.length, 0);
  locale('en'); await f.ui.action('choose-objective', 'draft'); assert.match(f.modal.html, /This adapter does not prepare drafts/);
});

test('objectives and review are bilingual while adapter, channel and department names remain customer data', async () => {
  const f = fixture(); locale('en'); const journey = f.ui.markup();
  for (const label of ['Look up information','Prepare replies','Help the team','Help with management']) assert.ok(journey.includes(label), label);
  await f.ui.action('choose-objective', 'team');
  for (const step of ['1. Objective','2. Adapter','3. Capabilities and scope','4. Limits and expiry','5. Review access']) assert.ok(f.modal.html.includes(step), step);
  assert.match(f.modal.html, /I have reviewed this company’s capabilities, channels, departments and limits/);
  assert.match(f.modal.html, /Assistente interno<\/option>/); assert.match(f.modal.html, /Canal &lt;próprio&gt;/); assert.match(f.modal.html, /Departamento próprio/);
  assert.match(f.modal.html, /None selected/); assert.equal(f.calls.length, 0);
});

test('unknown objective and foreign authority cannot open an editor or create credentials', async () => {
  const f = fixture(); await f.ui.action('choose-objective', 'reply.autonomous');
  assert.equal(f.modal.html, ''); assert.match(f.errors.at(-1), /objetivo disponível/);
  f.context.isAdmin = false; await f.ui.action('choose-objective', 'management');
  assert.equal(f.modal.html, ''); assert.equal(f.calls.length, 0);
});

test('objective and review controls retain keyboard focus treatment, 44px targets and a mobile column', () => {
  const css = readFileSync(new URL('../public/service-principals.css', import.meta.url), 'utf8');
  assert.match(css, /\.service-objective-choice\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /\.service-review-confirm\s*\{[^}]*min-height:\s*44px/);
  assert.match(css, /@media \(max-width: 600px\)\s*\{\s*\.service-objective-choices, \.service-review-summary\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(css, /:focus-visible\s*\{[^}]*outline:/);
});
