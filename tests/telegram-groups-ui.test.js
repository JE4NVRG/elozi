import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramGroupsUi } from '../public/telegram-groups-ui.js';

const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const attribute = (text, name) => decode(new RegExp(`${name}="([^"]*)"`).exec(text)?.[1] || '');
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function fixture(t, { intercept, queuedClose = false, onUpdate } = {}) {
  const original = globalThis.FormData;
  globalThis.FormData = class {
    constructor(form) { this.fields = form.fields; }
    getAll(name) { return this.fields.filter(f => f.name === name && (!['checkbox', 'radio'].includes(f.type) || f.checked)).map(f => f.value); }
    get(name) { return this.getAll(name)[0] ?? null; }
  };
  t.after(() => { globalThis.FormData = original; });
  const channel = { id: 'tg-a', kind: 'telegram', transport: 'telegram-bot' };
  const state = { view: 'channels', workspaceId: 'workspace-a', tenant: { id: 'tenant-a', resellerId: 'workspace-a', channels: [channel] },
    boot: { session: { role: 'reseller', userId: 'admin-a', resellerId: 'workspace-a', permissions: null, scopeRules: null }, workspaces: [{ id: 'workspace-a' }], tenants: [{ id: 'tenant-a' }] } };
  let source = { tenantId: 'tenant-a', channelId: 'tg-a', version: 0, mode: 'all', groupIds: [], groupReadMode: 'mentions', connectionState: 'connected', groups: [
    { id: '-11', name: 'Grupo <QA> "A"', type: 'group', memberStatus: 'member', joined: true, canSend: true, selected: true },
    { id: '-22', name: 'Grupo antigo', type: 'supergroup', memberStatus: 'left', joined: false, canSend: false, selected: true }
  ] };
  const calls = [], updates = [], notices = [], listeners = new Map(), closeEvents = [];
  const modal = { open: false, markup: '', panel: null, form: null,
    addEventListener(name, listener) { listeners.set(name, listener); },
    close() { this.open = false; const event = () => listeners.get('close')?.(); if (queuedClose) closeEvents.push(event); else event(); },
    querySelector(selector) { return selector === '[data-telegram-groups-panel]' ? this.panel : null; } };
  const parse = markup => {
    const token = attribute(markup, 'data-telegram-groups-token'), feedback = { textContent: '' }, current = { innerHTML: '' }, save = { disabled: false };
    const fields = [...markup.matchAll(/<input\b([^>]*)>/g)].map(match => ({ name: attribute(match[1], 'name'), value: attribute(match[1], 'value'), type: attribute(match[1], 'type'), checked: /\bchecked\b/.test(match[1]) }));
    modal.permissions = new Map([...markup.matchAll(/<small\b([^>]*data-telegram-group-permissions[^>]*)>([\s\S]*?)<\/small>/g)].map(match => [attribute(match[1], 'data-telegram-group-permissions'), { textContent: decode(match[2]) }]));
    modal.panel = { dataset: { telegramGroupsToken: token }, querySelector(selector) { return selector === '.form-error' ? feedback : selector === '[data-telegram-groups-current]' ? current : modal.permissions.get(/^\[data-telegram-group-permissions="([^"]+)"\]$/.exec(selector)?.[1]) || null; }, querySelectorAll: selector => selector === '[type="submit"]' ? [save] : [] };
    modal.form = markup.includes('data-telegram-groups-form') ? { dataset: { telegramGroupsForm: '', telegramGroupsToken: token }, fields, feedback, current, save,
      mode(value) { for (const field of this.fields.filter(f => f.name === 'mode')) field.checked = field.value === value; },
      select(id, selected = true) { const field = this.fields.find(f => f.name === 'groupIds' && f.value === id); if (!field) throw new Error('Missing fixture group'); field.checked = selected; },
      selected() { return this.fields.filter(f => f.name === 'groupIds' && f.checked).map(f => f.value); }
    } : null;
  };
  const fallback = init => {
    if (init.method === 'GET') return structuredClone(source);
    const input = JSON.parse(init.body);
    if (input.version !== source.version) throw Object.assign(new Error('Synthetic CAS conflict'), { status: 409 });
    source = { ...source, version: source.version + 1, mode: input.mode, groupIds: [...input.groupIds] };
    return structuredClone(source);
  };
  const api = async (path, init) => { calls.push({ path, init }); return intercept ? intercept(path, init, () => fallback(init)) : fallback(init); };
  const ui = createTelegramGroupsUi({ state, api, getModal: () => modal, openModal(title, subtitle, markup) { modal.open = true; modal.markup = markup; parse(markup); },
    toast: (message, error) => notices.push({ message, error }), onUpdate: async value => { updates.push(value); await onUpdate?.(value); } });
  return { state, channel, ui, modal, calls, updates, notices, source: () => source, setSource: update => { source = { ...source, ...update }; }, writes: () => calls.filter(c => c.init.method === 'POST'),
    action: name => ui.action({ dataset: { telegramGroupsAction: name, telegramGroupsToken: modal.panel?.dataset.telegramGroupsToken } }), flushClose: () => { while (closeEvents.length) closeEvents.shift()(); } };
}

test('administrador com boot real sem CSRF lê grupos e grava seleção explícita, sem refletir campos privados', async t => {
  const f = fixture(t); f.setSource({ token: 'DO-NOT-REFLECT', groups: f.source().groups.map(group => ({ ...group, inviteLink: 'DO-NOT-REFLECT' })) });
  assert.equal(await f.ui.open(f.channel), true);
  assert.equal(f.calls[0].path, '/api/tenants/tenant-a/channels/tg-a/telegram/groups');
  assert.deepEqual(f.calls[0].init.headers, { 'X-Elozi-Workspace': 'workspace-a' });
  assert.equal(f.modal.markup.includes('DO-NOT-REFLECT'), false); assert.equal(f.modal.markup.includes('<QA>'), false);
  assert.ok(f.modal.form.fields.some(field => field.name === 'groupIds' && field.value === '-22'));
  f.modal.form.mode('selected'); f.modal.form.select('-11'); await f.ui.submit(f.modal.form);
  assert.deepEqual(JSON.parse(f.writes()[0].init.body), { version: 0, mode: 'selected', groupIds: ['-11'] });
  assert.equal(f.source().version, 1); assert.equal(f.modal.open, false); assert.equal(f.updates[0].token, undefined);
});

test('todos e seleção vazia são modos distintos e preservam grupo indisponível no cadastro', async t => {
  const f = fixture(t); f.setSource({ version: 2, mode: 'selected', groupIds: ['-22'] }); await f.ui.open(f.channel);
  assert.deepEqual(f.modal.form.selected(), ['-22']); f.modal.form.select('-22', false); await f.ui.submit(f.modal.form);
  assert.deepEqual(JSON.parse(f.writes()[0].init.body), { version: 2, mode: 'selected', groupIds: [] });
  await f.ui.open(f.channel); f.modal.form.mode('all'); await f.ui.submit(f.modal.form);
  assert.equal(f.source().mode, 'all'); assert.equal(f.writes().length, 2);
});

test('resumo geral permitido mantém bloqueios por tipo visíveis e seleção grava apenas IDs e versão', async t => {
  const f = fixture(t), permissions = { text: true, photos: false, audios: false, documents: true, videos: null, voiceNotes: false, videoNotes: true };
  f.setSource({ groups: f.source().groups.map(g => g.id === '-11' ? { ...g, canSend: true, sendPermissions: { ...permissions, token: 'DO-NOT-REFLECT' } } : g) });
  await f.ui.open(f.channel); const note = f.modal.permissions.get('-11')?.textContent || '';
  assert.match(note, /Bloqueados: fotos, áudio, voz/); assert.match(note, /Permitidos: texto, documentos/); assert.match(note, /Não confirmados: vídeos/);
  assert.doesNotMatch(note, /videoNotes|vídeo circular|nota de vídeo/); assert.equal(f.modal.markup.includes('DO-NOT-REFLECT'), false);
  assert.equal(f.modal.markup.includes('<QA>'), false);
  f.modal.form.mode('selected'); f.modal.form.select('-11'); await f.ui.submit(f.modal.form);
  assert.deepEqual(JSON.parse(f.writes()[0].init.body), { version: 0, mode: 'selected', groupIds: ['-11'] });
  assert.deepEqual(f.updates[0].groups[0].sendPermissions, permissions);
});

test('permissões ausentes ou desconhecidas não são anunciadas como concedidas e DTO malformado não habilita formulário', async t => {
  const f = fixture(t); await f.ui.open(f.channel);
  assert.match(f.modal.permissions.get('-11')?.textContent || '', /Permissões de envio ainda não confirmadas/);
  const unknown = { text: null, photos: null, audios: null, documents: null, videos: null, voiceNotes: null, videoNotes: true };
  f.setSource({ groups: f.source().groups.map(g => g.id === '-11' ? { ...g, sendPermissions: unknown } : g) }); await f.ui.open(f.channel);
  const note = f.modal.permissions.get('-11')?.textContent || '';
  assert.match(note, /ainda não confirmadas/); assert.doesNotMatch(note, /Permitidos|videoNotes|voz permitida/);
  for (const sendPermissions of [null, [], 'all', { text: 'true' }, { photos: 1 }, { voiceNotes: '<script>' }]) {
    const g = fixture(t); g.setSource({ groups: g.source().groups.map(group => ({ ...group, sendPermissions })) });
    assert.equal(await g.ui.open(g.channel), false); assert.equal(g.modal.form, null); assert.equal(g.writes().length, 0);
  }
});

test('consulta após CAS atualiza permissões exibidas sem apagar escolhas do administrador', async t => {
  const f = fixture(t), first = { text: true, photos: true, audios: null, documents: null, videos: null, voiceNotes: null };
  f.setSource({ groups: f.source().groups.map(g => g.id === '-11' ? { ...g, sendPermissions: first } : g) });
  await f.ui.open(f.channel); const form = f.modal.form; form.mode('selected'); form.select('-11');
  assert.match(f.modal.permissions.get('-11')?.textContent || '', /Permitidos: texto, fotos/);
  f.setSource({ version: 1, groups: f.source().groups.map(g => g.id === '-11' ? { ...g, sendPermissions: { ...first, photos: false } } : g) });
  await f.ui.submit(form); await f.action('refresh');
  assert.equal(f.modal.form, form); assert.deepEqual(form.selected(), ['-11']); assert.equal(form.save.disabled, false);
  assert.match(f.modal.permissions.get('-11')?.textContent || '', /Bloqueados: fotos/);
  assert.doesNotMatch(f.modal.permissions.get('-11')?.textContent || '', /Permitidos: texto, fotos/);
  await f.ui.submit(form); assert.deepEqual(JSON.parse(f.writes()[1].init.body), { version: 1, mode: 'selected', groupIds: ['-11'] });
});

test('operador, suporte, serviço, workspace e canal alheios não consultam nem gravam', async t => {
  for (const change of ['operator', 'support', 'service', 'owner', 'channel', 'identity']) {
    const f = fixture(t);
    if (change === 'operator') f.state.boot.session.role = 'operator';
    if (change === 'support') f.state.boot.session.supportGrantId = 'delegated';
    if (change === 'service') f.state.boot.session.kind = 'service';
    if (change === 'owner') f.state.tenant.resellerId = 'another-workspace';
    if (change === 'channel') f.state.tenant.channels = [];
    if (change === 'identity') delete f.state.boot.session.userId;
    assert.equal(await f.ui.open(f.channel), false); assert.equal(f.calls.length, 0);
  }
});

test('troca de contexto ou autoridade durante GET ignora resposta e não habilita formulário', async t => {
  for (const change of ['workspace', 'tenant', 'user', 'support', 'role', 'permissions', 'csrf']) {
    const response = deferred(), f = fixture(t, { intercept: () => response.promise }), opening = f.ui.open(f.channel);
    if (change === 'workspace') f.state.workspaceId = 'other';
    if (change === 'tenant') f.state.tenant.id = 'other';
    if (change === 'user') f.state.boot.session.userId = 'other';
    if (change === 'support') f.state.supportGrantId = 'other';
    if (change === 'role') f.state.boot.session.role = 'operator';
    if (change === 'permissions') f.state.boot.session.permissions = [];
    if (change === 'csrf') f.state.boot.csrfToken = 'optional';
    response.resolve(f.source()); assert.equal(await opening, false); assert.equal(f.modal.form, null); assert.equal(f.writes().length, 0);
  }
});

test('CSRF opcional existente segue no header e sua troca invalida formulário antigo', async t => {
  for (const holder of ['boot', 'session']) {
    const f = fixture(t), token = holder === 'boot' ? f.state.boot : f.state.boot.session; token.csrfToken = 'optional-token'; await f.ui.open(f.channel);
    assert.equal(f.calls[0].init.headers['X-CSRF-Token'], 'optional-token'); const form = f.modal.form; delete token.csrfToken;
    await assert.rejects(f.ui.submit(form), /Abra a seleção/); assert.equal(f.writes().length, 0);
    await f.ui.open(f.channel); await f.ui.submit(f.modal.form); assert.equal(Object.hasOwn(f.writes()[0].init.headers, 'X-CSRF-Token'), false);
  }
});

test('CAS mantém escolha e exige consulta de revisão antes de salvar novamente', async t => {
  const f = fixture(t); await f.ui.open(f.channel); f.modal.form.mode('selected'); f.modal.form.select('-11'); const form = f.modal.form;
  f.setSource({ version: 1, mode: 'selected', groupIds: ['-22'] }); await f.ui.submit(form);
  assert.equal(form.save.disabled, true); assert.deepEqual(form.selected(), ['-11']); assert.equal(f.source().groupIds[0], '-22');
  await assert.rejects(f.ui.submit(form), /Atualize a revisão/); assert.equal(f.writes().length, 1);
  await f.action('refresh'); assert.equal(f.modal.form, form); assert.equal(form.save.disabled, false); assert.deepEqual(form.selected(), ['-11']);
  await f.ui.submit(form); assert.deepEqual(JSON.parse(f.writes()[1].init.body), { version: 1, mode: 'selected', groupIds: ['-11'] });
  assert.deepEqual(f.source().groupIds, ['-11']);
});

test('gravação incerta faz somente GET de verificação, sem repetir POST; reabertura mantém essa proteção', async t => {
  let writes = 0;
  const f = fixture(t, { intercept: (path, init, fallback) => { if (init.method === 'POST' && ++writes === 1) { fallback(); throw new TypeError('Synthetic network loss'); } return fallback(); } });
  await f.ui.open(f.channel); f.modal.form.mode('selected'); f.modal.form.select('-11'); await f.ui.submit(f.modal.form);
  assert.equal(f.modal.form, null); assert.equal(f.writes().length, 1); f.modal.close();
  await f.ui.open(f.channel); assert.equal(f.writes().length, 1); assert.deepEqual(f.modal.form.selected(), ['-11']); assert.equal(f.source().version, 1);
  assert.equal(f.calls.at(-1).init.method, 'GET'); assert.equal(f.updates.length, 1);
});

test('POST atrasado após troca de empresa não fecha outro modal nem aplica sucesso local', async t => {
  const response = deferred(), f = fixture(t, { intercept: (path, init, fallback) => init.method === 'POST' ? response.promise : fallback() });
  await f.ui.open(f.channel); const saving = f.ui.submit(f.modal.form);
  f.state.tenant.id = 'tenant-b'; f.modal.panel.dataset.telegramGroupsToken = 'another-modal';
  response.resolve({ ...f.source(), version: 1 }); await saving;
  assert.equal(f.modal.open, true); assert.equal(f.updates.length, 0); assert.equal(f.notices.length, 0);
});

test('close enfileirado anterior não invalida a seleção do modal reaberto; reset aborta consulta', async t => {
  const f = fixture(t, { queuedClose: true }); await f.ui.open(f.channel); await f.ui.submit(f.modal.form); await f.ui.open(f.channel);
  const form = f.modal.form, signal = f.calls.at(-1).init.signal; f.flushClose(); assert.equal(signal.aborted, false);
  form.mode('selected'); form.select('-11'); await f.ui.submit(form); assert.equal(f.writes().length, 2);
  const slow = deferred(), g = fixture(t, { intercept: () => slow.promise }), reading = g.ui.open(g.channel); g.ui.reset();
  assert.equal(g.calls[0].init.signal.aborted, true); slow.resolve(g.source()); assert.equal(await reading, false);
});

test('DTO de outro canal/tenant ou IDs não canônicos e formulário forjado não podem salvar', async t => {
  for (const wrong of [{ tenantId: 'tenant-b' }, { channelId: 'tg-b' }, { mode: 'unknown' }, { version: -1 }, { groupIds: ['-33'] }, { groups: [{ id: '11', name: 'bad' }] }]) {
    const f = fixture(t); f.setSource(wrong); assert.equal(await f.ui.open(f.channel), false); assert.equal(f.modal.form, null); assert.equal(f.writes().length, 0);
  }
  const f = fixture(t); await f.ui.open(f.channel); f.modal.form.fields.push({ name: 'groupIds', value: '-33', type: 'checkbox', checked: true });
  await assert.rejects(f.ui.submit(f.modal.form), /somente grupos conhecidos/); assert.equal(f.writes().length, 0);
});

test('conflito de migração é visível e salvar seleção não remove seus vínculos administrativos', async t => {
  const f = fixture(t); f.setSource({ mode: 'selected', groupIds: ['-11'], migrationConflicts: [{ fromGroupId: '-11', toGroupId: '-22' }], groups: f.source().groups.map(g => ({ ...g, migrationConflict: true, canSend: false })) });
  await f.ui.open(f.channel);
  assert.match(f.modal.markup, /Migração com conflito; atendimento bloqueado/);
  assert.match(f.modal.markup, /mudar a seleção não resolve o conflito/);
  assert.deepEqual(f.modal.form.selected(), ['-11']); f.modal.form.select('-22'); await f.ui.submit(f.modal.form);
  assert.deepEqual(JSON.parse(f.writes()[0].init.body), { version: 0, mode: 'selected', groupIds: ['-11', '-22'] });
  assert.deepEqual(f.updates[0].migrationConflicts, [{ fromGroupId: '-11', toGroupId: '-22' }]);
  assert.equal(f.updates[0].groups.every(g => g.migrationConflict), true);
});

test('conflito descoberto no refresh de CAS aparece sem apagar o draft do administrador', async t => {
  const f = fixture(t); await f.ui.open(f.channel); const form = f.modal.form; form.mode('selected'); form.select('-11');
  f.setSource({ version: 1, migrationConflicts: [{ fromGroupId: '-11', toGroupId: '-22' }], groups: f.source().groups.map(group => ({ ...group, migrationConflict: true, canSend: false })) });
  await f.ui.submit(form); await f.action('refresh');
  assert.equal(f.modal.form, form); assert.deepEqual(form.selected(), ['-11']);
  assert.match(form.current.innerHTML, /bloqueadas até revisão administrativa/); assert.match(form.current.innerHTML, /mudar a seleção não resolve/);
});
