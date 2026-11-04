import { randomUUID } from 'node:crypto';
import { fail, text } from './store.js';
import { channelReplyPolicy } from './service-reply-limits.js';
import { webhookUrl } from './service-webhooks.js';

/**
 * Connect a product (Plataforma › Produtos conectados): one idempotent call that creates, for a company and one of
 * its channels, the MCP copilot agent, the service identity scoped to that channel, the reply policy and, when asked,
 * the signed webhook (switched off until the product is ready). The progress is kept in the company
 * (state.productConnections, ids only), so a retry with the same requestId resumes without a second agent or key.
 * The key and a generated webhook secret are returned only by the call that created them; any other answer reports
 * keyLost or secretLost (the value never reached this screen) and the panel offers to rotate them.
 */
export const PRODUCT_CAPABILITIES = Object.freeze(['conversation.read', 'events.read', 'reply.send', 'conversation.manage', 'handoff.request']);
const KINDS = new Set(['assistant', 'attendance']);
const REQUEST_ID = /^[A-Za-z0-9_-]{8,120}$/;
const MAX_RECORDS = 50;

const fields = (input, allowed, label) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, `Informe ${label}.`);
  const extra = Object.keys(input).find(key => !allowed.includes(key));
  if (extra) fail(400, `Campo não aceito: ${extra}.`);
};

