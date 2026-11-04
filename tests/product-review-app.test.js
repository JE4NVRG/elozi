import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as i18n from '../public/i18n.js';
import { createFlowDraftGuard, createFlowTemplate } from '../public/flow-workspace-ui.js';
import { flowEditorGraph } from '../public/flow-departments-ui.js';
import '../public/locales-shell.js';
import * as nav from '../public/nav-config.js';
// The area descriptions of the palette live in nav-config.js since P10 (navigation-search-ui.js retired).
const { navigationDescriptions } = nav;

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const acorn = { exports: {} };
new Function('exports', 'module', process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'])(acorn.exports, acorn);
const tree = acorn.exports.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const copy = node => source.slice(node.start, node.end);
const definition = name => {
  const node = tree.body.find(item => item.type === 'FunctionDeclaration' && item.id.name === name);
  assert.ok(node, 'Exercise the served function: ' + name); return copy(node);
};
const variable = name => {
  const node = tree.body.find(item => item.type === 'VariableDeclaration' && item.declarations.some(value => value.id.name === name));
  assert.ok(node, 'Exercise the served variable: ' + name); return node;
};
const listener = (element, event) => {
  const node = tree.body.find(item => {
    const call = item.expression;
    return call?.callee?.property?.name === 'addEventListener' && call.arguments[0]?.value === event && call.callee.object?.arguments?.[0]?.value === element;
  })?.expression.arguments[1];
  assert.ok(node, 'Exercise the served ' + element + ' ' + event + ' listener'); return node;
};
const clickStatements = listener('#app', 'click').body.body;
const flowStatementIndex = clickStatements.findIndex(node => node.type === 'VariableDeclaration' && node.declarations.some(value => value.id.name === 'flowItem'));
assert.ok(flowStatementIndex >= 0);
const flowClick = '(async event => {' + copy(clickStatements[flowStatementIndex]) + copy(clickStatements[flowStatementIndex + 1]) + '})';
const modalSubmit = copy(listener('#modal', 'submit'));
const newFlowCase = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === 'act').body.body.find(node => node.type === 'SwitchStatement').cases.find(node => node.test?.value === 'new-flow');
assert.ok(newFlowCase);
const newFlowAction = '(async () => { switch("new-flow") {' + copy(newFlowCase) + '} })';
const locale = value => i18n.setLocale(value, { persist: false, notify: false });
test.afterEach(() => locale('pt-BR'));

