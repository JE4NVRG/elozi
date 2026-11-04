import { randomUUID } from 'node:crypto';
import { fail, text } from './store.js';
import { validateFlowGraph } from './flows.js';

const fields = (input, allowed) => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'Informe somente os campos permitidos da proposta.'); };
const emptyGraph = () => ({ nodes: [{ id: 'start', type: 'start', config: {} }, { id: 'end', type: 'end', config: {} }], edges: [{ from: 'start', to: 'end' }] });
const clone = value => structuredClone(value);
const context = actor => ({ workspaceId: actor.workspaceId, tenantId: actor.tenantId, agentId: actor.agentId });
const scopedDepartments = (tenant, principal) => ({ departments: (tenant.departments || []).filter(item => item.active !== false && (principal.departmentIds === null || principal.departmentIds.includes(item.id))) });
const dto = proposal => ({ id: proposal.id, type: proposal.type, name: proposal.name, description: proposal.description,
  ...(proposal.type === 'flow' ? { graph: clone(proposal.graph) } : {}), state: proposal.state, version: proposal.version, serviceId: proposal.serviceId,
  createdAt: proposal.createdAt, updatedAt: proposal.updatedAt, decidedBy: proposal.decidedBy, decidedAt: proposal.decidedAt,
  entityId: proposal.entityId || null, humanApprovalRequired: true });