export class ProductConnections {
  constructor({ store, principals, webhooks, now = Date.now }) {
    this.store = store; this.principals = principals; this.webhooks = webhooks; this.now = now;
  }
  record(actor, tenantId, requestId) {
    return (this.store.tenant(actor, tenantId).productConnections || []).find(item => item.requestId === requestId) || null;
  }
  save(actor, tenantId, requestId, change) {
    return this.store.mutate(actor, tenantId, 'Conexão de produto', state => {
      const records = state.productConnections ??= [], found = records.find(item => item.requestId === requestId);
      if (!found) fail(409, 'A conexão mudou. Comece de novo.');
      change(found, state); found.updatedAt = new Date(this.now()).toISOString();
      return { ...found };
    });
  }
  validate(actor, input) {
    fields(input, ['requestId', 'tenantId', 'channelId', 'kind', 'agentName', 'capabilities', 'replyPolicy', 'webhook'], 'a conexão do produto');
    if (!REQUEST_ID.test(input.requestId || '')) fail(400, 'Use uma requestId de 8 a 120 caracteres com letras, números, _ ou -.');
    if (typeof input.tenantId !== 'string' || typeof input.channelId !== 'string') fail(400, 'Escolha a empresa e o canal do produto.');
    if (!KINDS.has(input.kind)) fail(400, 'Escolha assistente do produto ou atendimento.');
    const tenant = this.store.tenant(actor, input.tenantId), channel = (tenant.channels || []).find(item => item.id === input.channelId);
    if (!channel) fail(404, 'Canal não encontrado nesta empresa.');
    if (channel.enabled === false) fail(409, 'Este canal está desligado. Ligue o canal antes de conectar o produto.');
    const agentName = text(input.agentName, 48);
    const capabilities = input.capabilities === undefined ? [...PRODUCT_CAPABILITIES] : input.capabilities;
    if (!Array.isArray(capabilities) || !capabilities.length || capabilities.some(item => !PRODUCT_CAPABILITIES.includes(item)) || new Set(capabilities).size !== capabilities.length)
      fail(400, 'Escolha capacidades da lista do assistente de produto.');
    if (!capabilities.includes('conversation.read')) fail(400, 'Mantenha a leitura das conversas.');
    const replyPolicy = input.kind === 'assistant' ? channelReplyPolicy({ profile: 'assistant', ...(input.replyPolicy ?? {}) }) : (input.replyPolicy === undefined || input.replyPolicy === null ? null : fail(400, 'O atendimento usa o limite padrão; não envie replyPolicy.'));
    let webhook = null;
    if (input.webhook !== undefined && input.webhook !== null) {
      fields(input.webhook, ['url', 'secret'], 'o webhook');
      webhook = { url: webhookUrl(input.webhook.url), ...(input.webhook.secret !== undefined ? { secret: input.webhook.secret } : {}) };
    }
    return { tenant, channel, agentName, capabilities, replyPolicy, webhook };
  }
  async connect(actor, input) {
    const valid = this.validate(actor, input), { tenantId, channelId, requestId } = input;
    let record = this.record(actor, tenantId, requestId);
    if (record && (record.channelId !== channelId || record.kind !== input.kind)) fail(409, 'Esta requestId já foi usada para outra conexão.');
    if (record?.done) return this.result(actor, tenantId, record, { replay: true });
    if (!record) {
      record = this.store.mutate(actor, tenantId, 'Conexão de produto iniciada', state => {
        const records = state.productConnections ??= [];
        const existing = records.find(item => item.requestId === requestId);
        if (existing) return { ...existing };
        if (records.length >= MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS + 1);
        const date = new Date(this.now()).toISOString(), entry = { requestId, channelId, kind: input.kind, agentId: null, principalId: null, policyApplied: false, webhookConfigured: false, done: false, createdAt: date, updatedAt: date };
        records.push(entry);
        return { ...entry };
      });
    }
    // The agent and the record move together: a retry never creates a second agent.
    if (!record.agentId) record = this.save(actor, tenantId, requestId, (found, state) => {
      if (found.agentId) return;
      if ((state.agents || []).length >= 20) fail(400, 'Limite do sandbox atingido.');
      // Same shape as POST /agents for an MCP copilot.
      const agent = { id: randomUUID(), name: valid.agentName, provider: 'mcp', mode: 'copilot', state: 'awaiting_connection', configured: true, version: 1,
        description: `Agente do produto (${input.kind === 'assistant' ? 'assistente' : 'atendimento'}), conectado por MCP ou REST.`.slice(0, 200), tools: ['conversation.read', 'reply.submit'] };
      (state.agents ??= []).push(agent); found.agentId = agent.id;
    });
    let token = '';
    if (!record.principalId) {
      // An identity created for this agent whose answer was lost is adopted, never duplicated.
      const adopted = this.principals.list(actor, tenantId).principals.find(item => item.agentId === record.agentId && item.state !== 'revoked');
      let principalId = adopted?.id;
      if (!adopted) {
        const created = this.principals.create(actor, tenantId, { name: valid.agentName, agentId: record.agentId, capabilities: valid.capabilities, channelIds: [channelId], departmentIds: null,
          dailyRequests: input.kind === 'assistant' ? 5000 : 2000, maxConcurrent: 3, ttlHours: 2160, active: true });
        token = created.token; principalId = created.principal.id;
      }
      record = this.save(actor, tenantId, requestId, found => { found.principalId = principalId; });
    }
    if (!record.policyApplied) record = this.save(actor, tenantId, requestId, (found, state) => {
      const channel = (state.channels || []).find(item => item.id === channelId);
      if (!channel) fail(404, 'Canal não encontrado nesta empresa.');
      if (valid.replyPolicy) channel.replyPolicy = { ...valid.replyPolicy }; else delete channel.replyPolicy;
      found.policyApplied = true;
    });
    let secret = '';
    if (valid.webhook && !record.webhookConfigured) {
      const current = this.webhooks.row(record.principalId);
      const configured = await this.webhooks.configure(actor, tenantId, record.principalId, { url: valid.webhook.url, enabled: false, revision: current?.revision ?? 0,
        ...(valid.webhook.secret !== undefined ? { secret: valid.webhook.secret } : {}) });
      secret = configured.secret || '';
      record = this.save(actor, tenantId, requestId, found => { found.webhookConfigured = true; found.secretProvided = valid.webhook.secret !== undefined; });
    }
    record = this.save(actor, tenantId, requestId, found => { found.done = true; });
    return this.result(actor, tenantId, record, { replay: false, token, secret });
  }
  result(actor, tenantId, record, { replay, token = '', secret = '' }) {
    const tenant = this.store.tenant(actor, tenantId), agent = (tenant.agents || []).find(item => item.id === record.agentId);
    const principal = this.principals.list(actor, tenantId).principals.find(item => item.id === record.principalId) || null;
    const channel = (tenant.channels || []).find(item => item.id === record.channelId);
    return { replay, tenantId, channelId: record.channelId, kind: record.kind, agent: agent ? { id: agent.id, name: agent.name } : null, principal,
      token, keyLost: !token, webhook: principal ? this.webhooks.dto(this.webhooks.row(principal.id)) : { configured: false },
      secret, secretLost: !secret && record.webhookConfigured === true && record.secretProvided !== true,
      replyPolicy: channel?.replyPolicy?.profile === 'assistant' ? { ...channel.replyPolicy } : { profile: 'attendance' } };
  }
}