const graph = () => ({ departmentReferenceFormat: 'id-v1', nodes: [{ id: 'start', type: 'start', config: {} }, { id: 'tag', type: 'tag', config: { tag: 'original' } }, { id: 'end', type: 'end', config: {} }], edges: [{ from: 'start', to: 'tag' }, { from: 'tag', to: 'end' }] });
function fixture({ rejectSave = false } = {}) {
  const flow = { id: 'synthetic-flow-a', name: 'Nome manual · Suporte', version: 3, graph: graph() };
  const state = { busy: false, workspaceId: 'synthetic-workspace-a', supportGrantId: null, boot: { session: { userId: 'synthetic-user', role: 'reseller', permissions: [] }, tenants: [{ id: 'synthetic-tenant-a' }] }, tenant: { id: 'synthetic-tenant-a', departments: [{ id: 'department-stable-id', name: 'Nome manual · Suporte', active: true }] }, flows: [flow, { ...flow, id: 'synthetic-flow-b' }], flowId: flow.id, flowDraft: graph(), flowDirty: true };
  state.flowDraft.nodes[1].config.tag = 'unsaved';
  const listeners = new Map(), feedback = { textContent: '' }, controls = ['cancel', 'discard', 'save'].map(choice => ({ dataset: { flowDraftChoice: choice }, disabled: false, focus() {} }));
  const modal = { open: false, addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); }, removeEventListener(type, callback) { listeners.get(type)?.delete(callback); }, querySelector: selector => selector === '.form-error' ? feedback : controls[0], querySelectorAll: () => controls, close() { this.open = false; for (const callback of [...listeners.get('close') || []]) callback({}); } };
  const workspaceSelect = { value: 'synthetic-new-workspace' }, app = { innerHTML: '' }, requests = [], opened = [], toasts = [];
  let refreshes = 0, resets = 0, renders = 0, deliver, started;
  const response = new Promise(resolve => { deliver = resolve; }), requestStarted = new Promise(resolve => { started = resolve; });
  const context = { ...i18n, structuredClone, state, createFlowDraftGuard, createFlowTemplate, flowEditorGraph,
    escape: String, mediaUI: { sending: false, draft: '', syncContext: () => true }, voiceRecorder: { busy: false }, blockPendingSend: () => false, attendanceContext: () => ({}),
    $: selector => selector === '#modal' ? modal : selector === '#app' ? app : selector === '#workspace-select' ? workspaceSelect : null,
    api: async (path, options) => { requests.push({ path, options }); started(); if (rejectSave) throw Object.assign(new Error('O fluxo mudou. Atualize antes de continuar.'), { status: 409 }); return response; },
    tenantApi: tail => '/api/tenants/' + state.tenant.id + '/' + tail,
    async refresh() { refreshes++; const saved = JSON.parse(requests.at(-1).options.body); state.flows = state.flows.map(item => item.id === flow.id ? { ...item, version: 4, graph: saved.graph } : item); return true; },
    resetWorkspaceSelection() { resets++; state.flowId = null; state.flowDraft = null; state.flowDirty = false; },
    openModal(title, description, body) { opened.push({ title, description, body }); modal.open = true; },
    render() { renders++; }, toast: (message, error) => toasts.push({ message, error })
  };
  const served = ['selectFlow', 'saveFlow'].map(definition).join('\n') + '\n' + copy(variable('flowDraftGuard'));
  const evaluate = expression => runInNewContext(served + '\n' + expression, context);
  const click = async choice => { const control = controls.find(item => item.dataset.flowDraftChoice === choice); for (const callback of [...listeners.get('click') || []]) await callback({ target: { closest: () => control } }); };
  return { state, flow, context, evaluate, requests, requestStarted, modal, feedback, controls, opened, workspaceSelect, toasts, click,
    deliver() { const saved = JSON.parse(requests.at(-1).options.body); deliver({ ...flow, version: 4, graph: saved.graph }); },
    get refreshes() { return refreshes; }, get resets() { return resets; }, get renders() { return renders; } };
}
const flowEvent = id => ({ target: { closest: () => ({ dataset: { flowId: id } }) } });

