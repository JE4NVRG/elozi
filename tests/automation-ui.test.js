import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setLocale } from '../public/i18n.js';
import { createAutomationUI, createDialogHost, createFocusMemory } from '../public/automation-ui.js';
import { registryEntries, dispatchAction } from '../public/actions.js';

// Automação (FRONTEND-V2 §8.9, P8-B): Regras e SLA, Respostas rápidas and the wiring of Fluxos run the
// real module with a synthetic API, a fake dialog host and FormData over plain form objects. The
// behaviour checks of the legacy screen (CAS version, pinned publication, archived flows, connected
// channels, stale responses of another workspace or company) stay as they were.

const decode = value => value.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[entity]));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const locale = value => setLocale(value, { persist: false, notify: false });
test.afterEach(() => { locale('pt-BR'); delete globalThis.location; });

class FormDataFixture {
  constructor(form) { this.values = form.values; }
  get(name) { return this.values.get(name)?.[0] ?? null; }
  getAll(name) { return this.values.get(name) || []; }
  has(name) { return this.values.has(name); }
}
globalThis.FormData = FormDataFixture;

function formFromHTML(html, { id = '', form } = {}) {
  const values = new Map();
  const add = (name, value) => values.set(name, [...(values.get(name) || []), decode(value)]);
  for (const match of String(html).matchAll(/<input\b([^>]*)>/g)) {
    const attributes = match[1], name = /\bname="([^"]+)"/.exec(attributes)?.[1]; if (!name) continue;
    if (/\btype="checkbox"/.test(attributes) && !/\bchecked\b/.test(attributes)) continue;
    add(name, /\bvalue="([^"]*)"/.exec(attributes)?.[1] ?? 'on');
  }
  for (const match of String(html).matchAll(/<select\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const choices = [...match[2].matchAll(/<option\b([^>]*)>/g)], selected = choices.find(choice => /\bselected\b/.test(choice[1])) || choices[0];
    if (selected) add(match[1], /\bvalue="([^"]*)"/.exec(selected[1])?.[1] ?? '');
  }
  for (const match of String(html).matchAll(/<textarea\b[^>]*\bname="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) add(match[1], match[2]);
  return { id, dataset: form ? { form } : {}, values,
    elements: { namedItem: name => values.has(name) ? { value: values.get(name)[0] } : null },
    set(name, value) { if (value === false || value === null) values.delete(name); else values.set(name, Array.isArray(value) ? value.map(String) : [String(value)]); return this; },
    get(name) { return values.get(name)?.[0] ?? null; }
  };
}

function fixture({ archived = false, role = 'reseller', permissions = null, flows: withFlows = true, channels: withChannels = true, bindings: withBindings = true, replies = null } = {}) {
  const flow = { id: 'flow-a', name: 'Triagem publicada', state: archived ? 'archived' : 'published', version: 3, publishedVersion: 2, versions: [{ version: 1 }, { version: 2 }],
    graph: { departmentReferenceFormat: 'id-v1', nodes: [{ id: 'start', type: 'start', config: {} }, { id: 'end', type: 'end', config: {} }], edges: [{ from: 'start', to: 'end' }] } };
  const binding = { id: 'binding-a', name: 'Regra original A', enabled: true, channelId: 'wa-a', flowId: flow.id, flowVersion: 1, trigger: 'incoming', command: null, calendar: null,
    authorizedBy: 'authority-a', createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z' };
  const config = name => ({ version: 2, bindings: withBindings ? [{ ...binding, name }] : [], sla: { enabled: false, firstReplyMinutes: 15, resolutionMinutes: 240, calendar: null }, updatedAt: '2026-10-01T12:00:00Z' });
  const configurations = new Map([['workspace-a/tenant-a', config('Regra original A')], ['workspace-b/tenant-b', config('Regra original B')]]);
  const catalogs = new Map([['workspace-a/tenant-a', structuredClone(replies || [])], ['workspace-b/tenant-b', [{ id: 'reply-b', shortcut: 'b', title: 'Resposta B', text: 'Texto B', version: 1, active: true }]]]);
  const tenant = tenantId => ({ id: tenantId, name: tenantId === 'tenant-a' ? 'Empresa A' : 'Empresa B', brand: {}, channels: withChannels ? [
    { id: 'site', name: 'Site não conectado', kind: 'webchat' },
    { id: 'wa-a', name: 'WhatsApp conectado', kind: 'whatsapp_qr', transport: 'baileys', state: 'connected' },
    { id: 'tg-a', name: 'Telegram conectado', kind: 'telegram', transport: 'telegram-bot', state: 'connected' },
    { id: 'site-active', name: 'Webchat conectado', kind: 'webchat', transport: 'elozi-webchat', state: 'connected', webchat: { enabled: true, version: 1, origins: ['https://site.example.test'] } }
  ] : [], flows: withFlows ? [flow] : [] });
  const state = { workspaceId: 'workspace-a', view: 'automation', boot: { session: { role, permissions } }, tenant: tenant('tenant-a'), flows: archived || !withFlows ? [] : [flow], users: [] };
  const calls = [], dialogs = [], messages = [], pendingGets = new Map(); let renderCount = 0, closeCount = 0, pendingPut = null, pendingReply = null, intercept = null;
  const can = permission => role === 'reseller' || permissions == null || permissions.includes(permission);
  const dialogHost = { open(options) { dialogs.push({ ...options, body: String(options.body) }); return true; }, close() { closeCount++; }, keep() {}, discard() { closeCount++; }, reconcile() {}, isOpen: () => false };
  const context = {
    state, dialogHost, hasPermission: can,
    tenantApi: action => `/api/tenants/${state.tenant.id}/${action}`,
    async api(path, options = {}) {
      if (intercept) { const answer = await intercept(path, options); if (answer !== undefined) return answer; }
      const localKey = `${state.workspaceId}/${/^\/api\/tenants\/([^/]+)/.exec(path)[1]}`, method = options.method || 'GET';
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, method, key: localKey, body });
      if (path.includes('/quick-replies')) {
        const items = catalogs.get(localKey);
        if (method === 'GET') return { replies: structuredClone(role === 'reseller' ? items : items.filter(item => item.active)) };
        const apply = () => {
          if (method === 'POST') { const created = { id: `reply-${items.length + 1}`, ...body, active: true, version: 1 }; items.push(created); return structuredClone(created); }
          const id = decodeURIComponent(path.split('/').at(-1)), item = items.find(reply => reply.id === id);
          if (item.version !== body.version) throw Object.assign(new Error('A resposta mudou.'), { status: 409 });
          Object.assign(item, body, { version: item.version + 1 }); return structuredClone(item);
        };
        if (pendingReply) { const waiting = pendingReply; pendingReply = null; return waiting.promise.then(apply); }
        return apply();
      }
      if (method === 'PUT') {
        const apply = () => { configurations.set(localKey, { ...structuredClone(body), version: body.version + 1 }); return structuredClone(configurations.get(localKey)); };
        if (pendingPut) { const waiting = pendingPut; pendingPut = null; return waiting.promise.then(apply); }
        return apply();
      }
      if (path.endsWith('/automation')) {
        if (pendingGets.has(localKey)) return pendingGets.get(localKey).promise;
        return structuredClone(configurations.get(localKey));
      }
      if (path.endsWith('/sla')) return { policy: structuredClone(configurations.get(localKey).sla), totals: {}, conversations: [] };
      throw new Error('Unexpected automation UI fixture request');
    },
    render() { renderCount++; }, toast(message, error) { messages.push({ message, error: Boolean(error) }); }
  };
  const ui = createAutomationUI(context);
  return { ui, state, calls, dialogs, messages, configurations, catalogs, context,
    get renderCount() { return renderCount; }, get closeCount() { return closeCount; },
    editForm() { assert.ok(dialogs.length, 'The real editor opens a dialog'); return formFromHTML(dialogs.at(-1).body, { form: 'automation:binding' }); },
    replyForm() { assert.ok(dialogs.length, 'The reply editor opens a dialog'); return formFromHTML(dialogs.at(-1).body, { form: 'automation:reply' }); },
    slaForm() { const html = /<form id="automation-sla-form"[\s\S]*?<\/form>/.exec(ui.views.automation())?.[0]; assert.ok(html, 'The real view contains the SLA form'); return formFromHTML(html, { id: 'automation-sla-form', form: 'automation:sla' }); },
    deferGet(localKey) { const pending = deferred(); pendingGets.set(localKey, pending); return pending; },
    deferPut() { pendingPut = deferred(); return pendingPut; },
    deferReply() { pendingReply = deferred(); return pendingReply; },
    switchContext() { state.workspaceId = 'workspace-b'; state.tenant = tenant('tenant-b'); },
    intercept(handler) { intercept = handler; }
  };
}
const put = c => c.calls.filter(call => call.method === 'PUT').at(-1);
const settle = () => new Promise(resolve => setImmediate(resolve));

