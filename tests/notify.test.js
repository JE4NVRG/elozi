// Notifications (FRONTEND-V2 §5.1, §7.3, §8.3 P2): counters, title and favicon from "não lidas para
// mim"; sound and the Notification API only after opt-in, no preview by default, leader tab only,
// one per conversation every 10 s, silent outside "Disponível".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotify, titleWithCount, attentionEvents, readNotifyPrefs, saveNotifyPrefs } from '../public/notify.js';
import { createLiveRegistry, provideLiveContext, publishLiveCount } from '../public/live.js';

function memoryStorage() {
  const map = new Map();
  return { map, getItem: key => map.has(key) ? map.get(key) : null, setItem: (key, value) => map.set(key, String(value)), removeItem: key => map.delete(key) };
}
function fakeAttention(snapshot = { workspaceId: 'w1', unreadForMe: null }) {
  const listeners = new Set();
  return { current: snapshot, snapshot() { return this.current; }, pendingCount() { return this.pending ?? null; }, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    emit(next) { this.current = next; for (const fn of listeners) fn(next); }, register() {} };
}
function countNode(key) { return { key, textContent: '', hidden: true, getAttribute: name => name === 'data-shell-count' ? key : null }; }
function button(action, label) { const attrs = { 'data-action': action, 'aria-label': label }; return { attrs, hasAttribute: name => name in attrs, getAttribute: name => attrs[name] ?? null, setAttribute(name, value) { attrs[name] = value; } }; }
function fakeDocument({ presence = 'available', hidden = false } = {}) {
  const counts = ['inbox', 'pending', 'team', 'inbox'].map(countNode), bell = button('shell:pending', 'Pendências'), team = button('shell:team', 'Equipe');
  return {
    title: 'Atendimento · Acme', visibilityState: hidden ? 'hidden' : 'visible', counts, bell, team, head: null,
    querySelectorAll(selector) { if (selector === '[data-shell-count]') return counts; if (selector.startsWith('[data-action="shell:pending"]')) return [bell]; if (selector.startsWith('[data-action="shell:team"]')) return [team]; return []; },
    querySelector(selector) { return selector === '.sh-account [data-presence]' ? { getAttribute: () => presence } : null; },
    addEventListener() {}
  };
}
function fakeAudio() {
  const tones = [];
  class Audio {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; }
    resume() {}
    createOscillator() { return { frequency: {}, connect() {}, start: at => tones.push(at), stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  }
  return { Audio, tones };
}
function fakeNotification(permission = 'default') {
  const shown = [];
  class Notification { constructor(title, options) { Object.assign(this, { title, ...options, closed: false }); shown.push(this); } close() { this.closed = true; this.onclose?.(); } static permission = permission; static async requestPermission() { Notification.permission = 'granted'; return 'granted'; } }
  return { Notification, shown };
}
function setup({ presence, hidden, permission, storage = memoryStorage(), now = () => 50_000 } = {}) {
  const registry = createLiveRegistry(), attention = fakeAttention(), audio = fakeAudio(), notifier = fakeNotification(permission);
  provideLiveContext(() => ({ userId: 'u1', workspaceId: 'w1', view: 'overview' }), registry);
  const notify = createNotify({ attention, registry, storage, Notification: notifier.Notification, AudioContext: audio.Audio, window: { focus() {} }, now });
  const doc = fakeDocument({ presence, hidden });
  return { notify, attention, registry, audio, notifier, doc, storage };
}

test('título "(n) Tela · Marca" e contadores do menu, do sino e da Equipe patcheados no lugar; zero e desconhecido escondem', () => {
  assert.equal(titleWithCount('Atendimento · Acme', 3), '(3) Atendimento · Acme');
  assert.equal(titleWithCount('(3) Atendimento · Acme', 120), '(99+) Atendimento · Acme');
  assert.equal(titleWithCount('(3) Atendimento · Acme', 0), 'Atendimento · Acme');
  assert.equal(titleWithCount('Atendimento · Acme', null), 'Atendimento · Acme');
  const f = setup();
  assert.equal(f.notify.apply(), false, 'sem documento nada é patcheado');
  f.attention.current = { workspaceId: 'w1', unreadForMe: { total: 4 } }; f.attention.pending = 2;
  publishLiveCount('team', 1, f.registry);
  assert.equal(f.notify.apply(f.doc), true);
  assert.equal(f.doc.title, '(4) Atendimento · Acme');
  assert.deepEqual(f.doc.counts.map(node => [node.key, node.textContent, node.hidden]), [['inbox', '4', false], ['pending', '2', false], ['team', '1', false], ['inbox', '4', false]]);
  assert.equal(f.doc.bell.attrs['aria-label'], 'Pendências: 2'); assert.equal(f.doc.team.attrs['aria-label'], 'Equipe: 1 novas');
  f.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 0 } }); f.attention.pending = null; publishLiveCount('team', null, f.registry);
  assert.equal(f.doc.title, 'Atendimento · Acme');
  assert.ok(f.doc.counts.every(node => node.hidden && node.textContent === ''), 'zero ou desconhecido: sem número');
  assert.equal(f.doc.bell.attrs['aria-label'], 'Pendências');
});