test('clicking the selected flow never replaces its unsaved graph', async () => {
  const f = fixture(), before = JSON.stringify(f.state.flowDraft); await f.evaluate(flowClick)(flowEvent(f.state.flowId));
  assert.equal(JSON.stringify(f.state.flowDraft), before); assert.equal(f.state.flowDirty, true);
  assert.equal(f.opened.length, 0); assert.equal(f.requests.length, 0); assert.equal(f.renders, 0);
});
test('changing a flow and cancelling retains the draft without saving', async () => {
  const f = fixture(), before = JSON.stringify(f.state), pending = f.evaluate(flowClick)(flowEvent('synthetic-flow-b'));
  assert.equal(f.modal.open, true); await f.click('cancel'); await pending;
  assert.equal(JSON.stringify(f.state), before); assert.equal(f.requests.length, 0); assert.equal(f.renders, 0);
});
test('CAS rejection in the navigation guard retains draft, modal and selection', async () => {
  const f = fixture({ rejectSave: true }), before = JSON.stringify(f.state.flowDraft), pending = f.evaluate(flowClick)(flowEvent('synthetic-flow-b'));
  await f.click('save'); assert.equal(f.requests.length, 1); assert.equal(f.requests[0].options.method, 'PUT');
  assert.equal(JSON.parse(f.requests[0].options.body).version, 3); assert.equal(JSON.stringify(f.state.flowDraft), before);
  assert.equal(f.state.flowDirty, true); assert.equal(f.state.flowId, 'synthetic-flow-a'); assert.equal(f.modal.open, true);
  assert.ok(f.controls.every(control => !control.disabled)); assert.match(f.feedback.textContent, /fluxo mudou/);
  await f.click('cancel'); await pending; assert.equal(f.refreshes, 0); assert.equal(f.renders, 0);
});
for (const name of ['changeTenant', 'changeWorkspace']) test(name + ' cancellation preserves the complete editing state', async () => {
  const f = fixture(), before = JSON.stringify(f.state), pending = f.evaluate(definition(name) + '\n' + name)('synthetic-other-context');
  await f.click('cancel'); await pending; assert.equal(JSON.stringify(f.state), before); assert.equal(f.resets, 0); assert.equal(f.refreshes, 0); assert.equal(f.requests.length, 0);
  if (name === 'changeWorkspace') assert.equal(f.workspaceSelect.value, JSON.stringify([f.state.workspaceId, null]));
});
test('opening the current company keeps its selected flow and unsaved edits', async () => {
  const f = fixture(), before = JSON.stringify(f.state); let refreshes = 0;
  f.context.refresh = async () => { refreshes++; return true; };
  const changed = await f.evaluate(definition('changeTenant') + '\nchangeTenant')(f.state.tenant.id);
  assert.equal(changed, true); assert.equal(JSON.stringify(f.state), before); assert.equal(f.resets, 0); assert.equal(refreshes, 0); assert.equal(f.requests.length, 0);
});
test('new flow cancellation does not open a creation form or POST', async () => {
  const f = fixture(), before = JSON.stringify(f.state); f.context.formModal = () => assert.fail('Cancel must not open the creation form');
  const pending = f.evaluate(newFlowAction)(); await f.click('cancel'); await pending;
  assert.equal(JSON.stringify(f.state), before); assert.equal(f.requests.length, 0);
});
test('save completion preserves edits made after the PUT was serialized', async () => {
  const f = fixture(), pending = f.evaluate('saveFlow')(); await f.requestStarted;
  assert.equal(JSON.parse(f.requests[0].options.body).graph.nodes[1].config.tag, 'unsaved');
  f.state.flowDraft.nodes[1].config.tag = 'later local edit'; f.deliver(); await pending;
  assert.equal(f.state.flowDraft.nodes[1].config.tag, 'later local edit'); assert.equal(f.state.flowDirty, true);
});
test('a stale save response cannot reset a different company and flow', async () => {
  const f = fixture(), pending = f.evaluate('saveFlow')(); await f.requestStarted;
  f.state.workspaceId = 'synthetic-workspace-b'; f.state.tenant = { id: 'synthetic-tenant-b' };
  f.state.flowId = 'synthetic-other-flow'; f.state.flows = [{ id: f.state.flowId, name: 'Outro fluxo', version: 8, graph: graph() }];
  f.state.flowDraft = graph(); f.state.flowDraft.nodes[1].config.tag = 'other context'; f.state.flowDirty = true;
  const before = JSON.stringify([f.state.workspaceId, f.state.tenant, f.state.flows, f.state.flowId, f.state.flowDraft, f.state.flowDirty]);
  f.deliver(); await assert.rejects(pending, /contexto do fluxo mudou/); assert.equal(JSON.stringify([f.state.workspaceId, f.state.tenant, f.state.flows, f.state.flowId, f.state.flowDraft, f.state.flowDirty]), before); assert.equal(f.refreshes, 0);
});

