import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAgents } from '../scripts/validate-agents.mjs';

test('jornada reproduzível integra três serviços, runtime e MCP real sem rede ou envio', async () => {
  const result = await validateAgents();
  assert.equal(result.ok, true);
  assert.equal(result.model, 'deterministic-simulation');
  assert.deepEqual(result.profiles.map(profile => [profile.name, profile.state, profile.humanApprovalRequired]),
    [['Suporte', 'draft', true], ['Triagem', 'draft', true], ['Consulta', 'draft', true]]);
  assert.equal(result.profiles[1].stateBeforeApproval, 'waiting_approval');
  assert.equal(result.profiles[1].tool, 'elozi_attendance_status');
  assert.equal(result.profiles[1].toolReceipt, 'completed');
  // Default policy: the internal read-only lookup runs without a click; the draft still needs human review.
  assert.deepEqual(result.profiles[2], { name: 'Consulta', state: 'draft', tool: 'elozi_attendance_status', toolReceipt: 'completed', autoApproved: true, humanApprovalRequired: true });
  assert.deepEqual(result.mcp, { transport: 'SDK InMemoryTransport', discoveredTools: 5,
    callsBeforeApproval: 0, callsAfterApproval: 1, automaticLookups: 1, internalQueries: 2 });
  assert.deepEqual(result.replay, { receipts: 5, providerCalls: 5, sdkToolCalls: 2, requestsPerService: [1, 2, 2] });
  assert.deepEqual(result.handoff, { requested: 'pending', decided: 'acknowledged', requests: 1 });
  assert.deepEqual(result.denied, { missingBearer: 401, humanSessionAsBearer: 401, serviceAsHumanSession: 401,
    forgedPrincipal: 401, channel: 403, department: 403, company: 404, companyOverride: 403, capability: 403,
    duplicateHandoffDecision: 409, revokedBearer_support: 401, revokedActor_support: 401,
    revokedBearer_triage: 401, revokedActor_triage: 401, revokedBearer_lookup: 401, revokedActor_lookup: 401 });
  assert.deepEqual(result.revocation, { runs: 3, states: ['invalidated', 'invalidated', 'invalidated'], draftsCleared: true });
  assert.deepEqual(result.safety, { database: ':memory:', externalAttempts: 0, outboxCommands: 0,
    conversationsUnchanged: true, serviceCreatedHumanAccounts: 0, serviceCreatedHumanSessions: 0,
    privateReplayCleared: true });
  assert.deepEqual(result.cleanup, { storeClosed: true, activeRuns: 0 });
  const summary = JSON.stringify(result);
  assert.equal(summary.includes('elozi_svc_'), false);
  assert.equal(summary.includes('fixture-private'), false);
});
