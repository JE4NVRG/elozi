// Hash grammar of the panel (FRONTEND-V2 §2.4): public/router.js is pure, so the whole grammar is
// exercised here without DOM. App wiring (deep link, ?w=, guards) lives in route-deep-link.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHash, formatHash, registerAlias, aliasEntries, ROUTE_SECTIONS, ID_PATTERN } from '../public/router.js';
import '../public/nav-config.js';

const route = (section, params = {}, extra = {}) => ({ section, params, query: {}, workspaceId: null, alias: null, ...extra });

test('cada forma da gramática §2.4 é lida e reescrita na forma canônica, sem #/', () => {
  const cases = [
    ['#overview', route('overview')],
    ['#inbox', route('inbox')],
    ['#inbox/tenant-a/conversation-a', route('inbox', { tenantId: 'tenant-a', conversationId: 'conversation-a' })],
    ['#inbox/tenant-a/conversation-a?run=run-a', route('inbox', { tenantId: 'tenant-a', conversationId: 'conversation-a' }, { query: { run: 'run-a' } })],
    ['#inbox?lens=mine&kind=group&unread=1&tenant=tenant-a&channel=channel-a&q=Pedido+42', route('inbox', {}, { query: { lens: 'mine', kind: 'group', unread: '1', tenant: 'tenant-a', channel: 'channel-a', q: 'Pedido 42' } })],
    ['#contacts', route('contacts')], ['#contacts/tenant-a/contact-a', route('contacts', { tenantId: 'tenant-a', contactId: 'contact-a' })],
    ['#agents', route('agents')], ['#agents/knowledge', route('agents', { tab: 'knowledge' })], ['#agents/usage', route('agents', { tab: 'usage' })],
    ['#agents/agent-a', route('agents', { agentId: 'agent-a' })], ['#agents/agent-a/instructions', route('agents', { agentId: 'agent-a', agentTab: 'instructions' })],
    ['#agents/connect', route('agents', { tab: 'connect' })], ['#agents/connect/key', route('agents', { tab: 'connect', step: 'key' })],
    ['#pending', route('pending')], ['#pending/approval/run-a', route('pending', { type: 'approval', id: 'run-a' })],
    ['#automation', route('automation')], ['#automation/flows', route('automation', { tab: 'flows' })], ['#automation/flows/flow-a', route('automation', { tab: 'flows', id: 'flow-a' })],
    ['#channels', route('channels')], ['#channels/channel-a', route('channels', { channelId: 'channel-a' })], ['#channels/channel-a/groups', route('channels', { channelId: 'channel-a', tab: 'groups' })],
    ['#channels/new/telegram', route('channels', { kind: 'telegram' })], ['#channels/channel-a/test', route('channels', { channelId: 'channel-a', tab: 'test' })],
    ['#metrics', route('metrics')], ['#metrics/sla', route('metrics', { tab: 'sla' })], ['#accounts', route('accounts')], ['#accounts/account-a', route('accounts', { accountId: 'account-a' })],
    ['#settings/team', route('settings', { tab: 'team' })], ['#platform/health', route('platform', { tab: 'health' })],
    ['#account', route('account')], ['#help', route('help')], ['#help/apis', route('help', { topic: 'apis' })],
    ['#team-chat', route('team-chat')], ['#team-chat/room-a', route('team-chat', { roomId: 'room-a' })], ['#setup', route('setup')], ['#groups', route('groups')]
  ];
  for (const [hash, expected] of cases) {
    assert.deepEqual(parseHash(hash), expected, hash);
    assert.deepEqual(parseHash(hash.slice(1)), expected, 'sem # também: ' + hash);
    const formatted = formatHash(expected);
    assert.deepEqual(parseHash(formatted), expected, 'ida e volta: ' + hash);
    assert.ok(!formatted.startsWith('#/'), 'nunca #/: ' + formatted);
  }
  assert.equal(formatHash(route('inbox', {}, { query: { q: 'Pedido 42', lens: 'mine' } })), '#inbox?lens=mine&q=Pedido+42', 'ordem fixa dos filtros');
});