function creationFixture(fields) {
  const f = fixture(); f.state.flowDirty = false;
  const feedback = { textContent: '' }, submit = { disabled: false }, form = { dataset: { dialogForm: 'flow' }, matches: () => false, querySelector: selector => selector === '[type="submit"]' ? submit : feedback };
  const idle = { submit: async () => false };
  for (const name of ['knowledgeUI', 'mcpUI', 'accountSecurityUI', 'contactLinksUI', 'workspaceUI', 'unitsUI', 'automationUI']) f.context[name] = idle;
  f.context.FormData = class { constructor() { return Object.entries(fields)[Symbol.iterator](); } };
  f.context.api = async (path, options) => { f.requests.push({ path, options }); const input = JSON.parse(options.body); f.state.flows = [{ ...input, id: 'synthetic-created', version: 1 }]; return { id: 'synthetic-created' }; };
  f.context.refresh = async () => true;
  const handle = f.evaluate(definition('flowTemplate') + '\n' + modalSubmit);
  return { ...f, feedback, submit, start: () => handle({ target: form, preventDefault() {} }) };
}
for (const language of ['pt-BR', 'en']) test('actual flow modal sends ID references and preserves manual text in ' + language, async () => {
  locale(language); const fields = { name: 'Descrição · Manual <name>', description: 'Suporte · customer text', template: 'conditional', initialDepartment: 'department-stable-id' }, f = creationFixture(fields);
  await f.start(); assert.equal(f.requests.length, 1); const request = f.requests[0]; assert.equal(request.path, '/api/tenants/synthetic-tenant-a/flows'); assert.equal(request.options.method, 'POST');
  const payload = JSON.parse(request.options.body); assert.equal(payload.name, fields.name); assert.equal(payload.description, fields.description);
  assert.equal(payload.graph.departmentReferenceFormat, 'id-v1'); assert.equal(payload.graph.nodes.find(node => node.type === 'department').config.department, 'department-stable-id');
  assert.equal(Object.hasOwn(payload, 'template'), false); assert.equal(Object.hasOwn(payload, 'initialDepartment'), false); assert.equal(f.feedback.textContent, ''); assert.equal(f.submit.disabled, false);
});
test('invalid triage department is rejected before any POST', async () => {
  const f = creationFixture({ name: 'Synthetic', template: 'conditional', initialDepartment: 'Nome manual · Suporte' });
  const before = JSON.stringify(f.state.flowDraft); await f.start(); assert.equal(f.requests.length, 0); assert.equal(JSON.stringify(f.state.flowDraft), before); assert.match(f.feedback.textContent, /departamento ativo/); assert.equal(f.submit.disabled, false);
});
test('served navigation catalog honors permissions, owner status and support scope in both languages', () => {
  const init = variable('navigationSearch').declarations.find(node => node.id.name === 'navigationSearch').init;
  const getItems = init.arguments[0].properties.find(node => node.key.name === 'getItems').value;
  // allowedNavigation reads the served navigationContext and nav-config's legacyVisible (literal oracle in navigation-matrix.test.js).
  const executable = [copy(variable('navigation')), copy(variable('hasPermission')), copy(variable('navigationContext')), definition('allowedNavigation'), '(' + copy(getItems) + ')'].join('\n');
  for (const language of ['pt-BR', 'en']) {
    locale(language); const f = fixture(); f.state.boot.session = { role: 'agent', userId: 'synthetic-user', permissions: [] };
    const items = () => runInNewContext(executable, { ...i18n, ...nav, state: f.state, navigationDescriptions })();
    let result = items(); const keys = list => new Set(list.map(item => item.key));
    for (const key of ['platform', 'platform-users', 'platform-billing', 'accounts', 'team', 'knowledge', 'tenants', 'brand', 'service-agents', 'billing', 'integrations', 'groups', 'contacts', 'metrics', 'flows', 'architecture']) assert.equal(keys(result).has(key), false, key + ' must be hidden');
    assert.equal(keys(result).has('account'), true); assert.equal(result.find(item => item.key === 'channels').label, language === 'en' ? 'Channels' : 'Canais');
    f.state.boot.session.permissions = ['flows.read', 'contacts.read']; result = items(); assert.equal(keys(result).has('flows'), true); assert.equal(keys(result).has('contacts'), true); assert.equal(keys(result).has('metrics'), false);
    f.state.boot.session = { role: 'reseller', platformOwner: true, userId: 'synthetic-user', permissions: [] }; result = items(); assert.equal(keys(result).has('platform-users'), true); assert.equal(keys(result).has('service-agents'), true);
    f.state.supportGrantId = 'synthetic-support'; result = items(); for (const key of ['platform', 'platform-users', 'platform-billing', 'integrations', 'accounts', 'team', 'knowledge', 'tenants', 'brand', 'service-agents', 'billing', 'team-chat']) assert.equal(keys(result).has(key), false, key + ' must be hidden in support scope');
  }
});

test('a failed modal opening does not leave the draft guard permanently pending', async () => {
  let throwOnce = true; const f = fixture(); f.context.openModal = (title, description, body) => { if (throwOnce) { throwOnce = false; throw new Error('Synthetic modal failure'); } f.modal.open = true; };
  const guard = f.evaluate('flowDraftGuard'); await assert.rejects(guard.confirm(), /Synthetic modal failure/);
  const retry = guard.confirm(); assert.equal(f.modal.open, true); await f.click('cancel'); assert.equal(await retry, false); assert.equal(f.state.flowDirty, true);
});