/** Company planning never authorizes live routing, sending, integrations or human administration. */
export class AgentAdminProposals {
  constructor(store, principals, { auth } = {}) {
    if (!auth?.admin || !auth?.resolveActor) throw new TypeError('Informe a autoridade humana para revisão das propostas.');
    this.store = store; this.principals = principals; this.auth = auth;
  }
  serviceActor(actor, authority) {
    return { kind: 'service', id: actor.principalId, serviceId: actor.principalId, role: 'operator', resellerId: actor.workspaceId,
      tenantIds: [actor.tenantId], name: authority.principal.name };
  }
  readCompany(actor, requestId) {
    const authority = this.principals.revalidate(actor, 'company.read', context(actor));
    const reserved = this.principals.reserve(actor, { requestId, capability: 'company.read', context: context(actor), units: 1, costMicros: 0, payload: null });
    if (!reserved.replayed) { this.principals.beginDispatch(actor, reserved.receipt.id); this.principals.complete(actor, reserved.receipt.id, { state: 'confirmed', result: { tenantId: actor.tenantId } }); }
    const tenant = this.store.tenant(this.serviceActor(actor, authority), actor.tenantId), principal = authority.principal;
    this.principals.revalidate(actor, 'company.read', context(actor));
    return { company: { id: tenant.id, name: tenant.name, segment: tenant.segment || '', identityVersion: tenant.identityVersion || 1 },
      channels: (tenant.channels || []).filter(channel => principal.channelIds === null || principal.channelIds.includes(channel.id)).map(({ id, name, kind, state }) => ({ id, name, kind, state })),
      departments: scopedDepartments(tenant, principal).departments.map(({ id, name }) => ({ id, name })),
      agents: (tenant.agents || []).map(({ id, name, provider, mode, configured, state, version }) => ({ id, name, provider, mode, configured: configured === true, state, version: version || 1 })),
      flows: (tenant.flows || []).map(({ id, name, state, version, publishedVersion }) => ({ id, name, state, version, publishedVersion: publishedVersion || null })),
      receipt: reserved.receipt.id, humanApprovalRequired: true };
  }
  proposalFor(actor, authority, receiptId) {
    return (this.store.tenant(this.serviceActor(actor, authority), actor.tenantId).agentAdminProposals || []).find(item => item.receiptId === receiptId && item.serviceId === actor.principalId);
  }
  propose(actor, input) {
    fields(input, ['requestId', 'type', 'name', 'description', 'graph']);
    if (!['flow', 'agent'].includes(input.type) || input.type === 'agent' && input.graph !== undefined) fail(400, 'Escolha uma proposta de fluxo ou agente conectado.');
    const authority = this.principals.revalidate(actor, 'company.propose', context(actor));
    this.principals.revalidate(actor, 'company.read', context(actor));
    const internal = this.serviceActor(actor, authority), tenant = this.store.tenant(internal, actor.tenantId);
    const normalized = { type: input.type, name: text(input.name, input.type === 'flow' ? 80 : 48),
      description: input.type === 'agent' ? text(input.description, 200) : input.description ? text(input.description, 500) : '' };
    if (input.type === 'flow') normalized.graph = validateFlowGraph(input.graph ?? emptyGraph(), scopedDepartments(tenant, authority.principal));
    const reserved = this.principals.reserve(actor, { requestId: input.requestId, capability: 'company.propose', context: context(actor), units: 1, costMicros: 0, payload: normalized });
    if (reserved.replayed) {
      const proposal = this.proposalFor(actor, authority, reserved.receipt.id);
      let receipt = reserved.receipt;
      if (proposal && ['dispatched', 'unknown'].includes(receipt.state)) receipt = this.principals.complete(actor, receipt.id, { state: 'confirmed', result: { proposal: { id: proposal.id, type: proposal.type } } });
      this.principals.revalidate(actor, 'company.propose', context(actor));
      return { proposal: proposal ? dto(proposal) : null, receipt, humanApprovalRequired: true };
    }
    const started = this.principals.beginDispatch(actor, reserved.receipt.id);
    if (!started.dispatched) return { receipt: started.receipt, proposal: null, humanApprovalRequired: true };
    try {
      const proposal = this.store.mutate(internal, actor.tenantId, 'Proposta de agente recebida para revisão humana', state => {
        this.principals.assertDispatchCurrent(actor, reserved.receipt.id);
        state.agentAdminProposals ??= [];
        if (state.agentAdminProposals.length >= 100) fail(400, 'Limite de propostas atingido.');
        const date = new Date().toISOString(), proposed = { id: randomUUID(), ...normalized, state: 'pending', version: 1,
          workspaceId: actor.workspaceId, tenantId: actor.tenantId, serviceId: actor.principalId, serviceRevision: actor.revision,
          serviceKeyRevision: actor.keyRevision, serviceAdapterHash: authority.adapterHash, receiptId: reserved.receipt.id,
          createdAt: date, updatedAt: date, decidedBy: null, decidedAt: null, entityId: null };
        state.agentAdminProposals.push(proposed); return clone(proposed);
      });
      const receipt = this.principals.complete(actor, reserved.receipt.id, { state: 'confirmed', result: { proposal: { id: proposal.id, type: proposal.type } } });
      this.principals.revalidate(actor, 'company.propose', context(actor));
      if (receipt.stale) fail(409, 'O acesso do serviço mudou durante a proposta.');
      return { proposal: dto(proposal), receipt, humanApprovalRequired: true };
    } catch (error) {
      // A proposal can already be durable if recording its receipt failed. Retain an uncertain outcome for reconciliation.
      if (this.principals.receipt(actor, reserved.receipt.id).state === 'dispatched') {
        const proposal = this.proposalFor(actor, authority, reserved.receipt.id);
        this.principals.complete(actor, reserved.receipt.id, { state: proposal ? 'unknown' : 'failed',
          ...(proposal ? { result: { proposal: { id: proposal.id, type: proposal.type } } } : {}), reason: proposal ? 'Proposta preservada; confirmação requer reconciliação.' : 'A proposta não foi registrada.' });
      }
      throw error;
    }
  }
  human(actor, tenantId) {
    if (!actor?.userId || actor.kind === 'service' || actor.serviceId) fail(403, 'Uma pessoa administradora precisa revisar a proposta.');
    this.auth.admin(actor);
    const current = this.auth.resolveActor(actor); this.auth.admin(current);
    this.store.tenant(current, tenantId);
    return current;
  }
  currentProposal(proposal, state) {
    if (proposal.workspaceId !== state.resellerId || proposal.tenantId !== state.id) fail(403, 'A proposta pertence a outra empresa.');
    const row = this.store.db.prepare('SELECT * FROM service_principals WHERE id=? AND reseller_id=? AND tenant_id=?').get(proposal.serviceId, state.resellerId, state.id);
    if (!row || !row.active || row.revoked_at !== null || row.expires_at <= this.principals.now()) fail(409, 'A identidade da proposta perdeu validade.');
    const principal = this.principals.metadata(row), adapter = this.principals.adapter(row);
    if (principal.revision !== proposal.serviceRevision || principal.keyRevision !== proposal.serviceKeyRevision || adapter.fingerprint !== proposal.serviceAdapterHash
      || !principal.capabilities.includes('company.read') || !principal.capabilities.includes('company.propose')) fail(409, 'As concessões da proposta mudaram. Solicite uma nova proposta.');
    return principal;
  }
  list(actor, tenantId) {
    const current = this.human(actor, tenantId), state = this.store.tenant(current, tenantId);
    return { proposals: (state.agentAdminProposals || []).map(proposal => {
      let canApprove = false; try { this.currentProposal(proposal, state); canApprove = proposal.state === 'pending'; } catch (error) { if (![400, 403, 404, 409].includes(error.status)) throw error; }
      const service = this.store.db.prepare('SELECT name FROM service_principals WHERE id=? AND reseller_id=? AND tenant_id=?').get(proposal.serviceId, state.resellerId, state.id);
      return { ...dto(proposal), serviceName: service?.name || 'Serviço indisponível', canApprove };
    }), humanApprovalRequired: true };
  }
  decide(actor, tenantId, id, input) {
    fields(input, ['version', 'action']);
    if (!Number.isSafeInteger(input.version) || input.version < 1 || !['approve', 'reject'].includes(input.action)) fail(400, 'Informe versão e decisão da proposta.');
    const current = this.human(actor, tenantId);
    return this.store.mutate(current, tenantId, 'Proposta de agente revisada por administrador', state => {
      this.human(current, tenantId);
      const proposal = (state.agentAdminProposals || []).find(item => item.id === id);
      if (!proposal) fail(404, 'Proposta não encontrada nesta empresa.');
      if (proposal.state !== 'pending' || proposal.version !== input.version) fail(409, 'A proposta já foi decidida ou mudou de versão.');
      if (proposal.workspaceId !== state.resellerId || proposal.tenantId !== state.id) fail(403, 'A proposta pertence a outra empresa.');
      let entity = null;
      const date = new Date().toISOString();
      if (input.action === 'approve') {
        const principal = this.currentProposal(proposal, state);
        if (proposal.type === 'flow') {
          state.flows ??= [];
          if (state.flows.length >= 100) fail(400, 'Limite de fluxos atingido.');
          entity = { id: randomUUID(), name: text(proposal.name, 80), description: proposal.description ? text(proposal.description, 500) : '', state: 'draft', version: 1,
            graph: validateFlowGraph(proposal.graph, scopedDepartments(state, principal)), versions: [], publishedVersion: null, createdAt: date, updatedAt: date };
          state.flows.push(entity);
        } else if (proposal.type === 'agent') {
          state.agents ??= [];
          if (state.agents.length >= 20) fail(400, 'Limite de agentes atingido.');
          entity = { id: randomUUID(), name: text(proposal.name, 48), description: text(proposal.description, 200), provider: 'mcp', mode: 'copilot', configured: true,
            state: 'awaiting_connection', version: 1, tools: ['conversation.read', 'reply.submit'] };
          state.agents.push(entity);
        } else fail(400, 'Tipo de proposta inválido.');
      }
      Object.assign(proposal, { state: input.action === 'approve' ? 'approved' : 'rejected', version: proposal.version + 1, decidedBy: current.userId, decidedAt: date, updatedAt: date, entityId: entity?.id || null });
      return { proposal: dto(proposal), entity: entity ? clone(entity) : null, humanApprovalRequired: true };
    });
  }
}