test('sem opt-in não há som nem aviso; o evento perdido com a aba oculta oferece o opt-in', () => {
  const f = setup({ hidden: true, permission: 'default' });
  f.notify.apply(f.doc);
  assert.equal(f.notify.enabled(), false);
  f.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 1 } });
  f.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 2 } });
  assert.equal(f.audio.tones.length, 0); assert.equal(f.notifier.shown.length, 0);
  assert.deepEqual(readNotifyPrefs('u1', f.storage), { sound: false, desktop: false, preview: false, prompted: false });
});

test('após o opt-in: som e aviso só com a aba oculta, sem prévia, um por conversa a cada 10 s e mudo fora de Disponível', async () => {
  let now = 100_000;
  const f = setup({ hidden: true, permission: 'default', now: () => now });
  f.notify.apply(f.doc);
  const prefs = await f.notify.enable({ sound: true, desktop: true });
  assert.deepEqual(prefs, { sound: true, desktop: true, preview: false, prompted: true }, 'o gesto pede a permissão do navegador e destrava o áudio');
  f.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 1 } });
  f.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 2 } });
  assert.equal(f.audio.tones.length, 2, 'dois tons de 250 ms');
  assert.equal(f.notifier.shown.length, 1);
  assert.deepEqual({ title: f.notifier.shown[0].title, body: f.notifier.shown[0].body }, { title: 'Nova mensagem', body: 'Você tem 2 conversas não lidas.' }, 'sem prévia de cliente');
  assert.equal(f.notifier.shown[0].tag, 'elozi:w1:unread', 'tag por conversa (ou pela contagem)');
  f.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 3 } });
  assert.equal(f.notifier.shown.length, 1, 'no máximo um a cada 10 s');
  now += 10_001;
  const approval = { tenantId: 't1', conversationId: 'c9', runId: 'r1', agentName: 'Hermes' };
  f.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 3 }, approvals: [] });
  f.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 3 }, approvals: [approval] });
  assert.deepEqual(f.notifier.shown.at(-1).title, 'Aprovação pendente');
  assert.equal(f.notifier.shown.at(-1).body, 'Um agente aguarda sua decisão.', 'sem prévia: nem o nome do agente');
  saveNotifyPrefs('u1', { preview: true }, f.storage); now += 10_001;
  f.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 3 }, approvals: [approval, { ...approval, conversationId: 'c10', runId: 'r2' }] });
  assert.equal(f.notifier.shown.at(-1).body, 'Hermes aguarda sua decisão.', 'prévia opcional mostra só o nome do agente, nunca texto de cliente');
  const away = setup({ hidden: true, permission: 'granted', presence: 'away', storage: f.storage });
  away.notify.apply(away.doc); await away.notify.enable({ sound: true, desktop: true });
  away.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 1 } }); away.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 5 } });
  assert.equal(away.notifier.shown.length + away.audio.tones.length, 0, 'mudo fora de Disponível');
  const visible = setup({ hidden: false, permission: 'granted', storage: f.storage });
  provideLiveContext(() => ({ userId: 'u1', workspaceId: 'w1', view: 'inbox' }), visible.registry);
  visible.notify.apply(visible.doc);
  visible.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 1 } }); visible.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 2 } });
  assert.equal(visible.notifier.shown.length + visible.audio.tones.length, 0, 'aba visível na caixa: a lista já mostra');
});

test('só a aba líder toca e avisa', async () => {
  const f = setup({ hidden: true, permission: 'granted' });
  f.registry.live = { leader: false, state: () => ({ coordinated: true }) };
  f.notify.apply(f.doc); await f.notify.enable({ sound: true, desktop: true });
  f.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 1 } }); f.attention.emit({ workspaceId: 'w1', unreadForMe: { total: 2 } });
  assert.equal(f.notifier.shown.length + f.audio.tones.length, 0);
});