// ---- behaviour of the legacy screen, unchanged ----------------------------------------------------

test('editar regra v1 mantém a publicação fixada quando o fluxo já publicou v2', async () => {
  const c = fixture(); await c.ui.refresh(); await c.ui.act('automation:edit-binding', 'binding-a');
  const form = c.editForm(); assert.equal(form.get('publication'), 'flow-a/1');
  form.set('name', 'Nome atualizado sem trocar a rota'); await c.ui.submit(form);
  assert.equal(put(c).body.bindings[0].flowVersion, 1); assert.equal(put(c).body.bindings[0].name, 'Nome atualizado sem trocar a rota');
  assert.equal(put(c).body.version, 2); assert.equal(c.closeCount, 1);
});

test('escolher explicitamente outra publicação envia v2 na mesma regra', async () => {
  const c = fixture(); await c.ui.refresh(); await c.ui.act('edit-automation-binding', 'binding-a');
  const form = c.editForm(); form.set('publication', 'flow-a/2'); await c.ui.submit(form);
  assert.equal(put(c).body.bindings[0].id, 'binding-a'); assert.equal(put(c).body.bindings[0].flowId, 'flow-a'); assert.equal(put(c).body.bindings[0].flowVersion, 2);
});

test('salvar SLA mantém vínculo fixado e filtra autoridade e metadados retornados pelo servidor', async () => {
  const c = fixture(); await c.ui.refresh();
  const form = c.slaForm().set('enabled', 'on').set('firstReplyMinutes', '20').set('resolutionMinutes', '300'); await c.ui.submit(form);
  const body = put(c).body; assert.equal(body.version, 2); assert.deepEqual(body.sla, { enabled: true, firstReplyMinutes: 20, resolutionMinutes: 300, calendar: null });
  assert.equal(body.bindings[0].flowVersion, 1);
  for (const field of ['authorizedBy', 'createdAt', 'updatedAt']) assert.equal(Object.hasOwn(body.bindings[0], field), false, `${field} must not be sent to strict configure input`);
  assert.equal(Object.hasOwn(body, 'updatedAt'), false);
  assert.ok(c.messages.some(item => item.message === 'Automações e prazos atualizados.'));
});

