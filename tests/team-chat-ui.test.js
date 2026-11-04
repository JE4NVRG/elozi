import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamChatUI, teamChatContextKey, normalizeTeamChatRoom, normalizeTeamChatMessages } from '../public/team-chat-ui.js';
import { createAvatarUI } from '../public/avatar-ui.js';
import { getLocale, setLocale, t as translate } from '../public/i18n.js';

const photo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Z1kAAAAASUVORK5CYII=';
const avatarHTML = person => createAvatarUI({ escape: value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character])), context: () => ({}) }).markup(person.name, person.avatar, 'team-chat-avatar');

const context = extra => ({ active: true, workspaceId: 'workspace', tenantId: 'tenant', userId: 'self', authorityKey: 'session', canManage: true, tenantName: 'Empresa QA', ...extra });
const room = extra => ({ id: 'room', tenantId: 'tenant', name: 'Operação', version: 4, createdBy: { id: 'self', name: 'Eu' }, canManage: true, members: [{ id: 'self', name: 'Eu', eligible: true }, { id: 'member', name: 'Pessoa da equipe', eligible: true }], lastSequence: 0, readSequence: 0, unreadCount: 0, ...extra });
const message = extra => ({ id: 'message', tenantId: 'tenant', roomId: 'room', sequence: 1, text: 'Próximo passo', createdAt: '2026-10-02T12:00:00Z', author: { id: 'member', name: 'Pessoa da equipe' }, ...extra });
const decode = value => String(value || '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

// Narrow DOM adapter: slots replace independently, while the textarea keeps its identity.
function rootAdapter(html, doc) {
  const nodes = {}, listeners = new Map(); let roomButtons = [];
  const root = { isConnected: true, dataset: { teamChatKey: decode(html.match(/data-team-chat-key="([^"]*)"/)[1]), teamChatRoom: decode(html.match(/data-team-chat-room="([^"]*)"/)[1]), teamChatMode: html.match(/data-team-chat-mode="([^"]*)"/)?.[1] || '' }, querySelector: selector => nodes[selector] || null, querySelectorAll: selector => selector === '[data-team-chat-action="select"]' ? roomButtons : [], contains: node => node?.root === root, addEventListener: (name, listener) => listeners.set(name, listener) };
  const node = (value = '') => ({ root, value, disabled: false, isConnected: true, innerHTML: '', textContent: '', dataset: {}, focus() { if (doc && !this.disabled) { doc.activeElement = this; doc.focuses.push(this); } }, matches(selector) { return selector.split(',').some(item => nodes[item.trim()] === this); } });
  for (const selector of ['[data-team-chat-rooms]', '[data-team-chat-header]', '[data-team-chat-messages]', '[data-team-chat-status]', '[data-team-chat-room-count]', '[data-team-chat-search]', '[data-team-chat-room-search]', '[data-team-chat-reference]', '[data-team-chat-send]', '[data-team-chat-review]']) nodes[selector] = node();
  nodes['[data-team-chat-draft]'] = node(decode(html.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)?.[1]));
  nodes['[data-team-chat-draft]'].selectionStart = 7; nodes['[data-team-chat-draft]'].selectionEnd = 9;
  nodes['[data-team-chat-compose]'] = node(); nodes['[data-team-chat-compose]'].dataset = { teamChatForm: 'message', teamChatVersion: html.match(/data-team-chat-version="(\d+)"/)?.[1] || '0' };
  nodes['[data-team-chat-action="back"]'] = node();
  let roomsHTML = '';
  Object.defineProperty(nodes['[data-team-chat-rooms]'], 'innerHTML', { get: () => roomsHTML, set(value) {
    if (doc && roomButtons.includes(doc.activeElement)) doc.activeElement = doc.body;
    roomsHTML = value;
    roomButtons = [...value.matchAll(/data-team-chat-action="select" data-room-id="([^"]*)"/g)].map(([, id]) => Object.assign(node(), { dataset: { roomId: decode(id) } }));
  } });
  Object.assign(nodes['[data-team-chat-messages]'], { scrollTop: 0, scrollHeight: 100, clientHeight: 100 });
  return { root, nodes, listeners, action: (action, extra = {}) => ({ root, dataset: { teamChatAction: action, ...extra } }) };
}
function modalAdapter() {
  const modal = { open: false, panel: null, closes: 0, querySelector: () => modal.panel, close() { this.open = false; this.closes++; } };
  const openModal = (_title, _description, html) => {
    const body = { innerHTML: '' }, error = { textContent: '' };
    const panel = { dataset: { teamChatToken: html.match(/data-team-chat-token="([^"]*)"/)[1] }, contains: node => node?.panel === panel, querySelector: selector => selector === '[data-team-chat-modal-body]' ? body : selector === '[data-team-chat-modal-error]' ? error : null, body, error };
    modal.panel = panel; modal.open = true;
  };
  return { modal, openModal };
}
function setup(extra = {}) {
  const { modal, openModal } = modalAdapter(), state = { context: context(extra.context), rooms: extra.rooms || [room()], messages: extra.messages || [], users: extra.users || [{ id: 'self', name: 'Eu' }, { id: 'member', name: 'Pessoa da equipe' }, { id: 'new', name: 'Outra pessoa' }] }, calls = [], errors = [], opened = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (extra.request) { const override = await extra.request(path, options, state); if (override !== undefined) return override; }
    const input = options.body ? JSON.parse(options.body) : {}, url = new URL(path, 'http://local');
    if (url.pathname.endsWith('/directory')) return { users: structuredClone(state.users) };
    if (url.pathname.endsWith('/rooms') && options.method === 'GET') return { rooms: state.rooms.map(item => { const { members, ...summary } = structuredClone(item); return { ...summary, memberCount: members.length }; }) };
    const selected = state.rooms.find(item => url.pathname.includes(`/rooms/${encodeURIComponent(item.id)}`));
    if (url.pathname.endsWith('/rooms') && options.method === 'POST') { const created = room({ id: 'created', name: input.name, members: state.users.filter(user => user.id === 'self' || input.memberIds.includes(user.id)).map(user => ({ ...user, eligible: true })) }); state.rooms.push(created); return structuredClone(created); }
    if (!selected) throw Object.assign(new Error('Acesso alterado'), { status: 403 });
    if (url.pathname.endsWith('/read')) { selected.readSequence = input.sequence; selected.unreadCount = 0; return { roomId: selected.id, readSequence: input.sequence, lastSequence: selected.lastSequence, unreadCount: 0 }; }
    if (url.pathname.endsWith('/messages') && options.method === 'POST') { const saved = message({ id: 'sent', roomId: selected.id, text: input.text, sequence: state.messages.length + 1, author: { id: 'self', name: 'Eu' } }); state.messages.push(saved); return structuredClone(saved); }
    if (url.pathname.endsWith('/messages')) { const before = Number(url.searchParams.get('before')), after = Number(url.searchParams.get('after')); return { messages: structuredClone(state.messages.filter(item => item.roomId === selected.id && (!before || item.sequence < before) && (!after || item.sequence > after))), hasMore: false, before: state.messages[0]?.sequence || null, readSequence: selected.readSequence, lastSequence: selected.lastSequence }; }
    if (url.pathname.endsWith('/members')) { selected.version++; if (input.action === 'remove') selected.members = selected.members.filter(person => person.id !== input.userId); else selected.members.push({ ...state.users.find(person => person.id === input.userId), eligible: true }); return structuredClone(selected); }
    return structuredClone(selected);
  };
  const ui = createTeamChatUI({ getContext: () => state.context, request, openModal, getModal: () => modal, getConversations: () => extra.conversations || [], avatarHTML: extra.avatarHTML, onRender: extra.onRender, onError: error => errors.push(error), onOpenConversation: (...args) => opened.push(args), document: extra.document });
  return { ui, state, calls, errors, opened, modal, attach() { const dom = rootAdapter(ui.render({ drawer: extra.drawer }), extra.document); ui.bind(dom.root); return dom; } };
}
async function ready(env) { const dom = env.attach(); await tick(); await env.ui.handleAction(dom.action('select', { roomId: 'room' })); return dom; }
function edit(dom, text, referenceId = '') { dom.nodes['[data-team-chat-draft]'].value = text; dom.nodes['[data-team-chat-reference]'].value = referenceId; dom.listeners.get('input')({ target: dom.nodes['[data-team-chat-draft]'] }); }
function focusDocument(mobile = true) { const body = {}; return { body, activeElement: body, focuses: [], defaultView: { matchMedia: () => ({ matches: mobile }) } }; }
const roomButton = (dom, id) => dom.root.querySelectorAll('[data-team-chat-action="select"]').find(button => button.dataset.roomId === id);

test('fotos atuais do DTO autorizado chegam à mensagem e aos membros após paint assíncrono', async () => {
  let paints = 0;
  const env = setup({ rooms: [room({ members: [{ id: 'self', name: 'Eu', eligible: true }, { id: 'member', name: 'Pessoa da equipe', eligible: true, avatar: photo }] })], messages: [message()], avatarHTML, onRender: () => paints++ }), dom = await ready(env);
  assert.match(dom.nodes['[data-team-chat-messages]'].innerHTML, /<img src="data:image\/png;base64,/); assert.ok(paints > 0);
  await env.ui.handleAction(dom.action('members')); assert.match(env.modal.panel.body.innerHTML, /<img src="data:image\/png;base64,/);
  env.state.rooms[0].members[1].eligible = false; await env.ui.poll(); assert.doesNotMatch(dom.nodes['[data-team-chat-messages]'].innerHTML, /<img/);
  env.state.rooms[0].members = env.state.rooms[0].members.filter(person => person.id !== 'member'); await env.ui.poll(); assert.doesNotMatch(dom.nodes['[data-team-chat-messages]'].innerHTML, /<img/);
});

test('diretório conserva raster seguro na seleção; payload remoto e foto de autor histórico não são aceitos', async () => {
  const env = setup({ avatarHTML, users: [{ id: 'member', name: '<Pessoa QA>', avatar: photo }, { id: 'new', name: 'Outra pessoa', avatar: 'https://untrusted.test/avatar.png' }], messages: [message({ author: { id: 'removed', name: 'Ex-membro', avatar: photo } })] }), dom = await ready(env);
  assert.doesNotMatch(dom.nodes['[data-team-chat-messages]'].innerHTML, /<img/);
  await env.ui.handleAction(dom.action('create')); const html = env.modal.panel.body.innerHTML;
  assert.equal((html.match(/<img src=/g) || []).length, 1); assert.match(html, /&lt;Pessoa QA&gt;/); assert.doesNotMatch(html, /untrusted/);
  const member = normalizeTeamChatRoom(room({ members: [{ id: 'self', name: 'Eu', avatar: 'data:image/svg+xml;base64,PHN2Zz4=' }] }), 'tenant').members[0]; assert.equal(member.avatar, null);
});

test('foto de diretório atrasado não renderiza na empresa/autoridade seguinte', async () => {
  for (const field of ['tenantId', 'authorityKey']) {
    const gate = deferred(), env = setup({ avatarHTML, request: path => path.endsWith('/directory') ? gate.promise : undefined }), dom = await ready(env);
    const opening = env.ui.handleAction(dom.action('create')); await tick(); const oldPanel = env.modal.panel;
    env.state.context[field] = 'other'; env.ui.render(); gate.resolve({ users: [{ id: 'private', name: 'Foto de outro contexto', avatar: photo }] }); await opening;
    assert.doesNotMatch(oldPanel.body.innerHTML, /Foto de outro contexto|<img/); assert.equal(env.modal.open, false);
  }
});

test('identidade inclui usuário, empresa, workspace e autoridade sem inferir acesso da lista', () => {
  for (const key of ['userId', 'tenantId', 'workspaceId', 'authorityKey']) assert.notEqual(teamChatContextKey(context()), teamChatContextKey(context({ [key]: 'other' })));
  assert.equal(teamChatContextKey(context({ active: false })), ''); assert.equal(teamChatContextKey(context({ userId: '' })), '');
  assert.throws(() => normalizeTeamChatRoom(room({ tenantId: 'other' }), 'tenant'));
  assert.throws(() => normalizeTeamChatRoom(room({ canManage: undefined }), 'tenant'));
  assert.throws(() => normalizeTeamChatMessages({ messages: [message({ roomId: 'other' })] }, { roomId: 'room', tenantId: 'tenant' }));
  const normalized = normalizeTeamChatRoom(room({ members: [{ id: 'self', name: 'Eu', password: 'omit' }, { id: 'self' }] }), 'tenant');
  assert.equal(normalized.members.length, 1); assert.equal('password' in normalized.members[0], false);
});
test('poll preserva o nó, o texto e a seleção do compositor e atualiza mensagens/unread', async () => {
  const env = setup(), dom = await ready(env), textarea = dom.nodes['[data-team-chat-draft]']; edit(dom, 'Rascunho com contexto');
  env.state.messages.push(message()); env.state.rooms[0].lastSequence = 1; env.state.rooms[0].unreadCount = 1;
  await env.ui.poll(); assert.equal(dom.nodes['[data-team-chat-draft]'], textarea); assert.equal(textarea.value, 'Rascunho com contexto'); assert.equal(textarea.selectionStart, 7); assert.equal(textarea.selectionEnd, 9);
  assert.match(dom.nodes['[data-team-chat-messages]'].innerHTML, /Próximo passo/); assert.equal(env.state.rooms[0].readSequence, 1);
  for (const call of env.calls) assert.equal(call.options.headers['X-Elozi-Workspace'], 'workspace');
});
test('remoção do membro fecha modal, bloqueia envio e mantém texto no compositor', async () => {
  const env = setup(), dom = await ready(env); edit(dom, 'Preservar meu texto'); await env.ui.handleAction(dom.action('members')); assert.equal(env.modal.open, true);
  env.state.rooms = []; await env.ui.poll(); assert.equal(env.modal.open, false); assert.equal(dom.nodes['[data-team-chat-draft]'].value, 'Preservar meu texto'); assert.equal(dom.nodes['[data-team-chat-draft]'].disabled, true);
  await env.ui.submit(dom.nodes['[data-team-chat-compose]']); assert.equal(env.calls.some(call => call.options.method === 'POST' && call.path.endsWith('/messages')), false);
  assert.match(dom.nodes['[data-team-chat-messages]'].innerHTML, /Seu acesso a esta sala mudou/);
});
test('membro inelegível no detalhe também revoga o compositor', async () => {
  const env = setup(), dom = await ready(env); edit(dom, 'Texto ainda aqui'); env.state.rooms[0].members[0].eligible = false;
  await env.ui.poll(); assert.equal(dom.nodes['[data-team-chat-draft]'].disabled, true); assert.equal(dom.nodes['[data-team-chat-draft]'].value, 'Texto ainda aqui');
});
test('retorno atrasado de outro usuário/workspace/tenant é descartado e abortado', async () => {
  for (const field of ['userId', 'workspaceId', 'tenantId']) {
    const gate = deferred(); let delayed = false;
    const env = setup({ request: (path, options) => delayed && path.endsWith('/rooms') && options.method === 'GET' ? gate.promise : undefined }), dom = await ready(env); edit(dom, 'Rascunho original');
    delayed = true; const pending = env.ui.poll(); await tick(); const signal = env.calls.at(-1).options.signal; env.state.context[field] = 'other'; const changed = env.ui.render(); gate.resolve({ rooms: [room({ name: 'Nunca renderizar' })] }); await pending;
    assert.equal(signal.aborted, true); assert.doesNotMatch(changed, /Rascunho original|Nunca renderizar/); assert.doesNotMatch(dom.nodes['[data-team-chat-rooms]'].innerHTML, /Nunca renderizar/);
  }
});
test('resposta antiga da sala não entra após seleção de outra sala', async () => {
  const gate = deferred(); let delayed = false;
  const env = setup({ rooms: [room(), room({ id: 'second', name: 'Outra sala' })], request: (path, options) => delayed && path.includes('/rooms/room/messages') && options.method === 'GET' ? gate.promise : undefined }), dom = await ready(env);
  delayed = true; const pending = env.ui.poll(); await tick(); await env.ui.handleAction(dom.action('select', { roomId: 'second' })); gate.resolve({ messages: [message({ text: 'Resposta antiga' })] }); await pending;
  assert.equal(dom.root.dataset.teamChatRoom, 'second'); assert.doesNotMatch(dom.nodes['[data-team-chat-messages]'].innerHTML, /Resposta antiga/);
});
test('rascunhos em RAM separam salas e a mesma identidade entre empresas', async () => {
  const env = setup({ rooms: [room(), room({ id: 'second' })] }), dom = await ready(env); edit(dom, 'Texto da sala A'); await env.ui.handleAction(dom.action('select', { roomId: 'second' })); assert.equal(dom.nodes['[data-team-chat-draft]'].value, '');
  edit(dom, 'Texto da sala B'); await env.ui.handleAction(dom.action('select', { roomId: 'room' })); assert.equal(dom.nodes['[data-team-chat-draft]'].value, 'Texto da sala A');
  env.ui.reset(); const again = env.attach(); await tick(); assert.equal(again.nodes['[data-team-chat-draft]'].value, 'Texto da sala A');
  env.ui.reset({ clearDrafts: true }); const clean = env.attach(); await tick(); assert.equal(clean.nodes['[data-team-chat-draft]'].value, '');
});
test('tentativa após falha de rede reutiliza command id e payload, sem limpar antes do aceite', async () => {
  let failures = 1;
  const env = setup({ request: (path, options) => { if (path.endsWith('/messages') && options.method === 'POST' && failures-- > 0) throw new Error('Rede interrompida'); } }), dom = await ready(env); edit(dom, 'Mensagem interna');
  await env.ui.submit(dom.nodes['[data-team-chat-compose]']); assert.equal(dom.nodes['[data-team-chat-draft]'].value, 'Mensagem interna');
  await env.ui.handleAction(dom.action('verify-send')); const sends = env.calls.filter(call => call.path.endsWith('/messages') && call.options.method === 'POST');
  assert.equal(sends.length, 2); assert.deepEqual(JSON.parse(sends[0].options.body), JSON.parse(sends[1].options.body)); assert.equal(dom.nodes['[data-team-chat-draft]'].value, ''); assert.match(dom.nodes['[data-team-chat-messages]'].innerHTML, /Mensagem interna/);
});
test('intent incerto mantém chave através de poll, edição e reset, impedindo destinatários novos', async () => {
  let lost = true, saved;
  const env = setup({ request: (path, options, state) => {
    if (path.endsWith('/messages') && options.method === 'POST') {
      const input = JSON.parse(options.body);
      if (lost) { lost = false; saved = message({ id: 'accepted', sequence: 1, text: input.text, author: { id: 'self', name: 'Eu' } }); state.messages.push(saved); throw new Error('HTTP perdido depois do COMMIT'); }
      return structuredClone(saved);
    }
  } }), dom = await ready(env); edit(dom, 'Texto enviado antes'); await env.ui.submit(dom.nodes['[data-team-chat-compose]']);
  env.state.rooms[0].version++; env.state.rooms[0].members.push({ id: 'new', name: 'Nova pessoa', eligible: true }); await env.ui.poll();
  edit(dom, 'Texto novo em edição'); assert.equal(dom.nodes['[data-team-chat-send]'].disabled, true); assert.match(dom.nodes['[data-team-chat-review]'].innerHTML, /Verificar envio/);
  await env.ui.handleAction(dom.action('review-members')); assert.equal(env.modal.open, false); await env.ui.submit(dom.nodes['[data-team-chat-compose]']); assert.equal(env.calls.filter(call => call.path.endsWith('/messages') && call.options.method === 'POST').length, 1);
  env.ui.reset(); const restored = env.attach(); await tick(); await env.ui.handleAction(restored.action('verify-send'));
  const sends = env.calls.filter(call => call.path.endsWith('/messages') && call.options.method === 'POST'); assert.deepEqual(JSON.parse(sends[0].options.body), JSON.parse(sends[1].options.body)); assert.equal(env.state.messages.length, 1);
  assert.equal(restored.nodes['[data-team-chat-draft]'].value, 'Texto novo em edição'); assert.equal(restored.nodes['[data-team-chat-send]'].disabled, true); assert.match(restored.nodes['[data-team-chat-review]'].innerHTML, /Revisar membros/);
});
test('409 no replay exato libera revisão sem reutilizar uma chave incerta', async () => {
  let attempts = 0;
  const env = setup({ request: (path, options) => {
    if (path.endsWith('/messages') && options.method === 'POST') { attempts++; if (attempts === 1) throw new Error('Sem resposta'); if (attempts === 2) throw Object.assign(new Error('A equipe mudou'), { status: 409 }); }
  } }), dom = await ready(env); edit(dom, 'Ainda não aceito'); await env.ui.submit(dom.nodes['[data-team-chat-compose]']); env.state.rooms[0].version++; await env.ui.poll();
  await env.ui.handleAction(dom.action('verify-send')); assert.match(dom.nodes['[data-team-chat-review]'].innerHTML, /Revisar membros/); assert.doesNotMatch(dom.nodes['[data-team-chat-review]'].innerHTML, /Verificar envio/);
});
test('preflight com nova versão não envia nem perde rascunho', async () => {
  const env = setup(), dom = await ready(env); edit(dom, 'Revise os membros'); env.state.rooms[0].version++;
  await env.ui.submit(dom.nodes['[data-team-chat-compose]']); assert.equal(env.calls.some(call => call.path.endsWith('/messages') && call.options.method === 'POST'), false); assert.equal(dom.nodes['[data-team-chat-draft]'].value, 'Revise os membros'); assert.match(dom.nodes['[data-team-chat-status]'].textContent, /membros da sala mudaram/);
});
test('poll não autoriza rascunho antigo para novos membros sem revisar e confirmar destinatários', async () => {
  const env = setup(), dom = await ready(env); edit(dom, 'Texto pensado para os membros originais');
  env.state.rooms[0].version++; env.state.rooms[0].members.push({ id: 'new', name: 'Nova pessoa', eligible: true }); await env.ui.poll();
  assert.equal(dom.nodes['[data-team-chat-send]'].disabled, true); assert.equal(dom.nodes['[data-team-chat-draft]'].disabled, false); assert.match(dom.nodes['[data-team-chat-review]'].innerHTML, /Revisar membros/);
  await env.ui.submit(dom.nodes['[data-team-chat-compose]']); assert.equal(env.calls.some(call => call.path.endsWith('/messages') && call.options.method === 'POST'), false);
  await env.ui.handleAction(dom.action('review-members')); let panel = env.modal.panel; assert.match(panel.body.innerHTML, /Nova pessoa/);
  let target = { panel, dataset: { teamChatAction: 'confirm-members', teamChatToken: panel.dataset.teamChatToken, teamChatVersion: '5' } };
  env.state.rooms[0].version++; await env.ui.handleAction(target); assert.equal(env.modal.open, true); assert.match(panel.error.textContent, /mudaram novamente/); assert.equal(dom.nodes['[data-team-chat-send]'].disabled, true);
  target = { panel, dataset: { teamChatAction: 'confirm-members', teamChatToken: panel.dataset.teamChatToken, teamChatVersion: '6' } }; await env.ui.handleAction(target);
  assert.equal(env.modal.open, false); assert.equal(dom.nodes['[data-team-chat-send]'].disabled, false); assert.equal(dom.nodes['[data-team-chat-draft]'].value, 'Texto pensado para os membros originais');
  await env.ui.submit(dom.nodes['[data-team-chat-compose]']); const send = env.calls.find(call => call.path.endsWith('/messages') && call.options.method === 'POST'); assert.equal(JSON.parse(send.options.body).version, 6);
});
test('envio próprio não salta o cursor de mensagens recebidas nem marca lacunas como lidas', async () => {
  const env = setup({ messages: [message()] }), dom = await ready(env); edit(dom, 'Meu próximo passo');
  env.state.messages.push(message({ id: 'pending', sequence: 2, text: 'Nova mensagem da equipe' }));
  await env.ui.submit(dom.nodes['[data-team-chat-compose]']); assert.equal(env.state.rooms[0].readSequence, 1);
  await env.ui.poll(); const request = env.calls.filter(call => call.options.method === 'GET' && call.path.includes('/messages?')).at(-1);
  assert.match(request.path, /after=1/); assert.match(dom.nodes['[data-team-chat-messages]'].innerHTML, /Nova mensagem da equipe/); assert.equal(env.state.rooms[0].readSequence, 3);
});
test('mensagens anteriores usam sequência, deduplicam e preservam o rascunho', async () => {
  let first = true;
  const env = setup({ messages: [message({ id: 'first', sequence: 1 }), message({ id: 'second', sequence: 2 })], request: (path, options) => {
    if (options.method === 'GET' && path.includes('/messages?') && first) { first = false; return { messages: [message({ id: 'second', sequence: 2 })], hasMore: true, before: 2 }; }
  } }), dom = await ready(env); edit(dom, 'Texto no compositor');
  await env.ui.handleAction(dom.action('older')); assert.match(env.calls.at(-1).path, /before=2/); assert.match(dom.nodes['[data-team-chat-messages]'].innerHTML, /data-team-chat-message="first"/); assert.equal(dom.nodes['[data-team-chat-draft]'].value, 'Texto no compositor');
});
test('POST que retorna após troca de identidade não limpa nem publica dados no novo contexto', async () => {
  const gate = deferred(); let delayed = false;
  const env = setup({ request: (path, options) => delayed && path.endsWith('/messages') && options.method === 'POST' ? gate.promise : undefined }), dom = await ready(env); edit(dom, 'Texto guardado'); delayed = true;
  const pending = env.ui.submit(dom.nodes['[data-team-chat-compose]']); await tick(); env.state.context.userId = 'other'; const changed = env.ui.render(); gate.resolve(message({ text: 'Aceite antigo', author: { id: 'self', name: 'Eu' } })); await pending;
  assert.doesNotMatch(changed, /Texto guardado|Aceite antigo/); assert.equal(dom.nodes['[data-team-chat-draft]'].value, 'Texto guardado');
});
test('referência só navega após DTO autorizado fresco, sem copiar texto de cliente', async () => {
  const env = setup({ messages: [message({ reference: { conversationId: 'conversation', contact: 'Contato autorizado' } })], conversations: [{ id: 'conversation', contact: 'Contato autorizado', messages: [{ text: 'Texto privado de cliente' }] }] }), dom = await ready(env);
  await env.ui.handleAction(dom.action('open-reference', { messageId: 'message' })); assert.deepEqual(env.opened, [['conversation', 'tenant']]); assert.doesNotMatch(env.ui.render(), /Texto privado de cliente/);
  env.state.messages[0].reference = { unavailable: true }; await env.ui.handleAction(dom.action('open-reference', { messageId: 'message' })); assert.equal(env.opened.length, 1); assert.match(dom.nodes['[data-team-chat-messages]'].innerHTML, /Atendimento indisponível/);
});
test('busca se limita ao texto carregado e não dispara uma API de pesquisa', async () => {
  const env = setup({ messages: [message(), message({ id: 'other', sequence: 2, text: '<script>alert(1)</script>' })] }), dom = await ready(env), before = env.calls.length;
  dom.nodes['[data-team-chat-search]'].value = 'próximo'; dom.listeners.get('input')({ target: dom.nodes['[data-team-chat-search]'] });
  assert.equal(env.calls.length, before); assert.match(dom.nodes['[data-team-chat-messages]'].innerHTML, /1 resultado no histórico carregado/); assert.doesNotMatch(dom.nodes['[data-team-chat-messages]'].innerHTML, /alert/);
  assert.match(env.ui.render(), /próximo/);
});

test('busca vazia distingue nenhuma correspondência de sala sem mensagens e restaura o histórico', async t => {
  const originalLocale = getLocale(); t.after(() => setLocale(originalLocale, { persist: false, notify: false }));
  for (const locale of ['pt-BR', 'en']) {
    setLocale(locale, { persist: false, notify: false });
    const env = setup({ messages: [message()] }), dom = await ready(env), calls = env.calls.length;
    const search = dom.nodes['[data-team-chat-search]']; search.value = 'sem correspondência'; dom.listeners.get('input')({ target: search });
    const empty = dom.nodes['[data-team-chat-messages]'].innerHTML;
    assert.ok(empty.includes(translate('Nenhuma mensagem encontrada')));
    assert.ok(empty.includes(translate('Limpe a busca ou tente outro termo no histórico carregado.')));
    assert.ok(!empty.includes(translate('Comece a conversa')));
    search.value = ''; dom.listeners.get('input')({ target: search });
    assert.match(dom.nodes['[data-team-chat-messages]'].innerHTML, /Próximo passo/); assert.equal(env.calls.length, calls);
    const fresh = setup(), freshDOM = await ready(fresh);
    assert.ok(freshDOM.nodes['[data-team-chat-messages]'].innerHTML.includes(translate('Comece a conversa')));
  }
});

test('celular e gaveta movem foco para a conversa e restauram a sala ao voltar; desktop conserva o comportamento', async () => {
  for (const mode of [{ mobile: true }, { mobile: false, drawer: true }, { mobile: false }]) {
    const doc = focusDocument(mode.mobile), env = setup({ document: doc, drawer: mode.drawer }), dom = env.attach(); await tick();
    roomButton(dom, 'room').focus(); const before = doc.focuses.length;
    await env.ui.handleAction(dom.action('select', { roomId: 'room' }));
    if (!mode.mobile && !mode.drawer) { assert.equal(doc.focuses.length, before); continue; }
    assert.equal(doc.activeElement, dom.nodes['[data-team-chat-draft]']); assert.equal(dom.root.dataset.mobileOpen, 'true');
    edit(dom, 'Rascunho preservado'); dom.nodes['[data-team-chat-action="back"]'].focus(); await env.ui.handleAction(dom.action('back'));
    assert.equal(doc.activeElement, roomButton(dom, 'room')); assert.equal(dom.root.dataset.mobileOpen, 'false'); assert.equal(dom.nodes['[data-team-chat-draft]'].value, 'Rascunho preservado');
    dom.nodes['[data-team-chat-room-search]'].value = 'nenhuma sala'; dom.listeners.get('input')({ target: dom.nodes['[data-team-chat-room-search]'] });
    doc.activeElement = doc.body; await env.ui.handleAction(dom.action('back')); assert.equal(doc.activeElement, dom.nodes['[data-team-chat-room-search]']);
  }
});

test('abertura atrasada não rouba foco após voltar às salas ou mover foco para outro controle', async () => {
  for (const leave of ['back', 'other-control']) {
    const gate = deferred(), doc = focusDocument(), second = room({ id: 'second' }); let delayed = false;
    const env = setup({ document: doc, rooms: [room(), second], request: path => delayed && path.endsWith('/rooms/second') ? gate.promise : undefined }), dom = await ready(env);
    roomButton(dom, 'second').focus(); delayed = true; const pending = env.ui.handleAction(dom.action('select', { roomId: 'second' })); await tick();
    if (leave === 'back') { dom.nodes['[data-team-chat-action="back"]'].focus(); await env.ui.handleAction(dom.action('back')); }
    else doc.activeElement = { otherControl: true };
    const active = doc.activeElement, focuses = doc.focuses.length; gate.resolve(second); await pending;
    assert.equal(doc.activeElement, active); assert.equal(doc.focuses.length, focuses);
    assert.equal(dom.root.dataset.mobileOpen, leave === 'back' ? 'false' : 'true');
  }
});

test('seleção antiga e troca de identidade não focam a sala que chegou tarde', async () => {
  for (const field of ['selection', 'userId', 'tenantId', 'workspaceId', 'authorityKey']) {
    const gate = deferred(), doc = focusDocument(), second = room({ id: 'second' }); let delayed = false;
    const env = setup({ document: doc, rooms: [room(), second, room({ id: 'third' })], request: path => delayed && path.endsWith('/rooms/second') ? gate.promise : undefined }), dom = await ready(env);
    roomButton(dom, 'second').focus(); delayed = true; const pending = env.ui.handleAction(dom.action('select', { roomId: 'second' })); await tick();
    if (field === 'selection') await env.ui.handleAction(dom.action('select', { roomId: 'third' }));
    else { env.state.context[field] = 'other'; env.ui.render(); doc.activeElement = doc.body; }
    const focuses = doc.focuses.length, active = doc.activeElement; gate.resolve(second); await pending;
    assert.equal(doc.focuses.length, focuses); assert.equal(doc.activeElement, active);
    if (field === 'selection') assert.equal(dom.root.dataset.teamChatRoom, 'third');
  }
});

test('falha de acesso ao abrir sala mantém retorno por teclado no celular', async () => {
  const doc = focusDocument(); let denied = false;
  const env = setup({ document: doc, request: path => { if (denied && path.endsWith('/rooms/room')) throw Object.assign(new Error('Acesso alterado'), { status: 403 }); } }), dom = await ready(env);
  dom.nodes['[data-team-chat-action="back"]'].focus(); await env.ui.handleAction(dom.action('back'));
  denied = true; await env.ui.handleAction(dom.action('select', { roomId: 'room' }));
  assert.equal(dom.nodes['[data-team-chat-draft]'].disabled, true); assert.equal(doc.activeElement, dom.nodes['[data-team-chat-action="back"]']);
});
test('nova sala só aparece para gestão e directory atrasado não escreve em modal alheio', async () => {
  const env = setup({ context: { canManage: false } }); assert.doesNotMatch(env.ui.render(), /data-team-chat-action="create"/);
  const gate = deferred(); const admin = setup({ request: path => path.endsWith('/directory') ? gate.promise : undefined }), dom = await ready(admin), pending = admin.ui.handleAction(dom.action('create')); await tick(); const old = admin.modal.panel;
  admin.modal.panel = { dataset: {}, body: { innerHTML: 'Outro modal' } }; gate.resolve({ users: [{ id: 'new', name: 'Não renderizar' }] }); await pending; assert.equal(old.body.innerHTML, ''); assert.equal(admin.modal.panel.body.innerHTML, 'Outro modal');
});
test('criação valida 30 membros totais e não concede gestão só por isAdmin', async () => {
  const env = setup(), dom = await ready(env); await env.ui.handleAction(dom.action('create')); const panel = env.modal.panel, error = panel.error;
  const form = { panel, dataset: { teamChatForm: 'create', teamChatToken: panel.dataset.teamChatToken }, elements: { namedItem: () => ({ value: 'Sala válida' }) }, querySelectorAll: () => Array.from({ length: 30 }, (_, i) => ({ value: `u${i}` })), querySelector: () => null };
  await env.ui.submit(form); assert.match(error.textContent, /até 29/); assert.equal(env.calls.some(call => call.path.endsWith('/rooms') && call.options.method === 'POST'), false);
  env.state.rooms[0].canManage = false; await env.ui.poll(); await env.ui.handleAction(dom.action('members')); assert.doesNotMatch(env.modal.panel.body.innerHTML, /data-team-chat-action="remove-member"|data-team-chat-form="add-member"/);
});
test('cria sala e altera membros com token/versão reais, preservando usuário atual', async () => {
  const env = setup(), dom = await ready(env); await env.ui.handleAction(dom.action('create')); let panel = env.modal.panel;
  const form = { panel, dataset: { teamChatForm: 'create', teamChatToken: panel.dataset.teamChatToken }, elements: { namedItem: () => ({ value: 'Plantão' }) }, querySelectorAll: () => [{ value: 'new' }], querySelector: () => null };
  await env.ui.submit(form); assert.equal(dom.root.dataset.teamChatRoom, 'created'); assert.equal(env.modal.open, false); assert.match(dom.nodes['[data-team-chat-header]'].innerHTML, /Plantão/);
  await env.ui.handleAction(dom.action('members')); panel = env.modal.panel;
  assert.doesNotMatch(panel.body.innerHTML, /data-team-chat-action="remove-member" data-user-id="self"/);
  const add = { panel, dataset: { teamChatForm: 'add-member', teamChatToken: panel.dataset.teamChatToken, teamChatVersion: '4' }, elements: { namedItem: () => ({ value: 'member' }) } };
  await env.ui.submit(add); const created = env.state.rooms.find(item => item.id === 'created'); assert.equal(created.version, 5); assert.equal(created.members.length, 3);
  const remove = { panel, dataset: { teamChatAction: 'remove-member', teamChatToken: panel.dataset.teamChatToken, teamChatVersion: '5', userId: 'member' } };
  await env.ui.handleAction(remove); assert.equal(created.version, 6); assert.equal(created.members.length, 2);
});
test('admin membro pode remover outro criador, sem oferecer remover o próprio acesso', async () => {
  const env = setup({ rooms: [room({ createdBy: { id: 'member', name: 'Outro administrador' } })] }), dom = await ready(env); await env.ui.handleAction(dom.action('members')); const panel = env.modal.panel;
  assert.match(panel.body.innerHTML, /data-team-chat-action="remove-member" data-user-id="member"/); assert.doesNotMatch(panel.body.innerHTML, /data-team-chat-action="remove-member" data-user-id="self"/);
  const remove = { panel, dataset: { teamChatAction: 'remove-member', teamChatToken: panel.dataset.teamChatToken, teamChatVersion: '4', userId: 'member' } }; await env.ui.handleAction(remove);
  assert.equal(env.state.rooms[0].members.length, 1); assert.equal(env.state.rooms[0].members[0].id, 'self'); assert.equal(env.state.rooms[0].version, 5);
});

// P2 (FRONTEND-V2 §2.3, §7.1, §8.3): Equipe in a drawer on every screen and the global badge.
function drawerDocument({ teamButton = true } = {}) {
  const dialogs = [];
  const dialog = () => {
    const element = { open: false, attributes: {}, listeners: {}, innerHTML: '', isConnected: false, root: null,
      setAttribute(name, value) { this.attributes[name] = value; }, getAttribute(name) { return this.attributes[name] ?? null; },
      addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn); }, contains: () => true,
      show() { this.open = true; }, showModal() { this.open = true; }, close() { this.open = false; for (const fn of this.listeners.close || []) fn({}); },
      querySelector(selector) {
        if (selector === '[data-team-chat]') return this.root ||= rootAdapter(this.innerHTML).root;
        if (selector === '.lv-drawer__close') return { focus() {} };
        if (selector === '[data-live-drawer-body]') return { querySelector: () => null, innerHTML: '' };
        return null;
      } };
    return element;
  };
  return { dialogs, body: { append(element) { element.isConnected = true; dialogs.push(element); } }, activeElement: null, createElement: () => dialog(), getElementById: () => null, querySelector: () => null,
    querySelectorAll: selector => selector === '[data-action="shell:team"]' && teamButton ? [{ closest: () => null }] : [] };
}
test('gaveta Equipe: abre em qualquer tela sem cabeçalho de página, conta como ativa e fecha ao trocar de empresa', async () => {
  const { liveCount } = await import('../public/live.js');
  const doc = drawerDocument(), state = { context: context({ active: false }), rooms: [room({ unreadCount: 2 }), room({ id: 'other', name: 'Outra', unreadCount: 3 })] }, calls = [];
  const ui = createTeamChatUI({ getContext: () => state.context, document: doc, openModal() {}, getModal: () => null,
    request: async (path, options) => { calls.push(path); if (path.endsWith('/rooms')) return { rooms: state.rooms.map(({ members, ...item }) => ({ ...item, memberCount: members.length })) }; return room(); } });
  assert.equal(ui.drawerOpen, false);
  assert.match(ui.render(), /team-chat-unavailable/, 'fora da tela e com a gaveta fechada, nada é carregado');
  assert.equal(ui.openDrawer({ isConnected: true }), true);
  assert.equal(ui.drawerOpen, true);
  const drawer = doc.dialogs[0];
  assert.equal(drawer.open, true); assert.equal(drawer.attributes['data-live-drawer'], 'team');
  assert.match(drawer.innerHTML, /data-team-chat-mode="drawer"/); assert.doesNotMatch(drawer.innerHTML, /team-chat-page-heading|<h1/, 'sem h1 de página dentro da gaveta');
  assert.match(drawer.innerHTML, /data-team-chat-action="create"/, 'Nova sala no cabeçalho da gaveta para quem gere');
  await tick(); await tick();
  assert.ok(calls.some(path => path.endsWith('/team-chat/rooms')), 'a gaveta carrega as salas');
  assert.equal(liveCount('team'), 5, 'o badge global soma as não lidas das salas');
  state.context = context({ active: false, tenantId: 'tenant-2' });
  ui.reset();
  assert.equal(ui.drawerOpen, false, 'outra empresa: a gaveta fecha'); assert.equal(drawer.open, false);
});
test('badge da Equipe: com a gaveta fechada lê as salas só onde o botão Equipe é oferecido', async () => {
  const { liveCount } = await import('../public/live.js');
  const calls = [], rooms = [room({ unreadCount: 4 })];
  const request = async path => { calls.push(path); return { rooms: rooms.map(({ members, ...item }) => ({ ...item, memberCount: members.length })) }; };
  const ui = createTeamChatUI({ getContext: () => context({ active: false }), document: drawerDocument(), request });
  assert.equal(await ui.pollBadge(), true); assert.equal(liveCount('team'), 4);
  assert.deepEqual(calls, ['/api/tenants/tenant/team-chat/rooms']);
  const hidden = createTeamChatUI({ getContext: () => context({ active: false }), document: drawerDocument({ teamButton: false }), request });
  assert.equal(await hidden.pollBadge(), false); assert.equal(liveCount('team'), null, 'sem o botão (suporte, sem acesso) nada é consultado');
  assert.equal(calls.length, 1);
});

test('logout (reset com clearDrafts) apaga também os rascunhos da caixa desta aba, mesmo sem store criado', async () => {
  const map = new Map([['elozi:draft:v1:self:workspace:tenant:c1', JSON.stringify({ text: 'Texto do cliente', mode: 'reply', updatedAt: Date.now() })], ['outra', 'mantida']]);
  globalThis.sessionStorage = { get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
  try {
    const env = setup();
    env.ui.reset();
    assert.equal(map.size, 2, 'troca de contexto não é logout');
    env.ui.reset({ clearDrafts: true });
    assert.deepEqual([...map.keys()], ['outra']);
  } finally { delete globalThis.sessionStorage; }
});
