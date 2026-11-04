import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Outbox } from '../src/outbox.js';
import { ServicePrincipals } from '../src/service-principals.js';
import { ServiceApi } from '../src/service-api.js';
import { AgentRuntime } from '../src/agent-runtime.js';
import { McpManager } from '../src/mcp.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';

const privateNote = 'fixture-internal-note-not-for-agent';
const privateReasoning = 'fixture-private-model-reasoning';
const supportDraft = 'Posso ajudar com seu acesso. Qual etapa apresentou dificuldade?';
const triageDraft = 'Seu atendimento está aberto e uma pessoa da equipe pode revisar o caso.';
const lookupDraft = 'Seu atendimento está aberto. Vou acompanhar e responder em seguida.';
const lookedUp = messages => String(messages.at(-1)?.content).startsWith('Resultados de consultas');
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function idle(runtime) {
  const deadline = Date.now() + 3000;
  while (runtime.controllers.size) {
    assert.ok(Date.now() < deadline, 'A execução sintética não encerrou no prazo.');
    await pause(1);
  }
}

/** Real service/runtime/MCP contracts; the LLM is explicitly simulated, with no network. */
export async function validateAgents() {
  const store = new Store(':memory:');
  let runtime, result;
  try {
    const auth = new Auth(store.db, { validateTenant: (actor, id) => store.tenant(actor, id) });
    new Outbox(store); // Observe the real outbox table; no gateway or sender exists here.
    const adminRow = auth.insertUser({ username: 'agents.fixture.admin', name: 'Admin sintético' },
      Buffer.alloc(16, 1), Buffer.alloc(64, 1), 'reseller', [], 'mep-demo');
    const admin = auth.actor(adminRow);
    const company = store.createTenant(admin, { name: 'Agentes em RAM', segment: 'Validação sintética' });
    const otherCompany = store.createTenant(admin, { name: 'Outra empresa em RAM', segment: 'Escopo sintético' });
    const humanRow = auth.insertUser({ username: 'agents.fixture.human', name: 'Atendente sintético' },
      Buffer.alloc(16, 2), Buffer.alloc(64, 2), 'operator', [company.id], 'mep-demo');
    const humanSession = auth.session(humanRow);
    const human = auth.authenticate(humanSession.token);
    const conversation = (id, channelId, departmentId, messages = []) => ({ id, contact: 'Pessoa sintética',
      version: 1, channelId, departmentId, status: 'open', owner: 'human', agentId: null,
      assignedUserId: human.userId, participants: [], messages });
    const agent = (id, name, extra = {}) => ({ id, name, provider: 'hermes', mode: 'copilot', configured: true,
      version: 1, description: 'Prepare somente um rascunho para revisão humana.', tools: [], ...extra });
    store.mutate(admin, company.id, 'Fixture local: agentes e atendimentos', state => {
      // Triagem keeps the explicit human approval journey; Consulta uses the default automatic read-only policy.
      state.agents = [agent('support', 'Suporte'), agent('triage', 'Triagem', { toolPolicy: 'approve_all' }), agent('lookup', 'Consulta')];
      state.channels = [{ id: 'support-channel', name: 'Canal Suporte sintético', kind: 'webchat', state: 'planned' },
        { id: 'triage-channel', name: 'Canal Triagem sintético', kind: 'webchat', state: 'planned' },
        { id: 'lookup-channel', name: 'Canal Consulta sintético', kind: 'webchat', state: 'planned' }];
      state.departments = [{ id: 'support-dept', name: 'Suporte', active: true },
        { id: 'triage-dept', name: 'Triagem', active: true }, { id: 'lookup-dept', name: 'Consulta', active: true }];
      state.conversations = [conversation('support-conversation', 'support-channel', 'support-dept', [
        { id: 'customer-fixture', kind: 'customer', text: 'Preciso de ajuda com o acesso.', attachments: [
          { id: 'attachment-fixture', kind: 'image', name: 'fixture.png', mime: 'image/png', size: 4,
            url: 'https://fixture.invalid/private-attachment', preview: 'fixture-private-attachment' }
        ] },
        { id: 'note-fixture', kind: 'internal', text: privateNote }
      ]), conversation('triage-conversation', 'triage-channel', 'triage-dept', [
        { id: 'triage-customer-fixture', kind: 'customer', text: 'Preciso falar com uma pessoa da equipe.' }
      ]), conversation('lookup-conversation', 'lookup-channel', 'lookup-dept', [
        { id: 'lookup-customer-fixture', kind: 'customer', text: 'Meu atendimento ainda está aberto?' }
      ]), conversation('blocked-department', 'support-channel', 'triage-dept')];
      state.runs = [];
    });
    store.mutate(admin, otherCompany.id, 'Fixture local: empresa fora do escopo', state => {
      state.conversations = [conversation('foreign-conversation', 'foreign-channel', 'foreign-dept')];
    });
    const current = () => store.tenant(admin, company.id);
    const conversationsBefore = hash(current().conversations);
    const identitiesBefore = {
      users: store.db.prepare('SELECT count(*) n FROM auth_users').get().n,
      sessions: store.db.prepare('SELECT count(*) n FROM auth_sessions').get().n
    };
    const counters = { providerCalls: 0, sdkClients: 0, sdkToolCalls: 0, internalQueries: 0, externalAttempts: 0, serviceQueries: 0 };
    const providerRequests = [];
    const vault = encryptedChannelSecrets(store.db, randomBytes(32));
    const mcp = new McpManager(store, { vault: () => vault,
      fetchImpl: () => { counters.externalAttempts++; throw new Error('Transporte externo bloqueado na fixture.'); },
      internalContext(actor, tenantId, conversationId, request) {
        assert.equal(tenantId, company.id);
        if (actor.serviceId) {
          // An automatic lookup started by a service is authorized by that exact, current principal.
          const run = store.tenant(admin, tenantId).runs.find(item => item.id === request.runId);
          assert.ok(run?.serviceId === actor.serviceId && principals.runCurrent(run), 'A consulta automática exige o serviço vigente da execução.');
          counters.serviceQueries++;
        } else assert.equal(actor.userId, human.userId, 'Somente a aprovação humana consulta a ferramenta.');
        const selected = store.getConversation(store.tenant(actor, tenantId), conversationId);
        counters.internalQueries++;
        return { channel: { id: selected.channelId, connected: false },
          attendance: { status: selected.status, responsible: selected.assignedUserId, departmentId: selected.departmentId } };
      }
    });
    // Count the real SDK call without replacing its transport, handlers or response.
    const withClient = mcp.withClient.bind(mcp);
    mcp.withClient = (actor, tenantId, server, options, action) => {
      counters.sdkClients++;
      return withClient(actor, tenantId, server, options, client => action(new Proxy(client, {
        get(target, key) {
          if (key === 'callTool') return (...args) => { counters.sdkToolCalls++; return target.callTool(...args); };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        }
      })));
    };
    const configured = mcp.create(admin, company.id, { name: 'MCP interno sintético', kind: 'internal', enabled: true });
    const discovered = await mcp.discover(admin, company.id, configured.id, { version: configured.version });
    const tool = discovered.tools.find(item => item.name === 'elozi_attendance_status');
    assert.ok(tool, 'O SDK deve descobrir a ferramenta interna real.');
    for (const agentId of ['triage', 'lookup']) mcp.setGrants(admin, company.id, agentId, { version: 1, grants: [{ serverId: discovered.id,
      serverVersion: discovered.version, toolName: tool.name, toolHash: tool.hash }] });
    const principals = new ServicePrincipals(store, auth, {
      onChange: serviceId => runtime?.invalidateInitiator(admin, company.id, { serviceId })
    });
    runtime = new AgentRuntime(store, { mcp, validateInitiator: run => !run.serviceId || principals.runCurrent(run),
      providerCall: async context => {
        counters.providerCalls++;
        providerRequests.push(structuredClone({ agentId: context.agentId, messages: context.messages, tools: context.tools }));
        if (context.agentId === 'support') return { text: supportDraft };
        if (context.agentId === 'lookup') {
          if (!lookedUp(context.messages)) {
            const name = context.tools[0].function.name, id = 'synthetic_automatic_query';
            return { toolCall: { id, name, arguments: {} }, assistant: { role: 'assistant', content: null,
              tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }], reasoning_content: privateReasoning } };
          }
          const result = JSON.parse(context.messages.at(-1).content.split('\n').slice(1).join('\n'))[0];
          assert.equal(result.isError, false); assert.equal(result.data.status, 'open');
          return { text: lookupDraft };
        }
        assert.equal(context.agentId, 'triage');
        if (context.tools.length) {
          const name = context.tools[0].function.name, id = 'synthetic_attendance_query';
          return { toolCall: { id, name, arguments: {} }, assistant: { role: 'assistant', content: null,
            tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }], reasoning_content: privateReasoning } };
        }
        const response = context.messages.find(item => item.role === 'tool');
        assert.ok(response, 'A continuação exige uma resposta real da ferramenta MCP.');
        const toolResult = JSON.parse(response.content);
        assert.equal(toolResult.isError, false);
        assert.equal(toolResult.structuredContent.status, 'open');
        assert.equal(toolResult.structuredContent.responsible, human.userId);
        return { text: triageDraft };
      }
    });
    const api = new ServiceApi(store, principals, runtime);
    const service = (agentId, channelId, departmentId, capabilities) => {
      const created = principals.create(admin, company.id, { name: `Serviço sintético ${agentId}`, agentId,
        channelIds: [channelId], departmentIds: [departmentId], capabilities, dailyRequests: 20,
        maxConcurrent: 1, dailyBudgetMicros: 0, estimatedRequestMicros: 0, ttlHours: 1 });
      return { ...created, actor: principals.authenticate(`Bearer ${created.token}`) };
    };
    const support = service('support', 'support-channel', 'support-dept', ['conversation.read', 'reply.draft']);
    const triage = service('triage', 'triage-channel', 'triage-dept', ['conversation.read', 'reply.draft', 'handoff.request']);
    const lookup = service('lookup', 'lookup-channel', 'lookup-dept', ['conversation.read', 'reply.draft']);
    const blocked = {};
    const deny = (name, expected, action) => {
      let status;
      try { action(); } catch (error) { status = error.status; }
      assert.equal(status, expected, `O controle ${name} deve recusar a ação.`);
      blocked[name] = status;
    };
    deny('missingBearer', 401, () => principals.authenticate(undefined));
    deny('humanSessionAsBearer', 401, () => principals.authenticate(`Bearer ${humanSession.token}`));
    deny('serviceAsHumanSession', 401, () => auth.authenticate(support.token));
    deny('forgedPrincipal', 401, () => api.read({ ...support.actor }, 'support-conversation', 'fixture_forged_read'));
    deny('channel', 403, () => api.read(support.actor, 'triage-conversation', 'fixture_blocked_channel'));
    deny('department', 403, () => api.read(support.actor, 'blocked-department', 'fixture_blocked_department'));
    deny('company', 404, () => api.read(support.actor, 'foreign-conversation', 'fixture_blocked_company'));
    deny('companyOverride', 403, () => principals.revalidate(support.actor, 'conversation.read', { tenantId: otherCompany.id }));
    deny('capability', 403, () => api.handoff(support.actor, { requestId: 'fixture_blocked_handoff',
      conversationId: 'support-conversation', version: 1, reason: 'Capacidade ausente.' }));

    const read = api.read(support.actor, 'support-conversation', 'fixture_support_read');
    const readReplay = api.read(support.actor, 'support-conversation', 'fixture_support_read');
    assert.equal(readReplay.receipt, read.receipt);
    assert.deepEqual(read.conversation.messages.map(item => item.id), ['customer-fixture']);
    assert.deepEqual(read.conversation.messages[0].attachments, [{ id: 'attachment-fixture', kind: 'image',
      name: 'fixture.png', mime: 'image/png', size: 4 }]);
    for (const marker of [privateNote, 'fixture.invalid', 'fixture-private-attachment']) {
      assert.equal(JSON.stringify(read).includes(marker), false, 'A leitura deve preservar dados privados.');
    }
    const supportInput = { requestId: 'fixture_support_draft', conversationId: 'support-conversation', version: 1 };
    const supportResult = await api.draft(support.actor, supportInput);
    assert.equal(supportResult.run.state, 'draft');
    assert.equal(supportResult.run.draft, supportDraft);
    assert.equal(supportResult.humanApprovalRequired, true);
    assert.equal(supportResult.receipt.state, 'confirmed');
    const callsBeforeReplay = counters.providerCalls;
    const supportReplay = await api.draft(support.actor, supportInput);
    assert.equal(supportReplay.run.id, supportResult.run.id);
    assert.equal(supportReplay.receipt.id, supportResult.receipt.id);
    assert.equal(counters.providerCalls, callsBeforeReplay);
    assert.equal(providerRequests[0].messages.some(item => item.content.includes(privateNote)), false);

    const triageInput = { requestId: 'fixture_triage_draft', conversationId: 'triage-conversation', version: 1 };
    const triageResult = await api.draft(triage.actor, triageInput);
    assert.equal(triageResult.run.state, 'waiting_approval');
    const proposal = runtime.list(human, company.id, 'triage-conversation').find(item => item.id === triageResult.run.id);
    assert.equal(proposal.toolProposal.toolName, 'elozi_attendance_status');
    assert.equal(proposal.toolProposal.readOnly, true);
    assert.equal(counters.sdkToolCalls, 0, 'Nenhuma consulta deve ocorrer antes da aprovação.');
    const toolCallsBeforeApproval = counters.sdkToolCalls;
    const approval = { version: proposal.version, proposalId: proposal.toolProposal.id };
    runtime.approveTool(human, company.id, proposal.id, approval);
    await idle(runtime);
    const completed = runtime.list(human, company.id, 'triage-conversation').find(item => item.id === proposal.id);
    assert.equal(completed.state, 'draft');
    assert.equal(completed.draft, triageDraft);
    assert.equal(completed.toolReceipt.state, 'completed');
    assert.equal(completed.toolReceipt.approvedUserId, human.userId);
    assert.equal(counters.sdkToolCalls, 1);
    assert.equal(counters.internalQueries, 1);
    const callsAfterApproval = counters.providerCalls;
    runtime.approveTool(human, company.id, proposal.id, approval);
    const triageReplay = await api.draft(triage.actor, triageInput);
    assert.equal(triageReplay.run.draft, triageDraft);
    assert.equal(triageReplay.receipt.id, triageResult.receipt.id);
    assert.equal(counters.providerCalls, callsAfterApproval);
    assert.equal(counters.sdkToolCalls, 1, 'Repetir aprovação não pode repetir a ferramenta.');
    assert.deepEqual(vault.get(`mcp-run:${company.id}:${proposal.id}`), {});

    const lookupInput = { requestId: 'fixture_lookup_draft', conversationId: 'lookup-conversation', version: 1 };
    const lookupResult = await api.draft(lookup.actor, lookupInput);
    assert.equal(lookupResult.run.state, 'draft');
    assert.equal(lookupResult.run.draft, lookupDraft);
    assert.equal(lookupResult.receipt.state, 'confirmed');
    const automatic = runtime.list(human, company.id, 'lookup-conversation').find(item => item.id === lookupResult.run.id);
    assert.equal(automatic.toolReceipt.autoApproved, true);
    assert.equal(automatic.toolReceipt.approvedUserId, null);
    assert.equal(automatic.toolReceipt.state, 'completed');
    assert.equal(counters.sdkToolCalls, 2, 'A consulta automática executa uma vez, sem clique humano.');
    assert.equal(counters.serviceQueries, 1);
    assert.deepEqual(vault.get(`mcp-run:${company.id}:${automatic.id}`), {});

    const handoffInput = { requestId: 'fixture_triage_handoff', conversationId: 'triage-conversation',
      version: 1, reason: 'Revisão humana solicitada na fixture.' };
    const handoff = api.handoff(triage.actor, handoffInput), handoffReplay = api.handoff(triage.actor, handoffInput);
    assert.equal(handoff.request.state, 'pending');
    assert.equal(handoffReplay.request.id, handoff.request.id);
    const decision = api.decide(human, company.id, 'triage-conversation', handoff.request.id,
      { version: handoff.request.version, action: 'acknowledge', reason: 'Revisão humana sintética aceita.' });
    assert.equal(decision.request.state, 'acknowledged');
    assert.equal(decision.request.decidedBy, human.userId);
    deny('duplicateHandoffDecision', 409, () => api.decide(human, company.id, 'triage-conversation', handoff.request.id,
      { version: 1, action: 'acknowledge', reason: 'Não deve decidir novamente.' }));
    assert.equal(store.db.prepare('SELECT count(*) n FROM service_handoff_requests').get().n, 1);
    const receiptCount = store.db.prepare('SELECT count(*) n FROM service_principal_receipts').get().n;
    assert.equal(receiptCount, 5, 'Leitura, três rascunhos e apoio devem produzir somente cinco recibos.');
    const usage = principals.list(admin, company.id).principals;
    assert.deepEqual(usage.map(item => item.usage.requests).sort(), [1, 2, 2]);
    for (const profile of [support, triage, lookup]) {
      principals.revoke(admin, company.id, profile.principal.id, { revision: 1 });
      deny(`revokedBearer_${profile.principal.agentId}`, 401, () => principals.authenticate(`Bearer ${profile.token}`));
      deny(`revokedActor_${profile.principal.agentId}`, 401, () => api.read(profile.actor,
        `${profile.principal.agentId}-conversation`, 'fixture_revoked_read'));
    }
    const revokedRuns = runtime.list(human, company.id).filter(item => item.serviceId);
    assert.deepEqual(revokedRuns.map(item => item.state), ['invalidated', 'invalidated', 'invalidated']);
    assert.ok(revokedRuns.every(item => item.draft === null));
    const outboxCount = store.db.prepare('SELECT count(*) n FROM outbound_commands').get().n;
    assert.equal(outboxCount, 0);
    assert.equal(hash(current().conversations), conversationsBefore, 'A jornada não deve enviar ou transferir atendimentos.');
    assert.equal(store.db.prepare('SELECT count(*) n FROM auth_users').get().n, identitiesBefore.users);
    assert.equal(store.db.prepare('SELECT count(*) n FROM auth_sessions').get().n, identitiesBefore.sessions);
    assert.equal(counters.externalAttempts, 0);
    const visible = JSON.stringify({ runs: revokedRuns, receipts: principals.receipts(admin, company.id, triage.principal.id) });
    for (const marker of [privateReasoning, support.token, triage.token, lookup.token, humanSession.token]) assert.equal(visible.includes(marker), false);

    result = { ok: true, mode: 'synthetic-in-memory', model: 'deterministic-simulation',
      profiles: [{ name: 'Suporte', state: supportResult.run.state, humanApprovalRequired: supportResult.humanApprovalRequired },
        { name: 'Triagem', stateBeforeApproval: triageResult.run.state, state: completed.state,
          tool: completed.toolProposal.toolName, toolReceipt: completed.toolReceipt.state,
          humanApprovalRequired: triageReplay.humanApprovalRequired },
        { name: 'Consulta', state: lookupResult.run.state, tool: automatic.toolProposal.toolName, toolReceipt: automatic.toolReceipt.state,
          autoApproved: automatic.toolReceipt.autoApproved, humanApprovalRequired: lookupResult.humanApprovalRequired }],
      mcp: { transport: 'SDK InMemoryTransport', discoveredTools: discovered.tools.length,
        callsBeforeApproval: toolCallsBeforeApproval, callsAfterApproval: counters.sdkToolCalls - counters.serviceQueries,
        automaticLookups: counters.serviceQueries, internalQueries: counters.internalQueries },
      handoff: { requested: handoff.request.state, decided: decision.request.state, requests: 1 },
      replay: { receipts: receiptCount, providerCalls: counters.providerCalls,
        sdkToolCalls: counters.sdkToolCalls, requestsPerService: usage.map(item => item.usage.requests).sort() },
      denied: blocked,
      revocation: { runs: revokedRuns.length, states: revokedRuns.map(item => item.state), draftsCleared: true },
      safety: { database: ':memory:', externalAttempts: counters.externalAttempts, outboxCommands: outboxCount,
        conversationsUnchanged: hash(current().conversations) === conversationsBefore,
        serviceCreatedHumanAccounts: 0, serviceCreatedHumanSessions: 0, privateReplayCleared: true } };
    for (const marker of [privateReasoning, privateNote, support.token, triage.token, lookup.token, humanSession.token]) {
      assert.equal(JSON.stringify(result).includes(marker), false, 'O resumo não deve expor dados privados.');
    }
  } finally {
    try {
      if (runtime) {
        for (const controller of runtime.controllers.values()) controller.abort();
        await idle(runtime);
      }
    } finally {
      store.close();
    }
  }
  return { ...result, cleanup: { storeClosed: true, activeRuns: runtime.controllers.size } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await validateAgents(), null, 2)); }
  catch {
    console.error(JSON.stringify({ ok: false, mode: 'synthetic-in-memory', error: 'A validação dos agentes falhou.' }));
    process.exitCode = 1;
  }
}