test('horário de funcionamento do SLA envia fuso, dias e janela escolhidos', async () => {
  const c = fixture(); await c.ui.refresh();
  const form = c.slaForm().set('calendarEnabled', 'on').set('timezone', 'America/Manaus').set('days', ['1', '3']).set('start', '08:00').set('end', '17:30'); await c.ui.submit(form);
  assert.deepEqual(put(c).body.sla.calendar, { timezone: 'America/Manaus', days: [1, 3], start: '08:00', end: '17:30' });
});

test('regra de fluxo arquivado continua desativável pela publicação histórica sem inventar outro fluxo', async () => {
  const c = fixture({ archived: true }); await c.ui.refresh(); assert.deepEqual(c.state.flows, []);
  await c.ui.act('automation:edit-binding', 'binding-a'); const form = c.editForm(); assert.equal(form.get('publication'), 'flow-a/1');
  await assert.rejects(c.ui.submit(form), /arquivado/); assert.equal(put(c), undefined);
  form.set('enabled', false); await c.ui.submit(form);
  assert.equal(put(c).body.bindings[0].enabled, false); assert.equal(put(c).body.bindings[0].flowId, 'flow-a'); assert.equal(put(c).body.bindings[0].flowVersion, 1);
  assert.match(c.ui.views.automation(), /Fluxo arquivado/, 'the rule says its flow was archived');
});

test('editor oferece Webchat real e apenas conectores conectados correspondentes ao tipo', async () => {
  const c = fixture(); await c.ui.refresh(); await c.ui.act('automation:new-binding');
  const dialog = c.dialogs.at(-1), form = c.editForm(); assert.equal(form.get('channelId'), 'wa-a');
  const channels = /<select[^>]*name="channelId"[^>]*>([\s\S]*?)<\/select>/.exec(dialog.body)[1];
  assert.match(channels, /wa-a/); assert.match(channels, /tg-a/); assert.match(channels, /site-active/); assert.doesNotMatch(channels, /value="site"/);
  form.set('channelId', 'site-active').set('name', 'Comando exclusivo').set('trigger', 'command').set('command', '/qa_elozi_95'); await c.ui.submit(form);
  const wire = put(c).body.bindings.at(-1); assert.equal(wire.channelId, 'site-active'); assert.equal(wire.command, '/qa_elozi_95');
  assert.equal(Object.hasOwn(wire, 'webchat'), false); assert.equal(Object.hasOwn(wire, 'transport'), false);
});

test('canais desconectados ou com conector divergente não entram no editor de nova regra', async () => {
  const c = fixture();
  c.state.tenant.channels.push(
    { id: 'offline', name: 'Offline', kind: 'whatsapp_qr', transport: 'baileys', state: 'disconnected' },
    { id: 'demo', name: 'Demo', kind: 'telegram', transport: 'demo', state: 'connected' },
    { id: 'mismatch', name: 'Outro tipo', kind: 'email', transport: 'telegram-bot', state: 'connected' },
    { id: 'site-disabled', name: 'Webchat desativado', kind: 'webchat', transport: 'elozi-webchat', state: 'connected', webchat: { enabled: false, version: 1, origins: ['https://site.example.test'] } }
  );
  await c.ui.refresh(); await c.ui.act('automation:new-binding');
  const choices = /<select[^>]*name="channelId"[^>]*>([\s\S]*?)<\/select>/.exec(c.dialogs.at(-1).body)[1];
  for (const channelId of ['offline', 'demo', 'mismatch', 'site-disabled']) assert.doesNotMatch(choices, new RegExp(`value="${channelId}"`));
  await assert.rejects(c.ui.submit(c.editForm().set('channelId', 'offline')), /Conecte o canal/); assert.equal(put(c), undefined);
});

test('regra existente offline continua selecionada para desativação sem mudar canal nem fluxo', async () => {
  const c = fixture(); c.state.tenant.channels.find(channel => channel.id === 'wa-a').state = 'disconnected';
  await c.ui.refresh(); await c.ui.act('automation:edit-binding', 'binding-a');
  const form = c.editForm(); assert.equal(form.get('channelId'), 'wa-a'); assert.match(c.dialogs.at(-1).body, /WhatsApp conectado · desconectado/);
  await assert.rejects(c.ui.submit(form), /Conecte o canal/); assert.equal(put(c), undefined);
  form.set('enabled', false); await c.ui.submit(form);
  assert.equal(put(c).body.bindings[0].enabled, false); assert.equal(put(c).body.bindings[0].channelId, 'wa-a'); assert.equal(put(c).body.bindings[0].flowVersion, 1);
  assert.match(c.ui.views.automation(), /Canal desconectado/);
});

test('resposta de GET antiga não troca a configuração depois de mudar workspace/empresa', async () => {
  const c = fixture(), pending = c.deferGet('workspace-a/tenant-a'), refreshing = c.ui.refresh();
  c.switchContext(); await c.ui.refresh(); assert.match(c.ui.views.automation(), /Regra original B/);
  pending.resolve(structuredClone(c.configurations.get('workspace-a/tenant-a'))); await refreshing;
  const view = c.ui.views.automation(); assert.match(view, /Regra original B/); assert.doesNotMatch(view, /Regra original A/);
});

