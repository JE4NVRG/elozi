import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createAccountInvitationsUI } from '../public/account-invitations-ui.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const token = 'A'.repeat(43), origin = 'https://elozi.example.test', url = origin + '/accept-invite#token=' + token;
const target = { id: 'account-qa', name: 'Empresa <QA>', accountKind: 'business', parentWorkspaceId: 'reseller-qa', version: 2 };
const invitation = (extra = {}) => ({ id: 'invite-qa', name: 'Responsável <QA>', email: null, role: 'reseller', tenantIds: [], state: 'pending', canRevoke: true, expiresAt: '2100-01-01T10:00:00Z', ...extra });
const result = (extra = {}) => ({ invitation: invitation(), inviteUrl: url, email: { queued: false, configured: true }, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(t, intercept) {
  const previous = { FormData: globalThis.FormData, location: Object.getOwnPropertyDescriptor(globalThis, 'location'), navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') };
  globalThis.FormData = class { constructor(form) { assert.ok(form, 'FormData exige formulário original'); this.fields = form.fields; } get(name) { return this.fields[name] ?? null; } };
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { origin } });
  const clipboard = [], calls = [], opened = [], messages = [], updates = [], listeners = new Map();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => clipboard.push(value) } } });
  t.after(() => { globalThis.FormData = previous.FormData; for (const name of ['location', 'navigator']) { if (previous[name]) Object.defineProperty(globalThis, name, previous[name]); else delete globalThis[name]; } });
  const state = { workspaceId: 'reseller-qa', supportGrantId: null, boot: { csrfToken: 'csrf-qa', publicOrigin: origin, session: { userId: 'owner-qa', role: 'reseller', platformOwner: false } } };
  let items = [invitation()];
  const modal = { open: false, html: '', panel: null, form: null, input: null, error: { textContent: '' },
    querySelector(selector) {
      if (selector === '[aria-label="Link de convite do responsável"]') return this.input;
      if (selector === '.form-error') return this.error;
      if (selector === '[data-account-invitation-form]') return this.form;
      const owner = selector.match(/^\[data-account-invitation-owner(?:="([^"]+)")?\]$/); return owner && this.panel && (!owner[1] || owner[1] === this.panel.owner) ? this.panel : null;
    },
    contains(node) { return Boolean(this.open && node?.isConnected && node.root === this.panel); },
    addEventListener(event, callback) { listeners.set(event, callback); },
    close() { this.open = false; if (this.form) this.form.isConnected = false; listeners.get('close')?.(); }
  };
  const fallback = (path, init = {}) => {
    if (path.endsWith('/revoke')) { const id = decodeURIComponent(path.split('/').at(-2)), found = items.find(item => item.id === id); if (found) Object.assign(found, { state: 'revoked', canRevoke: false }); return { invitation: found }; }
    if (init.method === 'POST') return result();
    return { invitations: structuredClone(items), emailConfigured: true };
  };
  const ui = createAccountInvitationsUI({ state, escape, api: async (path, init = {}) => { calls.push({ path, init }); return intercept ? intercept(path, init, fallback) : fallback(path, init); },
    openModal(title, subtitle, html) {
      if (modal.form) modal.form.isConnected = false;
      modal.open = true; modal.html = html; modal.error = { textContent: '' }; const owner = html.match(/data-account-invitation-owner="([^"]+)"/)?.[1];
      modal.panel = owner ? { owner, dataset: { accountInvitationOwner: owner }, querySelector: selector => modal.querySelector(selector) } : null;
      const value = html.match(/aria-label="Link de convite do responsável" value="([^"]+)"/)?.[1];
      modal.input = value ? { value, attribute: value, getAttribute(name) { return name === 'value' ? this.attribute : null; }, removeAttribute(name) { if (name === 'value') this.attribute = null; } } : null;
      modal.form = html.includes('data-account-invitation-form') ? makeForm() : null; opened.push({ title, subtitle, html });
    }, getModal: () => modal, toast: (message, failed) => messages.push({ message, failed }), onUpdate: () => updates.push(true)
  });
  function makeForm(extra = {}) {
    const feedback = modal.error, button = { disabled: false }, attributes = new Map();
    return { dataset: { accountInvitationForm: '' }, fields: { name: '  Pessoa QA  ', email: '', expiresInHours: '72', ...extra }, root: modal.panel, isConnected: true, feedback, button,
      querySelector: selector => selector === '.form-error' ? feedback : selector === '[type="submit"]' ? button : null,
      setAttribute(name, value) { attributes.set(name, value); }, removeAttribute(name) { attributes.delete(name); }, getAttribute: name => attributes.get(name),
      closest(selector) { return selector.startsWith('[data-account-invitation-owner') ? this.root : null; }
    };
  }
  const form = extra => { Object.assign(modal.form.fields, extra); return modal.form; };
  function node(action, id = '') { const root = modal.panel; return { dataset: { accountInvitationAction: action, id }, root, isConnected: true, closest: selector => selector.startsWith('[data-account-invitation-owner') ? root : null }; }
  return { ui, state, calls, opened, modal, messages, updates, clipboard, form, makeForm, node, fallback, setItems: next => { items = next; } };
}

