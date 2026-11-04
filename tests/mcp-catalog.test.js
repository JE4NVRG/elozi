// MCP catalog of the panel (public/mcp-catalog.js, P6, FRONTEND-V2 §5.3.3 step 2 and §8.7): every elozi_*
// tool and capability is checked against the real server files, src/service-mcp.js and
// src/service-principals.js. A tool the server announces may be missing from it only while it is listed as
// planned, under a capability of its own (never an existing grant); as soon as the server defines it, the
// catalog must serve it (move it to MCP_CAPABILITY_TOOLS), so the panel never offers a tool the server lacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setLocale } from '../public/i18n.js';
import { SERVICE_CAPABILITIES } from '../src/service-principals.js';
import {
  MCP_ALWAYS_TOOLS, MCP_CAPABILITY_TOOLS, MCP_CAPABILITIES, REST_ONLY_CAPABILITIES, MCP_DIRECT_ACTIONS, MCP_PLANNED_TOOLS, MCP_PLANNED_CAPABILITIES,
  MCP_CAPABILITY_LABELS, MCP_TOOL_LABELS, toolsForCapabilities, plannedToolsForCapabilities, capabilityOfTool, isPlannedTool, acceptedCapabilities
} from '../public/mcp-catalog.js';

const server = readFileSync(new URL('../src/service-mcp.js', import.meta.url), 'utf8');
// [name, capability|null] of every tool definition of the server, in order (same reading as tests/frontend-seams.test.js).
const definitions = [...server.matchAll(/\{\s*name:\s*'(elozi_[a-z_]+)'([^}]*?)description:/g)].map(match => [match[1], /capability:\s*'([a-z.]+)'/.exec(match[2])?.[1] || null]);
const served = [...MCP_ALWAYS_TOOLS.map(name => [name, null]), ...MCP_CAPABILITIES.flatMap(capability => MCP_CAPABILITY_TOOLS[capability].map(name => [name, capability]))];

test('cada ferramenta do servidor está no catálogo servido, com a mesma capacidade e na mesma ordem', () => {
  assert.ok(definitions.length >= 15, 'definições lidas de src/service-mcp.js');
  const names = new Set(served.map(([name]) => name));
  for (const [name, capability] of definitions) {
    const planned = MCP_PLANNED_TOOLS.find(tool => tool.name === name);
    assert.ok(names.has(name), planned ? `${name} já existe no servidor: mova de MCP_PLANNED_TOOLS para MCP_CAPABILITY_TOOLS['${capability}']` : `${name} (${capability}) falta em public/mcp-catalog.js`);
    assert.equal(served.find(([tool]) => tool === name)[1], capability, `${name}: capacidade do servidor`);
  }
  assert.deepEqual(served.filter(([name]) => definitions.some(([tool]) => tool === name)), definitions, 'mesma ordem do servidor');
});

test('o catálogo servido nunca anuncia ferramenta ausente do servidor; planejada só com capacidade própria e nova', () => {
  const onServer = new Set(definitions.map(([name]) => name));
  for (const [name] of served) assert.ok(onServer.has(name), `${name} está no catálogo servido mas não em src/service-mcp.js`);
  for (const tool of MCP_PLANNED_TOOLS) {
    assert.match(tool.name, /^elozi_[a-z_]+$/); assert.match(tool.capability, /^[a-z]+\.[a-z]+$/);
    assert.equal(served.some(([name]) => name === tool.name), false, `${tool.name} não pode estar servida e planejada ao mesmo tempo`);
    assert.equal(isPlannedTool(tool.name), true);
    // An existing grant (reply.send, for instance) would extend to the new tool without a new consent.
    assert.equal(MCP_CAPABILITIES.includes(tool.capability) || SERVICE_CAPABILITIES.includes(tool.capability), false, `${tool.name}: capacidade própria, nunca ${tool.capability}`);
  }
  // Nothing announced and not served today: the attendant tools are served by src/service-mcp.js.
  assert.deepEqual(MCP_PLANNED_TOOLS, []); assert.deepEqual(MCP_PLANNED_CAPABILITIES, []);
});