test('resposta de PUT antiga não atualiza, avisa ou fecha o diálogo do novo contexto', async () => {
  const c = fixture(); await c.ui.refresh(); await c.ui.act('automation:edit-binding', 'binding-a');
  const form = c.editForm().set('name', 'Alteração da empresa A'), pending = c.deferPut(), submitting = c.ui.submit(form);
  assert.equal(put(c).key, 'workspace-a/tenant-a'); assert.equal(put(c).path, '/api/tenants/tenant-a/automation');
  c.switchContext(); c.ui.reset(); await c.ui.refresh();
  const counts = { calls: c.calls.length, renders: c.renderCount, messages: c.messages.length, closes: c.closeCount };
  pending.resolve(); await submitting;
  assert.equal(c.calls.length, counts.calls); assert.equal(c.renderCount, counts.renders); assert.equal(c.messages.length, counts.messages); assert.equal(c.closeCount, counts.closes);
  assert.match(c.ui.views.automation(), /Regra original B/); assert.doesNotMatch(c.ui.views.automation(), /Alteração da empresa A/);
});

test('remover regra pede confirmação e só então envia a lista sem ela, com a versão lida', async () => {
  const c = fixture(); await c.ui.refresh();
  await c.ui.act('automation:remove-binding', 'binding-a');
  const dialog = c.dialogs.at(-1);
  assert.equal(dialog.kind, 'remove'); assert.match(dialog.body, /data-action="automation:confirm-remove-binding" data-id="binding-a"/); assert.match(dialog.body, /ui-btn--danger/);
  assert.equal(put(c), undefined, 'opening the confirmation saves nothing');
  await c.ui.act('confirm-remove-automation-binding', 'binding-a');
  assert.deepEqual(put(c).body.bindings, []); assert.equal(put(c).body.version, 2); assert.equal(c.closeCount, 1);
});

test('somente a administração altera regras e configura prazos', async () => {
  const c = fixture({ role: 'operator', permissions: ['inbox.read', 'metrics.read', 'flows.read'] }); await c.ui.refresh();
  assert.ok(c.calls.every(call => !call.path.endsWith('/automation')), 'the configuration is loaded only for the administration');
  assert.ok(c.calls.some(call => call.path.endsWith('/sla')), 'the queue follow-up keeps metrics.read and inbox.read');
  await assert.rejects(c.ui.act('automation:new-binding'), /não permite alterar regras/);
  await assert.rejects(c.ui.submit(formFromHTML('<input name="version" value="2">', { form: 'automation:sla' })), /não permite configurar/);
  const view = c.ui.views.automation();
  assert.doesNotMatch(view, /automation:new-binding|automation-sla-form|automation:edit-binding/);
  assert.match(view, /configurados pela administração/);
  const hidden = fixture({ role: 'operator', permissions: ['flows.read'] }); await hidden.ui.refresh();
  assert.equal(hidden.calls.length, 0); assert.match(hidden.ui.views.automation(), /Seu acesso não inclui os indicadores desta fila/);
});

// ---- new design system, states and routes ------------------------------------------------------

test('Regras e SLA usam os componentes e classes da tela, sem classes do CSS legado', async () => {
  const c = fixture(); await c.ui.refresh();
  const view = c.ui.views.automation();
  assert.match(view, /<div class="pg-automation pg-automation--rules">/); assert.match(view, /<h1 class="pg-automation__title">Regras e SLA<\/h1>/);
  assert.match(view, /data-action="automation:edit-binding" data-id="binding-a"/); assert.match(view, /aria-label="Editar Regra original A"/);
  assert.match(view, /data-form="automation:sla"/); assert.match(view, /role="switch"/); assert.match(view, /<dialog class="pg-automation__dialog" id="automation-dialog"/);
  for (const legacy of [/class="panel\b/, /class="button\b/, /badge (?:amber|green|blue)/, /automation-panel/, /page-heading/, /checkbox-label/, /modal-actions/, /data-close-modal/]) assert.doesNotMatch(view, legacy);
  assert.match(view, /versão v1/); assert.match(view, /v2 disponível/, 'a newer publication is announced without changing the pinned one');
});

test('estado vazio das regras tem uma única ação primária, conforme o que falta', async () => {
  const cases = [
    [{ bindings: false, flows: false }, 'automation:open-flows'],
    [{ bindings: false, channels: false }, 'automation:open-channels'],
    [{ bindings: false }, 'automation:new-binding']
  ];
  for (const [options, action] of cases) {
    const c = fixture(options); await c.ui.refresh();
    const view = c.ui.views.automation(), empty = /<div class="ui-empty">[\s\S]*?<\/div><\/div>/.exec(view)?.[0];
    assert.ok(empty, `empty state for ${action}`); assert.match(empty, new RegExp(`data-action="${action}"`)); assert.equal((empty.match(/ui-btn--primary/g) || []).length, 1);
    const rules = /<section class="pg-automation__card" aria-labelledby="automation-rules-title">[\s\S]*?<\/section>/.exec(view)[0];
    assert.equal((rules.match(/ui-btn--primary/g) || []).length, 1, 'the rules card has one primary action');
  }
});

