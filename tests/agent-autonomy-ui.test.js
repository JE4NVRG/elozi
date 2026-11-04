import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createAgentDetail } from '../public/agent-detail-ui.js';
import { serviceResponsePolicy } from '../src/service-response-policy.js';
import { parseHash } from '../public/router.js';
import { h, t, setLocale } from '../public/i18n.js';
import '../public/locales-management.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(capabilities = ['conversation.read', 'reply.send'], change = value => value) {
  const agent = { id: 'a1', name: 'Sofia', provider: 'mcp', mode: 'copilot', configured: true, version: 1 };
  const principal = { id: 'p1', name: 'Sofia Support', agentId: 'a1', state: 'active', active: true, revision: 2, keyRevision: 1, expiresAt: '2099-01-01T00:00:00Z', capabilities, channelIds: ['support'], usage: { requests: 0 }, conversationPolicy: { allowGroups: false, excludedChannelIds: ['personal'], customerMessagesAfter: '2026-10-24T14:58:00Z' } };
  const summary = { loaded: true, items: [structuredClone(principal)] }, calls = [];
  const state = { workspaceId: 'w1', boot: { session: { userId: 'u1', role: 'reseller' } }, tenant: { id: 't1', agents: [agent], channels: [], departments: [] } };
  const response = change({ principals: [structuredClone(principal)], responsePolicies: { p1: serviceResponsePolicy(principal, agent) } });
  const detail = createAgentDetail({ state, context: () => ({ admin: true, owner: false, features: new Set(), scope: 'w1:t1' }), principals: () => ({ summary }), request: async (path, options) => { calls.push({ path, options }); return response; } });
  const route = parseHash('#agents/a1/access');
  const main = { addEventListener() {}, querySelector() { return null; } };
  return { agent, principal, summary, state, response, calls, detail, view: () => String(detail.view(route)), async load() { detail.view(route); detail.mount(main, route); await settle(); } };
}

for (const [name, capabilities, mode, text] of [
  ['private direct send', ['conversation.read', 'reply.send'], 'autonomous', 'Pode responder sem revisão por mensagem'],
  ['draft only', ['conversation.read', 'reply.submit'], 'copilot', 'Rascunhos: envio humano'],
  ['read only', ['conversation.read'], 'read-only', 'Somente leitura'],
  ['group-only direct actions', ['conversation.read', 'message.schedule'], 'direct-actions', 'Ações diretas']
]) test(`actual Access renderer and GET callback: ${name}`, async () => {
  const f = fixture(capabilities, value => { if (mode === 'direct-actions') { value.principals[0].conversationPolicy.allowGroups = true; value.responsePolicies.p1 = serviceResponsePolicy(value.principals[0], { id: 'a1', provider: 'mcp', configured: true, mode: 'copilot' }); } return value; });
  assert.match(f.view(), /data-response-mode="unverified"/);
  await f.load(); const html = f.view();
  assert.match(html, new RegExp(`data-response-mode="${mode}"`)); assert.ok(html.includes(text));
  assert.match(html, /não comprova listener ativo nem mensagem entregue/);
  assert.equal(f.agent.mode, 'copilot'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].path, '/api/tenants/t1/service-principals'); assert.equal(f.calls[0].options, undefined);
  if (mode !== 'autonomous') assert.doesNotMatch(html, /Pode responder sem revisão por mensagem/);
});

test('policy denies groups despite grants: hides publishing tools, preserves private send and limits', async () => {
  const f = fixture(['conversation.read', 'reply.send', 'message.schedule']); await f.load(); const html = f.view();
  assert.match(html, /data-response-mode="autonomous"/); assert.match(html, /data-response-groups="blocked"/);
  assert.match(html, /Grupos bloqueados pela política/); assert.match(html, /elozi_send_reply/);
  assert.doesNotMatch(html, /<code[^>]*>elozi_(?:send_group_message|schedule_group_message)<\/code>/);
  assert.match(html, /os limites de resposta continuam valendo/);
  setLocale('en', { persist: false, notify: false });
  try { const en = f.view(); assert.match(en, /Autonomous · no per-message approval/); assert.match(en, /Groups blocked by conversation policy/); assert.doesNotMatch(en, /Autônomo|Grupos bloqueados/); }
  finally { setLocale('pt-BR', { persist: false, notify: false }); }
});

for (const [name, change] of [
  ['absent projection', value => { delete value.responsePolicies; }],
  ['unsupported version', value => { value.responsePolicies.p1.version = 1; }],
  ['contradictory effective mode', value => { value.responsePolicies.p1.effectiveMode = 'copilot'; }],
  ['human approval contradicts direct send', value => { value.responsePolicies.p1.humanApprovalRequired = true; }],
  ['assignment bypass', value => { value.responsePolicies.p1.privateReplies.requiresAgentAssignment = false; }],
  ['wrong principal', value => { value.principals[0].id = 'other'; }],
  ['wrong agent', value => { value.principals[0].agentId = 'other'; }],
  ['stale revision', value => { value.principals[0].revision++; }],
  ['stale key revision', value => { value.principals[0].keyRevision++; }],
  ['revoked principal', value => { value.principals[0].state = 'revoked'; }]
]) test(`fails closed: ${name}`, async () => {
  const f = fixture(undefined, value => { change(value); return value; }); await f.load();
  assert.match(f.view(), /data-response-mode="unverified"/); assert.doesNotMatch(f.view(), /data-response-mode="autonomous"/);
});

test('projection TTL, current identity/configuration, user switch and reset invalidate autonomy', async () => {
  const f = fixture(); await f.load(); assert.match(f.view(), /data-response-mode="autonomous"/);
  f.summary.items[0].state = 'paused'; assert.match(f.view(), /data-response-mode="unverified"/); f.summary.items[0].state = 'active';
  f.agent.version++; assert.match(f.view(), /data-response-mode="unverified"/); f.agent.version--;
  f.state.boot.session.userId = 'another'; assert.match(f.view(), /data-response-mode="unverified"/); f.state.boot.session.userId = 'u1';
  const original = Date.now; Date.now = () => original() + 31_000;
  try { assert.match(f.view(), /data-response-mode="unverified"/); } finally { Date.now = original; }
  f.detail.reset(); assert.match(f.view(), /data-response-mode="unverified"/);
});

test('connected inbox banner executes actual production function without claiming liveness, preserving pace/takeover/QA', () => {
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const fn = source.slice(source.indexOf('function connectedAgentBanner('), source.indexOf('function attendanceRoleText('));
  assert.ok(fn.startsWith('function connectedAgentBanner('));
  const context = { h, t, state: { boot: { session: { role: 'reseller' } } }, channelFor: () => ({}), replyPace: () => ({ mode: 'normal', hour: 3 }), Date };
  vm.createContext(context); vm.runInContext(fn, context);
  const html = String(context.connectedAgentBanner({ messages: [], conversationKind: 'private' }, { id: 'a1', name: 'Sofia' }, h`<button data-action="takeover">Assumir</button>`));
  assert.match(html, /Atendimento atribuído a Sofia/); assert.match(html, /atribuição não comprova resposta em execução/); assert.doesNotMatch(html, /está respondendo|is answering/);
  assert.match(html, /data-action="takeover"/); assert.match(html, /data-action="conversation-reply-exempt"/); assert.match(html, /3 respostas do agente na última hora/);
});