test('convites da conta usam namespace comercial, identidade escapada e opt-in de e-mail sem segredos no histórico', async t => {
  const f = fixture(t); f.setItems([invitation({ token, inviteUrl: url })]); await f.ui.open(target);
  assert.equal(f.calls[0].path, '/api/accounts/account-qa/invitations'); assert.match(f.modal.html, /Responsável &lt;QA&gt;/); assert.equal(f.modal.html.includes(token), false); assert.equal(f.modal.html.includes('type="password"'), false); assert.match(f.modal.html, /administrar somente a conta escolhida e não concede acesso a outras contas/); assert.equal(f.calls.some(call => call.init.method === 'POST'), false);
});

test('convite da própria conta explica o acesso concedido sem negar a administração da conta alvo', async t => {
  const f = fixture(t); await f.ui.open({ ...target, id: f.state.workspaceId, name: 'Minha revenda QA', accountKind: 'reseller' });
  assert.equal(f.calls[0].path, '/api/accounts/reseller-qa/invitations');
  assert.match(f.opened.at(-1).subtitle, /Minha revenda QA · O convite dá administração somente a esta conta/);
  assert.match(f.modal.html, /A pessoa escolhe a própria senha/);
  assert.match(f.modal.html, /administrar somente a conta escolhida e não concede acesso a outras contas/);
  assert.equal(f.modal.html.includes('não dá acesso à sua conta'), false);
  assert.equal(f.calls.some(call => call.init.method === 'POST'), false);
});

test('criação envia somente admin da conta alvo, identidade e pedido idempotente sem senha', async t => {
  const f = fixture(t); await f.ui.open(target); await f.ui.submit(f.form({ sendEmail: 'on' }));
  const write = f.calls.find(call => call.init.method === 'POST'), payload = JSON.parse(write.init.body);
  assert.equal(write.path, '/api/accounts/account-qa/invitations'); assert.equal(payload.name, 'Pessoa QA'); assert.equal(payload.role, 'reseller'); assert.deepEqual(payload.tenantIds, []); assert.equal(payload.sendEmail, true); assert.equal(payload.expiresInHours, 72); assert.match(payload.requestId, /^[a-f0-9-]{36}$/); assert.equal(Object.hasOwn(payload, 'password'), false);
  assert.equal(f.modal.input.value, url); assert.equal(f.updates.length, 1); assert.equal(f.clipboard.length, 0); assert.equal(f.calls.some(call => call.path.includes(token)), false);
});

test('resultado incerto é verificado com payload e requestId exatos mesmo que campos antigos mudem', async t => {
  let writes = 0; const f = fixture(t, (path, init, fallback) => { if (init.method === 'POST' && ++writes === 1) throw new Error('Resposta perdida.'); return fallback(path, init); }); await f.ui.open(target); const original = f.form({ name: 'Responsável original' }); await f.ui.submit(original);
  assert.match(f.modal.html, /Verificar convite/); original.fields.name = 'Não pode substituir o pedido'; await f.ui.handleAction(f.node('verify'));
  const bodies = f.calls.filter(call => call.init.method === 'POST').map(call => call.init.body); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]); assert.equal(JSON.parse(bodies[1]).name, 'Responsável original'); assert.equal(f.modal.input.value, url);
});

test('duplo submit fica bloqueado durante uma criação e não chama API duas vezes', async t => {
  const waiting = deferred(), f = fixture(t, (path, init, fallback) => init.method === 'POST' ? waiting.promise : fallback(path, init)); await f.ui.open(target); const form = f.form(), pending = f.ui.submit(form); await f.ui.submit(form); assert.equal(form.button.disabled, true); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1); waiting.resolve(result()); await pending; assert.equal(f.updates.length, 1);
});

test('formulário antigo não cadastra convite para outra conta após open novo', async t => {
  const f = fixture(t); await f.ui.open(target); const old = f.form(); await f.ui.open({ ...target, id: 'another-account', name: 'Outra conta' }); await f.ui.submit(old);
  assert.equal(old.isConnected, false); assert.equal(f.calls.some(call => call.init.method === 'POST'), false);
});

