import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import * as i18n from '../public/i18n.js';
import { createJsonRead } from '../public/json-read.js';
import { flowDepartmentOptions } from '../public/flow-departments-ui.js';
import '../public/locales-shell.js';
import '../public/locales-product-review.js';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const acorn = { exports: {} };
new Function('exports', 'module', process.binding('natives')['internal/deps/acorn/acorn/dist/acorn'])(acorn.exports, acorn);
const tree = acorn.exports.parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
const definition = name => {
  const node = tree.body.find(node => node.type === 'FunctionDeclaration' && node.id.name === name);
  assert.ok(node, 'Exercise the served function: ' + name);
  return source.slice(node.start, node.end);
};
const submitNode = tree.body.find(node => {
  const call = node.expression;
  return call?.type === 'CallExpression' && call.callee.type === 'MemberExpression'
    && call.callee.property.name === 'addEventListener' && call.arguments[0]?.value === 'submit'
    && call.callee.object.type === 'CallExpression' && call.callee.object.callee.name === '$'
    && call.callee.object.arguments[0]?.value === '#app';
})?.expression.arguments[1];
assert.ok(submitNode, 'Exercise the actual profile submit listener');
const executable = definition('api') + '\n' + definition('profileDraft') + '\n(' + source.slice(submitNode.start, submitNode.end) + ')';
const locale = value => i18n.setLocale(value, { persist: false, notify: false });
test.afterEach(() => locale('pt-BR'));

