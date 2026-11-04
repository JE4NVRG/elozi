import test from 'node:test';
import assert from 'node:assert/strict';
import { createContactImportUI } from '../public/contact-import-ui.js';

const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const rows = [{ name: 'Agenda sintética atual', phone: '5511987654321' }];
const outcomes = {
  success: pending => pending.resolve({ rows: [{ name: 'Agenda antiga proibida', phone: '5511976543210' }] }),
  error: pending => pending.reject(Error('Erro antigo proibido')),
  empty: pending => pending.resolve({ rows: [] }),
};

function setup(t) {
  const original = globalThis.document;
  const context = { userId: 'user-a', workspaceId: 'workspace-a', tenantId: 'tenant-a', canWrite: true, channels: [{ id: 'wa-a', kind: 'whatsapp_qr' }, { id: 'wa-b', kind: 'whatsapp_cloud' }] };
  const calls = [], modals = [], listeners = new Map();
  let html = '', active = false;
  const dialog = { open: true, addEventListener: (event, listener) => listeners.set(event, listener), removeEventListener: (event, listener) => { if (listeners.get(event) === listener) listeners.delete(event); } };
  const target = {
    get dataset() { return { contactImportSession: /data-contact-import-session="(\d+)"/.exec(html)?.[1] }; },
    set innerHTML(value) { html = value; },
    set outerHTML(value) { html = value; },
    closest: () => dialog,
    querySelector: () => null,
  };
  globalThis.document = { querySelector: selector => active && selector === '[data-contact-import-host]' ? target : null };
  t.after(() => { globalThis.document = original; });
  const ui = createContactImportUI({
    getContext: () => context, escape,
    request: (path, options) => { const pending = deferred(); calls.push({ path, options, ...pending }); return pending.promise; },
    openModal: (...args) => { modals.push(args); html = args[2]; active = true; dialog.open = true; },
  });
  function inputs(channelId = 'wa-a', source = 'file') {
    const fields = {
      channelId: { name: 'channelId', value: channelId },
      preserveInvalid: { name: 'preserveInvalid', checked: true },
      content: { name: 'content', value: '[{"name":"Texto atual preservado","phone":"11987654321"}]' },
      file: { name: 'file', value: '', files: [{ name: 'arquivo-atual.csv', size: 24, text: async () => 'nome;telefone\nAtual;123' }] },
    };
    const form = { dataset: { contactImportForm: 'preview', contactImportSession: target.dataset.contactImportSession }, isConnected: true, elements: { namedItem: name => fields[name] } };
    for (const field of Object.values(fields)) field.form = form;
    for (const name of ['channelId', 'preserveInvalid', source]) assert.equal(ui.handleChange({ target: fields[name] }), true);
  }
  function assertFields(source, busy) {
    assert.equal(ui.busy, busy);
    assert.match(html, new RegExp(`aria-busy="${busy}"`));
    assert.match(html, /name="preserveInvalid" checked/);
    if (source === 'file') { assert.match(html, /arquivo-atual\.csv/); assert.doesNotMatch(html, /Texto atual preservado/); }
    else { assert.match(html, /Texto atual preservado/); assert.doesNotMatch(html, /arquivo-atual\.csv/); }
    assert.doesNotMatch(html, /Agenda antiga proibida|Erro antigo proibido/);
  }
  return { ui, context, calls, modals, inputs, assertFields, html: () => html, close: () => { dialog.open = false; listeners.get('close')(); } };
}