test('acompanhamento com SLA ativo mostra indicadores e tabela acessível; desativado oferece ativar', async () => {
  const c = fixture(); await c.ui.refresh();
  const off = c.ui.views.automation();
  assert.match(off, /Acompanhamento desativado/); assert.match(off, /data-action="automation:focus-sla"/);
  c.configurations.get('workspace-a/tenant-a').sla.enabled = true;
  c.intercept(async path => {
    if (!path.endsWith('/sla')) return undefined;
    return { policy: { enabled: true, calendar: null }, totals: { tracked: 3, firstReplyBreached: 1, resolutionBreached: 0, insufficient: 1 }, conversations: [{ id: 'c1', contact: 'Cliente <b>', status: 'open', channelId: 'wa-a', assignedUserId: null, firstReply: { state: 'breached', dueAt: '2026-10-01T12:00:00Z' }, resolution: { state: 'pending', dueAt: '2026-10-02T12:00:00Z' } }] };
  });
  await c.ui.refresh();
  const on = c.ui.views.automation();
  assert.match(on, /<dl class="pg-automation__kpis">/); assert.match(on, /data-tone="danger"><dt>Primeira resposta excedida<\/dt><dd>1<\/dd>/);
  assert.match(on, /role="table"/); assert.match(on, /role="columnheader" scope="col">Contato/); assert.match(on, /data-label="Contato"/);
  assert.match(on, /Cliente &lt;b&gt;/); assert.match(on, /ui-badge--danger">Prazo excedido/); assert.match(on, /Na fila/);
});

test('rota de cada aba fica registrada para o app redesenhar ao trocar de aba dentro da mesma view', async () => {
  const c = fixture(); await c.ui.refresh();
  globalThis.location = { hash: '#automation' }; c.ui.views.automation();
  assert.equal(c.state.screenRoutes.automation, JSON.stringify(['automation', {}]));
  globalThis.location = { hash: '#automation/replies' }; c.ui.views['quick-replies']();
  assert.equal(c.state.screenRoutes['quick-replies'], JSON.stringify(['automation', { tab: 'replies' }]));
  globalThis.location = { hash: '#overview' }; c.ui.views['quick-replies']();
  assert.equal(c.state.screenRoutes['quick-replies'], JSON.stringify(['automation', { tab: 'replies' }]), 'fora do hash da aba: a rota canônica de nav-config');
  assert.doesNotMatch(c.ui.views.automation(), /pg-automation--replies/, 'Regras e SLA nunca desenha a aba de respostas');
  globalThis.location = { hash: '#automation/flows' }; c.ui.views.flows();
  assert.equal(c.state.screenRoutes.flows, JSON.stringify(['automation', { tab: 'flows' }]));
});

test('registro de ações: a tela automation responde pelo namespace', async () => {
  const c = fixture(); await c.ui.refresh();
  assert.ok(registryEntries().screens.includes('automation'));
  const before = c.calls.length;
  assert.equal(await dispatchAction('automation:refresh'), true);
  assert.ok(c.calls.length > before, 'automation:refresh reloads the configuration'); assert.ok(c.renderCount > 0);
  assert.equal(await c.ui.act('publish-flow'), false, 'legacy flow actions stay with app.js');
});

test('copy EN nas regras sem traduzir nomes de regra, canal ou fluxo', async () => {
  const c = fixture(); await c.ui.refresh(); locale('en');
  const view = c.ui.views.automation();
  assert.match(view, />Rules and SLA</); assert.match(view, /Intake rules/); assert.match(view, /Service deadlines/); assert.match(view, /Regra original A/); assert.match(view, /Triagem publicada/);
});

// ---- Respostas rápidas ---------------------------------------------------------------------------

const catalog = () => [
  { id: 'welcome', shortcut: 'ola', title: 'Boas-vindas', text: 'Olá! Como podemos ajudar?', version: 3, active: true },
  { id: 'old', shortcut: 'antigo', title: 'Texto antigo', text: 'Não usar', version: 5, active: false }
];

test('aba Respostas rápidas carrega o catálogo da empresa e lista ativas e desativadas para a administração', async () => {
  const c = fixture({ replies: catalog() }); await c.ui.refresh(); c.state.view = 'quick-replies'; globalThis.location = { hash: '#automation/replies' };
  const loading = c.ui.views['quick-replies']();
  assert.match(loading, /<h1 class="pg-automation__title">Respostas rápidas<\/h1>/); assert.match(loading, /ui-skeleton/);
  await settle();
  assert.deepEqual(c.calls.filter(call => call.path.endsWith('/quick-replies')).map(call => call.method), ['GET']);
  assert.ok(c.renderCount > 0, 'the screen renders again when the catalog arrives');
  const view = c.ui.views['quick-replies']();
  assert.match(view, /\/ola<\/code>/); assert.match(view, /Texto antigo/); assert.match(view, /2 respostas · 1 desativada/);
  assert.match(view, /data-action="automation:reply-edit" data-id="welcome"/); assert.match(view, /data-action="automation:reply-toggle" data-id="old"/);
  assert.match(view, /data-automation-search="replies"/); assert.match(view, /data-action="automation:reply-new"/);
  assert.doesNotMatch(view, /data-reply-action|data-reply-search|data-reply-form/, 'the composer hooks of app.js stay out of the screen');
  assert.equal(c.calls.filter(call => call.path.endsWith('/quick-replies')).length, 1, 'rendering again does not reload');
});

test('editar resposta envia PATCH com a versão lida e nova resposta usa POST sem versão', async () => {
  const c = fixture({ replies: catalog() }); await c.ui.refresh(); c.state.view = 'quick-replies'; globalThis.location = { hash: '#automation/replies' };
  c.ui.views['quick-replies'](); await settle(); c.ui.views['quick-replies']();
  await c.ui.act('automation:reply-edit', 'welcome');
  const editor = c.dialogs.at(-1);
  assert.equal(editor.title, 'Editar resposta rápida'); assert.equal(editor.description, 'Empresa A');
  assert.match(editor.body, /name="version" value="3"/); assert.match(editor.body, /data-form="automation:reply"/); assert.match(editor.body, /maxlength="4000"/);
  await c.ui.submit(c.replyForm().set('title', ' Boas-vindas novas ').set('shortcut', '/OLA'));
  const patch = c.calls.find(call => call.method === 'PATCH');
  assert.equal(patch.path, '/api/tenants/tenant-a/quick-replies/welcome'); assert.deepEqual(patch.body, { shortcut: 'ola', title: 'Boas-vindas novas', text: 'Olá! Como podemos ajudar?', version: 3 });
  assert.equal(c.closeCount, 1); assert.ok(c.messages.some(item => item.message === 'Resposta rápida salva.'));
  await c.ui.act('automation:reply-new');
  await c.ui.submit(c.replyForm().set('shortcut', 'prazo').set('title', 'Prazo').set('text', 'Três dias.'));
  const post = c.calls.find(call => call.method === 'POST');
  assert.deepEqual(post.body, { shortcut: 'prazo', title: 'Prazo', text: 'Três dias.' });
});

test('desativar e reativar usam a versão atual e recarregam o catálogo', async () => {
  const c = fixture({ replies: catalog() }); await c.ui.refresh(); c.state.view = 'quick-replies'; globalThis.location = { hash: '#automation/replies' };
  c.ui.views['quick-replies'](); await settle();
  await c.ui.act('automation:reply-toggle', 'welcome');
  const patch = c.calls.find(call => call.method === 'PATCH');
  assert.deepEqual(patch.body, { version: 3, active: false });
  assert.ok(c.messages.some(item => item.message === 'Resposta desativada.'));
  assert.match(c.ui.views['quick-replies'](), /2 respostas · 2 desativadas/);
});

test('resposta salva depois de trocar de empresa não fecha, não avisa e não recarrega o catálogo atual', async () => {
  const c = fixture({ replies: catalog() }); await c.ui.refresh(); c.state.view = 'quick-replies'; globalThis.location = { hash: '#automation/replies' };
  c.ui.views['quick-replies'](); await settle();
  await c.ui.act('automation:reply-edit', 'welcome');
  const pending = c.deferReply(), saving = c.ui.submit(c.replyForm().set('title', 'Da empresa A'));
  await settle();
  c.switchContext();
  const counts = { closes: c.closeCount, messages: c.messages.length };
  pending.resolve(); await assert.rejects(saving, /empresa de origem/);
  assert.equal(c.closeCount, counts.closes); assert.equal(c.messages.length, counts.messages);
  assert.equal(c.catalogs.get('workspace-a/tenant-a')[0].title, 'Da empresa A', 'the save landed in the company that opened the editor');
  assert.equal(c.calls.filter(call => call.key === 'workspace-b/tenant-b' && call.path.endsWith('/quick-replies')).length, 0);
  await assert.rejects(c.ui.submit(c.replyForm()), /empresa mudou/, 'an editor opened in another company cannot save here');
});

test('atendente não carrega nem gerencia respostas rápidas na Automação', async () => {
  const c = fixture({ role: 'operator', permissions: ['inbox.read', 'flows.read'], replies: catalog() }); await c.ui.refresh(); c.state.view = 'quick-replies'; globalThis.location = { hash: '#automation/replies' };
  const view = c.ui.views['quick-replies'](); await settle();
  assert.match(view, /Gerenciadas pela administração/); assert.match(view, /data-action="automation:open-inbox"/);
  assert.equal(c.calls.filter(call => call.path.includes('/quick-replies')).length, 0);
  await assert.rejects(c.ui.act('automation:reply-new'), /Somente administradores/);
  await assert.rejects(c.ui.act('automation:reply-toggle', 'welcome'), /Somente administradores/);
});

test('catálogo vazio e busca sem resultado têm uma única ação primária', async () => {
  const empty = fixture({ replies: [] }); await empty.ui.refresh(); empty.state.view = 'quick-replies'; globalThis.location = { hash: '#automation/replies' };
  empty.ui.views['quick-replies'](); await settle();
  const view = empty.ui.views['quick-replies']();
  assert.match(view, /Nenhuma resposta rápida ainda/); assert.equal((view.match(/ui-btn--primary/g) || []).length, 1); assert.match(view, /automation:reply-new/);
  assert.doesNotMatch(view, /data-automation-search/, 'no search over an empty catalog');
});

test('falha ao carregar respostas mostra o erro com nova tentativa', async () => {
  const c = fixture({ replies: catalog() }); await c.ui.refresh(); c.state.view = 'quick-replies'; globalThis.location = { hash: '#automation/replies' };
  c.intercept(async path => { if (path.endsWith('/quick-replies')) throw Object.assign(new Error('Serviço indisponível.'), { status: 503 }); return undefined; });
  c.ui.views['quick-replies'](); await settle();
  const view = c.ui.views['quick-replies']();
  assert.match(view, /ui-banner--danger/); assert.match(view, /Serviço indisponível/); assert.match(view, /automation:replies-retry/);
  c.intercept(null); await c.ui.act('automation:replies-retry');
  assert.match(c.ui.views['quick-replies'](), /\/ola<\/code>/);
});

test('Respostas rápidas é uma view própria do hub (P10): a tela não injeta mais aba, trilha nem título', async () => {
  const c = fixture({ replies: catalog() }); await c.ui.refresh();
  assert.deepEqual(Object.keys(c.ui.views).sort(), ['automation', 'flows', 'quick-replies']);
  const source = await readFile(new URL('../public/automation-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /hub-automation-tab-replies|sh-crumbs__item|createElement\('a'\)|\.title\s*=/, 'nav-config.js desenha a aba; o shell, a trilha e o título');
  c.state.view = 'quick-replies'; globalThis.location = { hash: '#automation/replies' };
  assert.match(c.ui.views['quick-replies'](), /<h1 class="pg-automation__title">Respostas rápidas<\/h1>/);
  await c.ui.act('automation:refresh'); await settle();
  assert.ok(c.calls.some(call => call.path.endsWith('/quick-replies')), 'Atualizar na aba recarrega o catálogo');
  c.state.tenant = null;
  assert.match(c.ui.views['quick-replies'](), /Escolha uma empresa/, 'sem empresa, o mesmo aviso da Automação');
});

// ---- Fluxos wiring -------------------------------------------------------------------------------

test('a view flows do hub é desenhada pela tela nova, com publicação confirmada antes de chamar o legado', async () => {
  const graph = { departmentReferenceFormat: 'id-v1', nodes: [{ id: 'start', type: 'start', config: {} }, { id: 'handoff', type: 'handoff', config: { owner: 'queue' } }, { id: 'end', type: 'end', config: {} }], edges: [{ from: 'start', to: 'handoff' }, { from: 'handoff', to: 'end' }] };
  const c = fixture(); c.state.flows = [{ id: 'flow-a', name: 'Triagem', state: 'draft', version: 4, publishedVersion: 2, versions: [{ version: 1 }, { version: 2 }], graph }];
  const view = c.ui.views.flows();
  assert.match(view, /<h1 class="pg-automation__title">Fluxos<\/h1>/); assert.match(view, /data-flow-id="flow-a"/); assert.match(view, /aria-current="true"/);
  assert.match(view, /data-action="save-flow"/); assert.match(view, /data-action="automation:publish-flow"/); assert.match(view, /data-action="flow-json"/);
  assert.match(view, /v2 em uso · o rascunho tem mudanças não publicadas/);
  assert.doesNotMatch(view, /data-action="publish-flow"/, 'publishing needs the confirmation first');
  assert.doesNotMatch(view, /data-flow-node=|data-node-config=|id="flow-simulate-form"/, 'the steps are edited by this module, not by the legacy listeners');
  await c.ui.act('automation:publish-flow');
  const confirm = c.dialogs.at(-1);
  assert.equal(confirm.kind, 'publish'); assert.equal(confirm.description, 'Triagem');
  assert.match(confirm.body, /data-action="publish-flow"/); assert.match(confirm.body, /Publicar v3/); assert.match(confirm.body, /edição v4/);
  const reader = fixture({ role: 'operator', permissions: ['flows.read'] }); reader.state.flows = c.state.flows;
  const readOnly = reader.ui.views.flows();
  assert.doesNotMatch(readOnly, /save-flow|automation:publish-flow|automation:add-flow-node/); assert.match(readOnly, /<fieldset class="pg-automation__fieldset pg-automation__fieldset--bare" disabled>/);
  await assert.rejects(reader.ui.act('automation:publish-flow'), /Somente a administração publica/);
});

// ---- dialog host and focus memory (fake DOM: no browser in the gates) ------------------------------

function fakeDom(t) {
  const focused = [], listeners = {};
  const doc = { body: { name: 'body' }, documentElement: {}, activeElement: null, open: null, getElementById: id => id === 'automation-dialog' ? dialog : null, querySelector: selector => selector === 'dialog[open]' && dialog.open ? dialog : null };
  doc.activeElement = doc.body;
  const element = name => ({ name, isConnected: true, disabled: false, focus() { doc.activeElement = this; focused.push(name); } });
  const field = element('first field'), title = element('title'), keep = element('keep editing'), trigger = element('trigger');
  const prompt = { hidden: true, querySelector: () => keep };
  const dialog = { open: false, dataset: {}, attributes: {}, html: '', set innerHTML(value) { this.html = value; }, setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; },
    showModal() { this.open = true; }, close() { this.open = false; for (const fn of listeners.close || []) fn({}); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    querySelector(selector) { if (selector === '[data-automation-discard]') return prompt; if (selector.startsWith('[data-automation-dialog-body]')) return this.withField ? field : null; if (selector === '#automation-dialog-title') return title; return null; } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else delete globalThis.document; });
  return { doc, dialog, prompt, focused, listeners, trigger, element };
}

test('diálogo: foco no primeiro campo, Esc com formulário alterado pede confirmação e o foco volta ao gatilho', t => {
  const dom = fakeDom(t), host = createDialogHost({ focus: createFocusMemory() });
  dom.dialog.withField = true;
  assert.equal(host.open({ title: 'Editar regra', description: 'Empresa A', body: '<form></form>', returnElement: dom.trigger }), true);
  assert.equal(dom.dialog.open, true); assert.equal(dom.focused.at(-1), 'first field');
  assert.match(dom.dialog.html, /id="automation-dialog-title" tabindex="-1">Editar regra</); assert.equal(dom.dialog.attributes['aria-describedby'], 'automation-dialog-desc');
  assert.match(dom.dialog.html, /data-action="automation:close-dialog"/); assert.match(dom.dialog.html, /data-automation-discard hidden/);
  const escape = () => { const event = { prevented: false, preventDefault() { this.prevented = true; } }; for (const fn of dom.listeners.cancel) fn(event); return event.prevented; };
  assert.equal(escape(), false, 'Esc closes an untouched form');
  for (const fn of dom.listeners.input) fn({ target: { closest: () => null } });
  assert.equal(escape(), true, 'Esc on a changed form asks first'); assert.equal(dom.prompt.hidden, false); assert.equal(dom.focused.at(-1), 'keep editing');
  assert.equal(escape(), true, 'Esc again never bypasses the discard choice');
  host.keep(); assert.equal(dom.prompt.hidden, true); assert.equal(dom.focused.at(-1), 'first field');
  host.close(); assert.equal(dom.dialog.open, false); assert.equal(dom.focused.at(-1), 'trigger', 'focus returns to the control that opened the dialog');
});

test('diálogo: Fechar e Cancelar preservam alterações; descartar ou concluir fecha normalmente', async t => {
  const dom = fakeDom(t), host = createDialogHost({ focus: createFocusMemory() }), c = fixture();
  c.ui = createAutomationUI({ ...c.context, dialogHost: host });
  host.open({ title: 'Editar regra', body: '<form></form>', returnElement: dom.trigger });
  await c.ui.act('automation:close-dialog');
  assert.equal(dom.dialog.open, false, 'formulário intocado fecha diretamente');
  for (const label of ['Fechar', 'Cancelar']) {
    host.open({ title: 'Editar regra', body: '<form></form>', returnElement: dom.trigger });
    for (const fn of dom.listeners.input) fn({ target: { closest: () => null } });
    await c.ui.act('automation:close-dialog');
    assert.equal(dom.dialog.open, true, `${label} conserva o diálogo alterado`); assert.equal(dom.prompt.hidden, false);
    await c.ui.act('automation:dialog-keep'); assert.equal(dom.dialog.open, true); assert.equal(dom.prompt.hidden, true);
    await c.ui.act('automation:close-dialog'); await c.ui.act('automation:dialog-discard');
    assert.equal(dom.dialog.open, false); assert.equal(dom.focused.at(-1), 'trigger');
  }
  host.open({ title: 'Editar regra', body: '<form></form>' }); dom.dialog.dataset.dirty = 'true';
  host.close(); assert.equal(dom.dialog.open, false, 'fechamento após sucesso não pede descarte');
});

test('diálogo sem campos foca o título; diálogo trocado por um render devolve o foco pelo gatilho na próxima pintura', t => {
  const dom = fakeDom(t), memory = createFocusMemory(), host = createDialogHost({ focus: memory });
  host.open({ title: 'Publicar fluxo', body: '<p>…</p>', returnKey: 'flow-publish' });
  assert.equal(dom.focused.at(-1), 'title'); assert.equal(dom.dialog.attributes['aria-describedby'], undefined);
  dom.dialog.open = false; // render() replaced the dialog with a closed one
  host.reconcile(); assert.equal(memory.wanted, 'flow-publish');
  const publish = dom.element('publish'), main = { ownerDocument: dom.doc, querySelector: selector => selector === '[data-automation-focus="flow-publish"]' ? publish : null };
  dom.doc.activeElement = dom.doc.body;
  assert.equal(memory.restore(main), true); assert.equal(dom.focused.at(-1), 'publish');
});

test('memória de foco devolve o último controle após um render, sem roubar o foco do título nem de um diálogo aberto', t => {
  const dom = fakeDom(t), memory = createFocusMemory();
  const search = { ...dom.element('search'), type: 'search', value: 'boas', setSelectionRange(start, end) { this.range = [start, end]; } };
  const tab = dom.element('replies tab');
  dom.doc.querySelector = selector => selector.includes('[role="tab"][data-tab="replies"]') ? tab : selector === 'dialog[open]' && dom.dialog.open ? dom.dialog : null;
  const main = { ownerDocument: dom.doc, querySelector: selector => selector === '[data-automation-focus="replies-search"]' ? search : null };
  memory.remember('replies-search'); dom.doc.activeElement = dom.doc.body;
  assert.equal(memory.restore(main), true); assert.equal(dom.focused.at(-1), 'search'); assert.deepEqual(search.range, [4, 4], 'the caret goes back to the end of the query');
  dom.doc.activeElement = { name: 'h1', isConnected: true };
  assert.equal(memory.restore(main), false, 'a heading focused by the route keeps the focus');
  memory.remember('tab:replies'); dom.doc.activeElement = dom.doc.body;
  assert.equal(memory.restore(main), true); assert.equal(dom.focused.at(-1), 'replies tab');
  dom.dialog.open = true; memory.want('replies-search');
  assert.equal(memory.restore(main), false, 'an open dialog owns the focus');
});