test('?w= vale em qualquer rota e IDs são codificados; nada fora da gramática vira rota', () => {
  assert.deepEqual(parseHash('#settings/brand?w=workspace-b'), route('settings', { tab: 'brand' }, { workspaceId: 'workspace-b' }));
  assert.equal(formatHash(route('inbox', { tenantId: 'tenant-a', conversationId: 'case@g.us' }, { workspaceId: 'workspace-b' })), '#inbox/tenant-a/case%40g.us?w=workspace-b');
  assert.deepEqual(parseHash('#inbox/tenant-a/case%40g.us').params, { tenantId: 'tenant-a', conversationId: 'case@g.us' });
  for (const hash of ['', '#', '#/', '#/inbox', '#/w/workspace-a/inbox', '#inbox/', '#inbox//c', '#inbox/tenant-a', '#inbox/a/b/c', '#overview/x',
    '#inbox/tenant%20a/case', '#inbox/%E0%A4%A/case', '#inbox/..%2F/case', '#agents/knowledge/x', '#agents/connect/token', '#agents/agent-a/secrets',
    '#pending/unknown/x', '#automation/rules/x/y', '#channels/new', '#metrics/revenue', '#settings/billing/x', '#platform/root', '#setup/x',
    '#guide-overview', '#desconhecido', '#account/x', '#inbox/<script>/x', '#' + 'a'.repeat(3000)]) assert.equal(parseHash(hash), null, JSON.stringify(hash).slice(0, 60));
  assert.deepEqual(parseHash('#inbox?lens=everything&kind=x&unread=yes&tenant=%3Cx%3E&q=' + 'a'.repeat(201) + '&w=bad%20id&extra=1'), route('inbox'), 'filtros inválidos são descartados');
  assert.deepEqual(parseHash('#overview?lens=mine&run=r'), route('overview'), 'filtros só valem onde a gramática os prevê');
  for (const bad of [route('inbox', { tenantId: 'tenant-a' }), route('inbox', { tenantId: 'tenant a', conversationId: 'c' }), route('agents', { tab: 'knowledge', agentId: 'agent-a' }),
    route('settings', { tab: 'unknown' }), route('automation', { id: 'flow-a' }), route('inbox', {}, { query: { lens: 'bogus' } }), route('overview', {}, { workspaceId: 'bad id' }), { section: 'nope' }])
    assert.throws(() => formatHash(bad), TypeError, JSON.stringify(bad));
  assert.ok(ID_PATTERN.test('3f2b8c1e-8d1c-4b7a-9a55-0b2e4b3c1d2e') && !ID_PATTERN.test('-x') && !ID_PATTERN.test('a/b'));
});

test('palavras reservadas de aba nunca colidem com IDs na mesma posição', () => {
  assert.deepEqual(parseHash('#agents/connect').params, { tab: 'connect' });
  assert.deepEqual(parseHash('#agents/tools').params, { tab: 'tools' });
  assert.deepEqual(parseHash('#agents/3f2b8c1e-8d1c-4b7a-9a55-0b2e4b3c1d2e/tools').params, { agentId: '3f2b8c1e-8d1c-4b7a-9a55-0b2e4b3c1d2e', agentTab: 'tools' });
  assert.deepEqual(parseHash('#channels/new/webchat').params, { kind: 'webchat' });
  assert.deepEqual(parseHash('#channels/new/groups').params, { kind: 'groups' }, 'depois de new vem sempre o tipo');
  assert.deepEqual(parseHash('#channels/channel-new/groups').params, { channelId: 'channel-new', tab: 'groups' });
});

test('aliases legados apontam para a rota nova, preservam a query e o último registro vence', () => {
  const legacy = Object.fromEntries(aliasEntries());
  assert.deepEqual(legacy, {
    'service-agents': '#agents/connect', knowledge: '#agents/knowledge', flows: '#automation/flows', architecture: '#platform/health',
    brand: '#settings/brand', tenants: '#settings/companies', team: '#settings/team', support: '#settings/support', billing: '#settings/billing',
    'platform-users': '#platform/users', 'platform-billing': '#platform/billing', integrations: '#platform/integrations', guide: '#help'
  });
  assert.deepEqual(parseHash('#knowledge?w=workspace-b'), route('agents', { tab: 'knowledge' }, { workspaceId: 'workspace-b', alias: 'knowledge' }));
  assert.equal(parseHash('#knowledge/x'), null, 'alias é só o hash legado de um segmento');
  // A later package repoints a legacy screen (P3: #groups → #inbox?kind=group). The registry is per
  // process (one test file), and this is the last use of #groups in this file.
  assert.deepEqual(parseHash('#groups'), route('groups'));
  registerAlias('groups', '#inbox?kind=group');
  assert.deepEqual(parseHash('#groups?w=workspace-a'), route('inbox', {}, { query: { kind: 'group' }, workspaceId: 'workspace-a', alias: 'groups' }));
  for (const [name, target] of [['inbox', '#overview'], ['overview', '#inbox'], ['Bad', '#inbox'], ['x/y', '#inbox'], ['valid-name', '#nope'], ['valid-name', '#/inbox']])
    assert.throws(() => registerAlias(name, target), TypeError, name + ' → ' + target);
  assert.ok(ROUTE_SECTIONS.includes('groups'));
});