test('redução confirmada fecha só aviso genérico obsoleto e mantém aprovação e contadores restantes', async () => {
  let now = 50_000;
  const f = setup({ hidden: true, permission: 'granted', now: () => now });
  f.notify.apply(f.doc); await f.notify.enable({ sound: false, desktop: true });
  const snapshot = (total, approvals = []) => ({ source: 'attention', workspaceId: 'w1', unreadForMe: total === null ? null : { total }, approvals });
  f.attention.emit(snapshot(57)); f.attention.emit(snapshot(58));
  const message = f.notifier.shown[0]; assert.equal(message.closed, false);
  now += 10_001;
  const approval = { tenantId: 't1', conversationId: 'c9', runId: 'r1' };
  f.attention.emit(snapshot(58, [approval]));
  const approvalNotice = f.notifier.shown[1];
  f.attention.emit(snapshot(null, [approval]));
  assert.equal(message.closed, false, 'contagem indisponível não confirma leitura');
  f.attention.emit(snapshot(57, [approval]));
  assert.equal(message.closed, true); assert.equal(approvalNotice.closed, false);
  assert.equal(f.doc.title, '(57) Atendimento · Acme');
  assert.ok(f.doc.counts.filter(node => node.key === 'inbox').every(node => node.textContent === '57' && !node.hidden));
  assert.equal(f.notifier.shown.length, 2, 'reduzir não gera outro aviso');
});

test('snapshot de outro workspace não fecha aviso; mudança de sessão fecha só os genéricos próprios', async () => {
  let now = 50_000;
  const f = setup({ hidden: true, permission: 'granted', now: () => now });
  const context = { userId: 'u1', workspaceId: 'w1', view: 'overview' };
  provideLiveContext(() => context, f.registry);
  f.notify.apply(f.doc); await f.notify.enable({ sound: false, desktop: true });
  const snapshot = total => ({ source: 'attention', workspaceId: 'w1', unreadForMe: { total }, approvals: [] });
  f.attention.emit(snapshot(1)); f.attention.emit(snapshot(2));
  const message = f.notifier.shown[0];
  now += 10_001;
  f.attention.emit({ ...snapshot(2), approvals: [{ tenantId: 't1', conversationId: 'c9', runId: 'r1' }] });
  const approval = f.notifier.shown[1];
  f.attention.emit({ source: 'attention', workspaceId: 'w2', unreadForMe: { total: 0 } });
  assert.equal(message.closed, false); assert.equal(approval.closed, false);
  context.userId = 'u2'; f.notify.apply(f.doc);
  assert.equal(message.closed, true); assert.equal(approval.closed, false);
  const other = setup({ hidden: true, permission: 'granted' });
  other.notify.apply(other.doc); await other.notify.enable({ sound: false, desktop: true });
  other.attention.emit(snapshot(1)); other.attention.emit(snapshot(2));
  f.attention.emit(snapshot(0));
  assert.equal(other.notifier.shown[0].closed, false, 'uma instância não fecha notificações de outro usuário/aba');
});

test('eventos: só aumentos e aprovações novas; troca de workspace não dispara; preferências se mesclam', () => {
  assert.deepEqual(attentionEvents(null, { unreadForMe: { total: 3 } }), []);
  assert.deepEqual(attentionEvents({ unreadForMe: { total: 3 } }, { unreadForMe: { total: 1 } }), []);
  assert.deepEqual(attentionEvents({ workspaceId: 'a', unreadForMe: { total: 1 } }, { workspaceId: 'b', unreadForMe: { total: 9 } }), []);
  assert.deepEqual(attentionEvents({ unreadForMe: { total: 1 } }, { unreadForMe: { total: 2 } }).map(event => event.type), ['message']);
  const storage = memoryStorage();
  storage.setItem('elozi:prefs:u1', JSON.stringify({ theme: 'system', motion: 'reduced' }));
  assert.equal(saveNotifyPrefs('u1', { sound: true, other: true }, storage), true);
  assert.deepEqual(JSON.parse(storage.getItem('elozi:prefs:u1')), { theme: 'system', motion: 'reduced', notify: { sound: true, desktop: false, preview: false, prompted: false } });
});