for (const [outcome, settle] of Object.entries(outcomes)) {
  for (const action of ['reset', 'close']) {
    test(`agenda ${outcome} after ${action} neither repaints nor rejects a closed session`, async t => {
      const f = setup(t); f.ui.open(); f.inputs();
      const old = f.ui.useAgenda(); assert.equal(f.calls.length, 1); assert.equal(f.ui.busy, true);
      if (action === 'close') f.close(); else f.ui.reset();
      const html = f.html(), modalCount = f.modals.length;
      settle(f.calls[0]); await assert.doesNotReject(old);
      assert.equal(f.html(), html); assert.equal(f.modals.length, modalCount); assert.equal(f.ui.busy, false);
      assert.match(f.html(), /A importação foi fechada/);
    });
  }

  for (const scope of ['same-session-reopen', 'user', 'workspace', 'tenant', 'channel']) {
    for (const source of ['file', 'content']) {
      test(`stale agenda ${outcome}, ${scope}, ${source}: current fields/status/busy survive and retry works`, async t => {
        const f = setup(t); f.ui.open(); f.inputs(); const old = f.ui.useAgenda();
        if (scope === 'user') f.context.userId = 'user-b';
        if (scope === 'workspace') f.context.workspaceId = 'workspace-b';
        if (scope === 'tenant') f.context.tenantId = 'tenant-b';
        f.close(); assert.equal(f.ui.open(), true);
        f.inputs(scope === 'channel' ? 'wa-b' : 'wa-a', source);
        const current = f.ui.useAgenda(); f.assertFields(source, true);
        assert.match(f.html(), /Lendo a agenda do WhatsApp/);
        const snapshot = f.html(), modalCount = f.modals.length;
        settle(f.calls[0]); await assert.doesNotReject(old);
        assert.equal(f.html(), snapshot); assert.equal(f.modals.length, modalCount); f.assertFields(source, true);
        await f.ui.useAgenda(); assert.equal(f.calls.length, 2, 'stale finally must not release current busy');
        assert.match(f.calls[1].path, new RegExp(`/tenants/${f.context.tenantId}/channels/${scope === 'channel' ? 'wa-b' : 'wa-a'}/address-book$`));
        assert.equal(f.calls[1].options.headers['X-Elozi-Workspace'], f.context.workspaceId);
        f.calls[1].reject(Error('Falha atual recuperável')); await current;
        f.assertFields(source, false); assert.match(f.html(), /Falha atual recuperável/);
        const retry = f.ui.useAgenda(); assert.equal(f.calls.length, 3); f.assertFields(source, true);
        assert.doesNotMatch(f.html(), /Falha atual recuperável/);
        f.calls[2].resolve({ rows }); await retry;
        assert.equal(f.ui.busy, false); assert.match(f.html(), /aria-busy="false"/);
        assert.match(f.html(), /Agenda sintética atual/); assert.match(f.html(), /1 contatos da agenda prontos/);
        assert.doesNotMatch(f.html(), /arquivo-atual\.csv|Texto atual preservado|Falha atual recuperável|Agenda antiga proibida|Erro antigo proibido/);
        assert.match(f.html(), /name="preserveInvalid" checked/);
      });
    }
  }

  for (const change of ['user', 'workspace', 'tenant', 'channel-removal', 'permission']) {
    test(`agenda ${outcome} invalidates changed ${change} without accepting old content or errors`, async t => {
      const f = setup(t); f.ui.open(); f.inputs(); const old = f.ui.useAgenda();
      if (change === 'user') f.context.userId = 'user-b';
      if (change === 'workspace') f.context.workspaceId = 'workspace-b';
      if (change === 'tenant') f.context.tenantId = 'tenant-b';
      if (change === 'channel-removal') f.context.channels = [{ id: 'wa-b', kind: 'whatsapp_cloud' }];
      if (change === 'permission') f.context.canWrite = false;
      settle(f.calls[0]); await assert.doesNotReject(old);
      assert.equal(f.ui.busy, false); assert.match(f.html(), /A importação foi fechada/);
      assert.doesNotMatch(f.html(), /Agenda antiga proibida|Erro antigo proibido|arquivo-atual\.csv|Lendo a agenda/);
    });
  }
}

for (const outcome of ['error', 'empty']) {
  test(`current agenda ${outcome} retains file/fields, clears busy and permits a successful retry`, async t => {
    const f = setup(t); f.ui.open(); f.inputs(); const first = f.ui.useAgenda();
    if (outcome === 'error') f.calls[0].reject(Error('Falha atual recuperável'));
    else outcomes[outcome](f.calls[0]);
    await first;
    f.assertFields('file', false);
    assert.match(f.html(), outcome === 'empty' ? /agenda deste WhatsApp ainda está vazia/ : /Falha atual recuperável/);
    const retry = f.ui.useAgenda(); assert.equal(f.calls.length, 2); assert.equal(f.ui.busy, true);
    f.calls[1].resolve({ rows }); await retry;
    assert.match(f.html(), /Agenda sintética atual/); assert.doesNotMatch(f.html(), /arquivo-atual\.csv/); assert.equal(f.ui.busy, false);
  });
}