test('resposta de GET e erro tardios não substituem outro modal ou modal fechado', async t => {
  for (const mode of ['replaced', 'closed', 'late-error']) await t.test(mode, async child => {
    const waiting = deferred(), f = fixture(child, () => waiting.promise), loading = f.ui.open(target), before = f.opened.length;
    if (mode === 'closed') f.modal.close(); else { f.modal.panel = { owner: 'foreign-module' }; f.modal.html = 'Outro editor preservado'; }
    if (mode === 'late-error') waiting.reject(new Error('Falha tardia.')); else waiting.resolve({ invitations: [invitation()], emailConfigured: true }); await loading; assert.equal(f.opened.length, before); assert.equal(f.modal.html.includes('data-account-invitation-form'), false);
  });
});

test('resultado de POST não vaza link para modal substituído, fechado ou contexto alterado', async t => {
  for (const mode of ['replaced', 'closed', 'workspace', 'csrf', 'user']) await t.test(mode, async child => {
    const waiting = deferred(), f = fixture(child, (path, init, fallback) => init.method === 'POST' ? waiting.promise : fallback(path, init)); await f.ui.open(target); const sending = f.ui.submit(f.form()), before = f.opened.length;
    if (mode === 'replaced') { f.modal.panel = { owner: 'foreign' }; f.modal.html = 'Outro editor'; } if (mode === 'closed') f.modal.close(); if (mode === 'workspace') f.state.workspaceId = 'outside'; if (mode === 'csrf') f.state.boot.csrfToken = 'other'; if (mode === 'user') f.state.boot.session.userId = 'other';
    waiting.resolve(result()); await sending; assert.equal(f.opened.length, before); assert.equal(f.updates.length, 0); assert.equal(f.modal.input, null);
  });
});

test('troca de autoridade com formulário anterior impede novos POSTs sem depender de reset externo', async t => {
  for (const mode of ['workspace', 'csrf', 'user', 'support', 'role']) await t.test(mode, async child => {
    const f = fixture(child); await f.ui.open(target); const original = f.form(); if (mode === 'workspace') f.state.workspaceId = 'outside'; if (mode === 'csrf') f.state.boot.csrfToken = 'other'; if (mode === 'user') f.state.boot.session.userId = 'other'; if (mode === 'support') f.state.supportGrantId = 'grant'; if (mode === 'role') f.state.boot.session.role = 'operator';
    await f.ui.submit(original); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 0);
  });
});

test('403 remove controles e reset posterior impede reenvio e cópia', async t => {
  const f = fixture(t, (path, init, fallback) => { if (init.method === 'POST') throw Object.assign(new Error('Acesso revogado.'), { status: 403 }); return fallback(path, init); }); await f.ui.open(target); const original = f.form(); await f.ui.submit(original);
  assert.match(f.modal.html, /Acesso revogado/); assert.equal(f.modal.html.includes('data-account-invitation-form'), false); assert.equal(f.modal.html.includes('data-account-invitation-action="verify"'), false); f.ui.reset(); await f.ui.submit(original); await f.ui.handleAction(f.node('copy')); assert.equal(f.calls.filter(call => call.init.method === 'POST').length, 1); assert.equal(f.clipboard.length, 0);
});

test('verificação após falha de rede trata400 sem formulário nulo nem reenvio automático', async t => {
  let n = 0; const f = fixture(t, (path, init, fallback) => { if (init.method === 'POST') { if (++n === 1) throw new Error('Rede interrompida.'); throw Object.assign(new Error('Convite indisponível.'), { status: 400 }); } return fallback(path, init); }); await f.ui.open(target); await f.ui.submit(f.form()); await assert.doesNotReject(f.ui.handleAction(f.node('verify')));
  assert.match(f.modal.html, /Convite indisponível/); assert.equal(n, 2); await f.ui.handleAction(f.node('verify')); assert.equal(n, 2);
});

test('400 mantém os inputs originais para correção e não declara criação ou e-mail enviado', async t => {
  const f = fixture(t, (path, init, fallback) => { if (init.method === 'POST') throw Object.assign(new Error('E-mail inválido.'), { status: 400 }); return fallback(path, init); }); await f.ui.open(target); const form = f.form({ name: 'Nome preservado', email: 'invalid' }); await f.ui.submit(form); assert.equal(form.fields.name, 'Nome preservado'); assert.equal(form.fields.email, 'invalid'); assert.match(form.feedback.textContent, /E-mail inválido/); assert.equal(form.button.disabled, false); assert.equal(f.updates.length, 0);
});

test('URL deve ter origem permitida, caminho exato e token único só no fragmento', async t => {
  const invalid = [['query', origin + '/accept-invite?token=' + token + '#token=' + token], ['userinfo', 'https://user:password@elozi.example.test/accept-invite#token=' + token], ['outside-origin', 'https://outside.example.test/accept-invite#token=' + token], ['path', origin + '/other#token=' + token], ['extra-fragment', origin + '/accept-invite#token=' + token + '&other=secret'], ['short-token', origin + '/accept-invite#token=short']];
  for (const [label, value] of invalid) await t.test(label, async child => {
    const f = fixture(child, (path, init, fallback) => init.method === 'POST' ? result({ inviteUrl: value }) : fallback(path, init)); await f.ui.open(target); await f.ui.submit(f.form()); assert.equal(f.modal.input, null); assert.equal(f.modal.html.includes(token), false); assert.match(f.modal.html, /Verificar/); assert.equal(f.updates.length, 0);
  });
});