function fixture({ avatarLoading = false, connected = true } = {}) {
  const fields = { name: { value: 'Salvar perfil' }, phone: { value: '+55 11 90000-0000' }, bio: { value: 'Descrição · Salvar perfil <texto próprio>' } };
  const submit = { innerHTML: '<svg data-glyph="check"></svg> Salvar perfil', textContent: '', disabled: false, isConnected: connected };
  const feedback = { textContent: '' }, removePhoto = { disabled: false }, choosePhoto = { disabled: false };
  const attributes = new Map(), controls = [...Object.values(fields), submit, removePhoto, choosePhoto];
  const form = {
    id: 'profile-form', isConnected: connected,
    elements: { namedItem: name => fields[name] }, matches: () => false,
    querySelector: selector => selector === '[type="submit"]' ? submit : selector === '.form-error' ? feedback : null,
    querySelectorAll: () => controls,
    setAttribute: (name, value) => attributes.set(name, value), removeAttribute: name => attributes.delete(name)
  };
  const user = { id: 'synthetic-operator', name: 'Nome anterior', phone: '', bio: '', avatar: null };
  const state = { busy: false, avatarLoading, workspaceId: 'synthetic-workspace', boot: { csrfToken: 'synthetic-csrf', session: { userId: user.id, name: user.name } }, account: { user }, users: [user], profileDraft: null };
  const calls = [], toasts = [];
  let deliver, started, renders = 0, prevented = 0;
  const response = new Promise(resolve => { deliver = resolve; });
  const requestStarted = new Promise(resolve => { started = resolve; });
  const idle = { submit: async () => false };
  const fetch = async (path, options) => { calls.push({ path, options }); started(); return response; };
  const handle = runInNewContext(executable, {
    ...i18n, state, accountSecurityUI: idle, contactLinksUI: idle, workspaceUI: idle, automationUI: idle,
    icon: glyph => '<svg data-glyph="' + glyph + '"></svg>',
    $: selector => selector === '[data-action="remove-profile-photo"]' ? removePhoto : selector === '[data-action="choose-profile-photo"]' ? choosePhoto : null,
    fetch, readJsonResponse: createJsonRead({ fetch }),
    render() { renders++; }, toast: (message, error) => toasts.push({ message, error }),
    location: { assign() { assert.fail('This profile journey must keep the session'); } }
  });
  return { state, fields, submit, feedback, removePhoto, choosePhoto, form, controls, attributes, calls, toasts, requestStarted,
    start: () => {
      const pending = handle({ target: form, preventDefault() { prevented++; } });
      // A regression before fetch must fail the assertions, not hang waiting for fetch forever.
      void pending.then(() => started(), () => started());
      return pending;
    },
    deliver: (status, result) => deliver(new Response(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json' } })),
    get renders() { return renders; }, get prevented() { return prevented; }
  };
}

function assertRestored(f, language) {
  assert.equal(f.submit.innerHTML, '<svg data-glyph="check"></svg> ' + (language === 'en' ? 'Save profile' : 'Salvar perfil'));
  assert.equal(f.submit.disabled, f.state.avatarLoading);
  assert.equal(f.state.busy, false); assert.equal(f.attributes.has('aria-busy'), false);
  assert.equal(f.removePhoto.disabled, true); assert.equal(f.choosePhoto.disabled, f.state.avatarLoading);
  assert.equal(f.prevented, 1);
}

for (const language of ['pt-BR', 'en']) {
  test('profile API rejection restores the button and draft in ' + language, { timeout: 5000 }, async () => {
    locale(language); const f = fixture(), before = JSON.stringify(f.fields), userBefore = JSON.stringify(f.state.account.user);
    const pending = f.start(); await f.requestStarted;
    assert.equal(f.submit.textContent, language === 'en' ? 'Saving profile…' : 'Salvando perfil…');
    assert.equal(f.state.busy, true); assert.equal(f.attributes.get('aria-busy'), 'true');
    assert.ok(f.controls.every(control => control.disabled));
    const request = f.calls[0]; assert.equal(request.path, '/api/auth/me'); assert.equal(request.options.method, 'PATCH');
    assert.equal(request.options.body, JSON.stringify({ name: f.fields.name.value, phone: f.fields.phone.value, bio: f.fields.bio.value }));
    assert.equal(request.options.headers['X-CSRF-Token'], 'synthetic-csrf'); assert.equal(request.options.headers['X-Elozi-Workspace'], 'synthetic-workspace');
    f.deliver(422, { error: 'Aguarde a preparação da foto.' }); await pending;
    assert.equal(f.feedback.textContent, language === 'en' ? 'Wait for the photo to be prepared.' : 'Aguarde a preparação da foto.');
    assertRestored(f, language); assert.equal(f.renders, 0); assert.deepEqual(f.toasts, []);
    assert.equal(JSON.stringify(f.state.account.user), userBefore);
    assert.equal(f.state.profileDraft.name, f.fields.name.value); assert.equal(f.state.profileDraft.bio, f.fields.bio.value);
    assert.equal(JSON.stringify(Object.fromEntries(Object.entries(f.fields).map(([name, field]) => [name, { value: field.value }]))), before);
    assert.ok(Object.values(f.fields).every(field => !field.disabled));
  });

  test('profile photo preparation rejection restores the button without a request in ' + language, { timeout: 5000 }, async () => {
    locale(language); const f = fixture({ avatarLoading: true }); await f.start();
    assert.equal(f.feedback.textContent, language === 'en' ? 'Wait for the photo to be prepared.' : 'Aguarde a preparação da foto.');
    assertRestored(f, language); assert.deepEqual(f.calls, []); assert.equal(f.renders, 0);
    assert.ok(Object.values(f.fields).every(field => !field.disabled));
  });
}

test('profile success keeps the edited content and translates the post-action toast', { timeout: 5000 }, async () => {
  locale('en'); const f = fixture(), pending = f.start(); await f.requestStarted;
  const saved = { id: 'synthetic-operator', name: f.fields.name.value, phone: f.fields.phone.value, bio: f.fields.bio.value, avatar: null };
  f.deliver(200, { user: saved }); await pending;
  assertRestored(f, 'en'); assert.equal(f.renders, 1);
  assert.equal(JSON.stringify(f.state.account.user), JSON.stringify(saved));
  assert.equal(f.state.boot.session.name, 'Salvar perfil'); assert.equal(f.state.account.user.bio, 'Descrição · Salvar perfil <texto próprio>');
  assert.deepEqual(f.toasts, [{ message: 'Profile saved.', error: undefined }]);
});

test('new flow action translates the literal description field while preserving its form contract', () => {
  const pending = [tree]; let flowCase;
  while (pending.length) {
    const node = pending.pop();
    if (node?.type === 'SwitchCase' && node.test?.value === 'new-flow') { flowCase = node; break; }
    if (node && typeof node === 'object') for (const value of Object.values(node)) {
      if (Array.isArray(value)) pending.push(...value); else if (value?.type) pending.push(value);
    }
  }
  assert.ok(flowCase, 'Exercise the served new-flow action');
  const fieldDefinitions = ['field', 'selectField'].map(name => {
    const statement = tree.body.find(node => node.type === 'VariableDeclaration' && node.declarations.some(value => value.id.name === name));
    assert.ok(statement); return source.slice(statement.start, statement.end);
  }).join('\n');
  const statement = flowCase.consequent.find(node => node.type === 'ExpressionStatement' && node.expression.type === 'CallExpression' && node.expression.callee.name === 'formModal');
  assert.ok(statement, 'Extract the real formModal call independently of navigation guards.');
  const copy = source.slice(statement.start, statement.end), mounted = [];
  const open = () => runInNewContext(fieldDefinitions + '\n' + copy, { ...i18n, state: { tenant: { departments: [] } }, flowDepartmentOptions, escape: String, formModal: (...args) => mounted.push(args) });
  locale('pt-BR'); open(); const pt = mounted.at(-1);
  locale('en'); open(); const en = mounted.at(-1);
  assert.match(pt[3], /<label>Descrição<input name="description" maxlength="200"\/><\/label>/);
  assert.match(en[3], /<label>Description<input name="description" maxlength="200"\/><\/label>/);
  assert.equal(en[2], 'flow'); assert.equal(en[2], pt[2]);
  for (const markup of [pt[3], en[3]]) {
    assert.match(markup, /input name="name" maxlength="80" required/);
    assert.match(markup, /select name="template"/); assert.match(markup, /option value="linear"/); assert.match(markup, /option value="conditional"/);
  }
  locale('pt-BR'); open(); assert.deepEqual(mounted.at(-1), pt);
});