test('capacidades: as servidas são as de src/service-principals.js; as planejadas só entram quando o servidor as aceita', () => {
  for (const capability of MCP_CAPABILITIES) assert.ok(SERVICE_CAPABILITIES.includes(capability), `${capability} servida sem existir no servidor`);
  for (const capability of SERVICE_CAPABILITIES) assert.ok(MCP_CAPABILITIES.includes(capability) || REST_ONLY_CAPABILITIES.includes(capability) || MCP_PLANNED_CAPABILITIES.includes(capability), `${capability} do servidor falta no catálogo`);
  assert.deepEqual(REST_ONLY_CAPABILITIES,['contact.read','notification.send','notification.read','notification.recipient.manage']);
  assert.deepEqual(toolsForCapabilities(REST_ONLY_CAPABILITIES),MCP_ALWAYS_TOOLS,'REST não anuncia ferramentas MCP inexistentes');
  assert.deepEqual(acceptedCapabilities(REST_ONLY_CAPABILITIES),[],'concessões de produto não entram no wizard de atendimento');
  for (const capability of MCP_PLANNED_CAPABILITIES) assert.equal(MCP_CAPABILITIES.includes(capability), false);
  assert.deepEqual(acceptedCapabilities(), [...MCP_CAPABILITIES], 'sem a lista do servidor, só o catálogo servido');
  assert.deepEqual(acceptedCapabilities([]), [...MCP_CAPABILITIES]);
  assert.deepEqual(acceptedCapabilities(['conversation.read', 'events.read', 'conversation.manage', 'admin.everything', 7]), ['conversation.read', 'events.read', 'conversation.manage'], 'nomes fora do catálogo são descartados, mesmo que o servidor os liste');
  assert.deepEqual(acceptedCapabilities(['conversation.read', 'reply.submit']), ['conversation.read', 'reply.submit'], 'um servidor anterior às capacidades de atendente não as recebe do painel');
  assert.deepEqual(MCP_DIRECT_ACTIONS, ['reply.send', 'message.schedule']);
});

test('ferramentas por capacidade, planejadas à parte e capacidade de cada ferramenta', () => {
  assert.deepEqual(toolsForCapabilities(), ['elozi_me', 'elozi_get_receipt']);
  assert.deepEqual(toolsForCapabilities(['company.propose', 'conversation.read']), ['elozi_me', 'elozi_get_receipt', ...MCP_CAPABILITY_TOOLS['conversation.read'], ...MCP_CAPABILITY_TOOLS['company.propose']]);
  assert.deepEqual(toolsForCapabilities(['admin.everything']), ['elozi_me', 'elozi_get_receipt'], 'capacidade desconhecida não libera ferramenta');
  assert.deepEqual(toolsForCapabilities(['events.read']), ['elozi_me', 'elozi_get_receipt', 'elozi_wait_for_events']);
  assert.deepEqual(plannedToolsForCapabilities(['conversation.read', 'reply.send', 'message.schedule']), [], 'um grant existente nunca libera ferramenta planejada');
  assert.equal(capabilityOfTool('elozi_send_group_message'), 'reply.send'); assert.equal(capabilityOfTool('elozi_me'), null); assert.equal(capabilityOfTool('outra'), null);
  assert.equal(isPlannedTool('elozi_me'), false); assert.equal(isPlannedTool('outra'), false); assert.equal(isPlannedTool('elozi_send_reply'), false);
  assert.equal(capabilityOfTool('elozi_send_reply'), 'reply.send'); assert.equal(capabilityOfTool('elozi_wait_for_events'), 'events.read'); assert.equal(capabilityOfTool('elozi_close_conversation'), 'conversation.manage');
  assert.deepEqual(toolsForCapabilities(['reply.send']), ['elozi_me', 'elozi_get_receipt', 'elozi_send_group_message', 'elozi_send_reply'], 'reply.send também responde nas conversas do agente');
});

test('rótulos sem marca do motor nem do produto, em PT e EN, para cada ferramenta e capacidade', () => {
  const tools = [...served.map(([name]) => name), ...MCP_PLANNED_TOOLS.map(tool => tool.name)];
  for (const language of ['pt-BR', 'en']) {
    setLocale(language, { persist: false, notify: false });
    try {
      for (const tool of tools) { assert.ok(MCP_TOOL_LABELS[tool], `${tool} sem rótulo`); assert.doesNotMatch(MCP_TOOL_LABELS[tool], /elozi|hermes/i, tool); }
      for (const capability of [...MCP_CAPABILITIES, ...MCP_PLANNED_CAPABILITIES]) { assert.ok(MCP_CAPABILITY_LABELS[capability], `${capability} sem rótulo`); assert.doesNotMatch(MCP_CAPABILITY_LABELS[capability], /elozi|hermes/i, capability); }
      // reply.send is never presented as a group-only grant: it also answers the agent's own conversations.
      assert.match(MCP_CAPABILITY_LABELS['reply.send'], language === 'en' ? /groups[\s\S]*conversations assigned to the agent/ : /grupos[\s\S]*conversas atribuídas ao agente/);
    } finally { setLocale('pt-BR', { persist: false, notify: false }); }
  }
  setLocale('en', { persist: false, notify: false });
  try { assert.equal(MCP_TOOL_LABELS.elozi_send_group_message, 'Sends text in an authorized group'); assert.equal(MCP_CAPABILITY_LABELS['company.propose'], 'Propose flows and agents for approval'); }
  finally { setLocale('pt-BR', { persist: false, notify: false }); }
});