test('resultado ausente ou de tipo inválido não revela link nem confirma criação', async t => {
  for (const [label, response] of [['missing-url', result({ inviteUrl: undefined })], ['missing-invitation', result({ invitation: null })], ['missing-id', result({ invitation: {} })], ['numeric-id', result({ invitation: { id: 1 } })]]) await t.test(label, async child => {
    const f = fixture(child, (path, init, fallback) => init.method === 'POST' ? response : fallback(path, init)); await f.ui.open(target); await f.ui.submit(f.form()); assert.equal(f.modal.input, null); assert.equal(f.modal.html.includes(token), false); assert.match(f.modal.html, /Verificar/); assert.equal(f.updates.length, 0);
  });
});

test('copiar exige gesto explícito e contexto original; reset limpa valor e atributo do input secreto', async t => {
  const f = fixture(t); await f.ui.open(target); await f.ui.submit(f.form()); const input = f.modal.input; assert.equal(f.clipboard.length, 0); await f.ui.handleAction(f.node('copy')); assert.deepEqual(f.clipboard, [url]);
  f.state.boot.csrfToken = 'revoked'; await f.ui.handleAction(f.node('copy')); assert.equal(f.clipboard.length, 1); f.ui.reset(); assert.equal(input.value, ''); assert.equal(input.getAttribute('value'), null); await f.ui.handleAction(f.node('copy')); assert.equal(f.clipboard.length, 1);
});

test('fechar o modal impede cópia mesmo antes do listener externo e reset não preserva link copiável', async t => {
  const f = fixture(t); await f.ui.open(target); await f.ui.submit(f.form()); const old = f.node('copy'); f.modal.close(); await f.ui.handleAction(old); assert.equal(f.clipboard.length, 0); f.ui.reset(); await f.ui.handleAction(old); assert.equal(f.clipboard.length, 0);
});

test('app conecta fechamento do modal à limpeza da UI de convites comerciais', async () => {
  const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.equal(/\$\('#modal'\)\.addEventListener\('close',[\s\S]{0,350}?accountInvitationsUI\.reset\(\)/.test(source), true, 'Fechar o modal deve remover o link e invalidar o estado dos convites.');
});

test('revogação usa exclusivamente convite listado e revogável no namespace da conta selecionada', async t => {
  const f = fixture(t); f.setItems([invitation(), invitation({ id: 'already-accepted', state: 'accepted', canRevoke: false })]); await f.ui.open(target);
  await f.ui.handleAction(f.node('revoke', 'outside')); await f.ui.handleAction(f.node('revoke', 'already-accepted')); assert.equal(f.calls.some(call => call.init.method === 'POST'), false);
  await f.ui.handleAction(f.node('revoke', 'invite-qa')); const write = f.calls.find(call => call.init.method === 'POST'); assert.equal(write.path, '/api/accounts/account-qa/invitations/invite-qa/revoke'); assert.equal(write.init.body, '{}'); assert.match(f.modal.html, /Revogado/); assert.equal(f.updates.length, 1);
});

test('botão de revogação antigo não atua em outra conta ou modal sem ownership DOM', async t => {
  const f = fixture(t); await f.ui.open(target); const old = f.node('revoke', 'invite-qa'); await f.ui.open({ ...target, id: 'another-account' }); old.isConnected = false; await f.ui.handleAction(old); assert.equal(f.calls.some(call => call.init.method === 'POST'), false);
});

test('revogação em trânsito não substitui modal alheio ou anuncia sucesso quando contexto muda', async t => {
  for (const mode of ['replaced', 'workspace']) await t.test(mode, async child => {
    const waiting = deferred(), f = fixture(child, (path, init, fallback) => path.endsWith('/revoke') ? waiting.promise : fallback(path, init)); await f.ui.open(target); const revoking = f.ui.handleAction(f.node('revoke', 'invite-qa')), before = f.opened.length;
    if (mode === 'replaced') { f.modal.panel = { owner: 'foreign' }; f.modal.html = 'Outro modal'; } else f.state.workspaceId = 'outside'; waiting.resolve({ invitation: invitation({ state: 'revoked', canRevoke: false }) }); await revoking;
    assert.equal(f.opened.length, before); assert.equal(f.updates.length, 0); assert.equal(f.messages.length, 0);
  });
});
