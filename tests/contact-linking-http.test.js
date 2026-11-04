import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/server.js';
import { syncConversationContact } from '../src/contacts.js';

async function fixture(t) {
  const key = randomBytes(32), external = [], deny = async () => { external.push(true); throw Error('Transporte proibido no teste RAM.'); };
  const app = createApp({ databasePath: ':memory:', publicOrigin: '', allowRegistration: false, serviceKey: key,
    providerCall: deny, mcpFetchImpl: deny, googleOptions: { clientId: '', jwks: deny },
    gatewayOptions: { authKey: key, socketFactory: deny, downloadMediaImpl: deny },
    telegramOptions: { authKey: key, polling: false, fetchImpl: deny }, metaOptions: { fetchImpl: deny, mediaDownloader: deny },
    emailOptions: { key, apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny },
    mediaOptions: { directory: null, authKey: key } });
  t.after(async () => {
    await app.scheduled.waitIdle(); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    await Promise.all([app.gateway.close(), app.telegram.close(), app.meta.close(), app.email.close(), app.emailChannel.close(), app.webchat.close(), app.bridge.close()]);
    app.store.close(); assert.deepEqual(external, []);
  });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (path, { method = 'GET', body, cookie = '' } = {}) => {
    const response = await fetch(base + path, { method, headers: { Origin: base, Cookie: cookie, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text(), type = response.headers.get('content-type') || '';
    return { status: response.status, text, type, data: type.includes('application/json') ? JSON.parse(text) : null,
      cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = await request('/api/auth/setup', { method: 'POST', body: { name: 'Fusão HTTP RAM', username: 'link-owner', password: 'Synthetic-' + randomBytes(16).toString('hex') } });
  assert.equal(owner.status, 200);
  const ownerRequest = (path, options = {}) => request(path, { ...options, cookie: owner.cookie });
  const company = await ownerRequest('/api/tenants', { method: 'POST', body: { name: 'Fusão HTTP RAM', segment: 'QA' } });
  assert.equal(company.status, 201); const tenantId = company.data.id, basePath = `/api/tenants/${tenantId}`;
  const admin = app.auth.resolveActor(app.auth.authenticate(owner.cookie.slice('mep_session='.length)));
  let sourceId, targetId;
  app.store.mutate(admin, tenantId, 'Fixture HTTP RAM de vínculos', state => {
    state.channels = [{ id: 'web-a', kind: 'webchat', transport: 'elozi-webchat' }, { id: 'web-b', kind: 'webchat', transport: 'elozi-webchat' }];
    state.departments = [{ id: 'support', name: 'Suporte' }, { id: 'sales', name: 'Comercial' }];
    state.contacts = []; state.conversations = [];
    for (const [id, channelId, departmentId] of [['source', 'web-a', 'support'], ['target', 'web-b', 'sales']]) {
      const conversation = { id, channelId, departmentId, contact: 'Contato ' + id, conversationKind: 'direct', status: 'open', owner: 'queue',
        version: 1, messages: [{ id: id + '-message', kind: 'customer', text: 'TEXTO PRIVADO RAM' }] };
      state.conversations.push(conversation); const contact = syncConversationContact(state, conversation, state.channels.find(channel => channel.id === channelId));
      if (id === 'source') sourceId = contact.id; else targetId = contact.id;
    }
    state.conversations.push({ id: 'legacy', channelId: 'web-a', departmentId: 'support', contact: 'Legado RAM', version: 1, status: 'closed', owner: 'queue', messages: [] });
  });
  const password = 'Synthetic-operator-' + randomBytes(16).toString('hex');
  const operator = await ownerRequest('/api/users', { method: 'POST', body: { username: 'link-operator', password, name: 'Operador RAM', role: 'operator',
    tenantIds: [tenantId], permissions: ['contacts.read', 'contacts.write', 'inbox.read', 'inbox.transfer'],
    scopeRules: { [tenantId]: { channelIds: ['web-a', 'web-b'], departmentIds: ['support', 'sales'] } } } });
  assert.equal(operator.status, 201);
  const login = await request('/api/auth/login', { method: 'POST', body: { username: 'link-operator', password } }); assert.equal(login.status, 200);
  const api = (path, options = {}) => request(basePath + path, { ...options, cookie: login.cookie });
  const preview = () => api(`/contacts/${sourceId}/merge-preview?targetId=${targetId}`);
  const merge = async () => {
    const value = await preview(); assert.equal(value.status, 200);
    const result = await api(`/contacts/${sourceId}/merge`, { method: 'POST', body: { targetId, sourceVersion: value.data.sourceContact.version,
      targetVersion: value.data.targetContact.version, revision: value.data.revision } });
    assert.equal(result.status, 200); return result;
  };
  return { app, request, api, ownerRequest, owner, operator, login, tenantId, basePath, sourceId, targetId, preview, merge, admin };
}

test('HTTP association preview has current contact/conversation CAS and legacy POST remains compatible', async t => {
  const f = await fixture(t);
  const created = await f.ownerRequest(f.basePath + '/contacts', { method: 'POST', body: { name: 'Cadastro manual HTTP' } }); assert.equal(created.status, 201);
  const path = `/conversations/legacy/contact-preview?contactId=${created.data.id}`;
  const preview = await f.ownerRequest(f.basePath + path); assert.equal(preview.status, 200);
  assert.deepEqual(Object.keys(preview.data).sort(), ['channelId', 'contact', 'conversationId', 'kind', 'version']); assert.equal(preview.data.kind, 'person');
  const edited = await f.ownerRequest(`${f.basePath}/contacts/${created.data.id}`, { method: 'PATCH', body: { version: 1, notes: 'Concorrente' } }); assert.equal(edited.status, 200);
  const stale = await f.ownerRequest(f.basePath + '/conversations/legacy/contact', { method: 'POST', body: { contactId: created.data.id, version: 1, contactVersion: 1 } }); assert.equal(stale.status, 409);
  const linked = await f.ownerRequest(f.basePath + '/conversations/legacy/contact', { method: 'POST', body: { contactId: created.data.id, version: 1, contactVersion: 2 } }); assert.equal(linked.status, 200); assert.equal(linked.data.version, 2);
  const replay = await f.ownerRequest(f.basePath + '/conversations/legacy/contact', { method: 'POST', body: { contactId: created.data.id, version: 2 } }); assert.equal(replay.status, 200); assert.equal(replay.data.version, 2);
});

test('HTTP merge/undo returns public receipts, persists history, and hides the recovery journal from tenant and contact DTOs', async t => {
  const f = await fixture(t), before = f.app.store.tenant(f.admin, f.tenantId), merged = await f.merge();
  assert.equal(merged.data.sourceContact.mergedIntoId, f.targetId); assert.ok(merged.data.sourceContact.archivedAt);
  assert.equal(merged.data.targetContact.reversibleMergeId, merged.data.mergeId); assert.equal(merged.data.conversationCount, 1);
  assert.deepEqual(merged.data.links, [
    { conversationId: 'source', contactId: f.targetId, version: 2 },
    { conversationId: 'target', contactId: f.targetId, version: 1 }
  ]);
  for (const path of ['', `/contacts/${f.targetId}`, `/contacts?archived=true`, '/contacts?snapshot=true&archived=true']) {
    const response = await f.api(path); assert.equal(response.status, 200);
    assert.equal(response.text.includes('contactMerges'), false); assert.equal(response.text.includes('before'), false);
    assert.equal(response.text.includes('conversation:'), false); assert.equal(response.text.includes('fingerprint'), false);
  }
  assert.equal(JSON.stringify(merged.data).includes('TEXTO PRIVADO'), false);
  const preview = await f.api(`/contacts/${f.targetId}/merge-undo-preview?mergeId=${merged.data.mergeId}`); assert.equal(preview.status, 200);
  const undone = await f.api(`/contacts/${f.targetId}/merge-undo`, { method: 'POST', body: { mergeId: merged.data.mergeId, revision: preview.data.revision } });
  assert.equal(undone.status, 200); assert.equal(undone.data.sourceContact.version, 3); assert.equal(undone.data.targetContact.version, 3);
  assert.equal(Object.hasOwn(undone.data.sourceContact, 'mergedIntoId'), false); assert.equal(Object.hasOwn(undone.data.targetContact, 'reversibleMergeId'), false);
  assert.deepEqual(undone.data.links, [
    { conversationId: 'source', contactId: f.sourceId, version: 3 },
    { conversationId: 'target', contactId: f.targetId, version: 1 }
  ]);
  const state = f.app.store.tenant(f.admin, f.tenantId); assert.ok(f.app.contacts.mergeJournals(f.admin, f.tenantId)[0].undoneAt);
  for (const c of before.conversations) assert.deepEqual(state.conversations.find(item => item.id === c.id).messages, c.messages);
});

test('HTTP stale preview, altered contact/conversation and invalid inputs return 409/400 without a journal', async t => {
  const f = await fixture(t), preview = await f.preview(); assert.equal(preview.status, 200);
  const edited = await f.api(`/contacts/${f.targetId}`, { method: 'PATCH', body: { version: 1, notes: 'Mudança posterior' } }); assert.equal(edited.status, 200);
  const input = { targetId: f.targetId, sourceVersion: 1, targetVersion: 1, revision: preview.data.revision };
  assert.equal((await f.api(`/contacts/${f.sourceId}/merge`, { method: 'POST', body: input })).status, 409);
  assert.equal((await f.api(`/contacts/${f.sourceId}/merge`, { method: 'POST', body: { ...input, revision: 'invalid' } })).status, 400);
  assert.equal((await f.api(`/contacts/${f.sourceId}/merge-preview?targetId=${f.sourceId}`)).status, 400);
  assert.equal(f.app.store.tenant(f.admin, f.tenantId).contactMerges, undefined);
});

test('HTTP undo never overwrites a later contact edit and removes reversibleMergeId from fresh DTO', async t => {
  const f = await fixture(t), merged = await f.merge();
  const preview = await f.api(`/contacts/${f.targetId}/merge-undo-preview?mergeId=${merged.data.mergeId}`); assert.equal(preview.status, 200);
  const edited = await f.api(`/contacts/${f.targetId}`, { method: 'PATCH', body: { version: 2, notes: 'Conservar esta edição' } }); assert.equal(edited.status, 200);
  assert.equal(Object.hasOwn(edited.data, 'reversibleMergeId'), false);
  const rejected = await f.api(`/contacts/${f.targetId}/merge-undo`, { method: 'POST', body: { mergeId: merged.data.mergeId, revision: preview.data.revision } }); assert.equal(rejected.status, 409);
  assert.equal((await f.api(`/contacts/${f.targetId}`)).data.notes, 'Conservar esta edição');
  assert.equal((await f.api(`/contacts/${f.sourceId}/reactivate`, { method: 'POST', body: { version: 2 } })).status, 403, 'Fonte sem identidade exige acesso integral de empresa.');
  const ownerRejected = await f.ownerRequest(`${f.basePath}/contacts/${f.sourceId}/reactivate`, { method: 'POST', body: { version: 2 } }); assert.equal(ownerRejected.status, 409);
});

test('all new contact endpoints require a session, fresh membership and current scope after preview', async t => {
  const f = await fixture(t), preview = await f.preview(), input = { targetId: f.targetId, sourceVersion: 1, targetVersion: 1, revision: preview.data.revision };
  for (const [path, options] of [
    [`/contacts/${f.targetId}`, {}], [`/contacts/${f.sourceId}/merge-preview?targetId=${f.targetId}`, {}],
    [`/contacts/${f.sourceId}/merge`, { method: 'POST', body: input }],
    [`/contacts/${f.targetId}/merge-undo-preview?mergeId=synthetic`, {}],
    [`/contacts/${f.targetId}/merge-undo`, { method: 'POST', body: { mergeId: 'synthetic', revision: 'a'.repeat(64) } }],
    [`/conversations/legacy/contact-preview?contactId=${f.targetId}`, {}]
  ]) assert.equal((await f.request(f.basePath + path, options)).status, 401);
  const access = await f.ownerRequest('/api/users/' + f.operator.data.id, { method: 'PATCH', body: { scopeRules: {
    [f.tenantId]: { channelIds: ['web-a'], departmentIds: ['support'] }
  } } }); assert.equal(access.status, 200);
  assert.equal((await f.api(`/contacts/${f.sourceId}/merge`, { method: 'POST', body: input })).status, 401);
  const another = await f.ownerRequest('/api/tenants', { method: 'POST', body: { name: 'Outra empresa HTTP RAM', segment: 'QA' } });
  assert.equal((await f.request(`/api/tenants/${another.data.id}/contacts/${f.sourceId}/merge-preview?targetId=${f.targetId}`, { cookie: f.owner.cookie })).status, 404);
});

test('new public contact-links-ui.js is whitelisted with exact source; private contacts source remains inaccessible', async t => {
  const f = await fixture(t), response = await f.request('/contact-links-ui.js');
  assert.equal(response.status, 200); assert.match(response.type, /^text\/javascript\b/);
  assert.equal(response.text, await readFile(new URL('../public/contact-links-ui.js', import.meta.url), 'utf8'));
  assert.equal((await f.request('/src/contacts.js')).status, 404);
});

test('previews keep agent drafts; merge/undo invalidate only the changed source context and clear its replay', async t => {
  const f = await fixture(t), controller = new AbortController();
  f.app.store.mutate(f.admin, f.tenantId, 'Fixture: execuções sintéticas sem provedor', state => {
    state.runs = [{ id: 'source-draft', conversationId: 'source', state: 'waiting_approval', draft: 'Rascunho privado RAM', version: 1 },
      { id: 'target-draft', conversationId: 'target', state: 'waiting_approval', draft: 'Rascunho destino RAM', version: 1 }];
  });
  f.app.runtime.controllers.set(`${f.tenantId}:source-draft`, controller);
  const cleared = [], clearReplay = f.app.mcp.clearReplay.bind(f.app.mcp);
  f.app.mcp.clearReplay = (tenantId, runId) => { cleared.push([tenantId, runId]); return clearReplay(tenantId, runId); };
  const preview = await f.preview(); assert.equal(preview.status, 200); assert.equal(controller.signal.aborted, false); assert.deepEqual(cleared, []);
  const merged = await f.merge(); assert.equal(controller.signal.aborted, true);
  let runs = f.app.store.tenant(f.admin, f.tenantId).runs;
  assert.equal(runs[0].state, 'invalidated'); assert.equal(runs[0].draft, null); assert.equal(runs[0].version, 2);
  assert.equal(runs[1].state, 'waiting_approval'); assert.deepEqual(cleared, [[f.tenantId, 'source-draft']]);
  f.app.store.mutate(f.admin, f.tenantId, 'Fixture: ação posterior aguardando aprovação', state => {
    state.runs.push({ id: 'source-later', conversationId: 'source', state: 'tool_running', toolReceipt: { state: 'in_flight' }, draft: 'Ação RAM', version: 1 });
  });
  const undoPreview = await f.api(`/contacts/${f.targetId}/merge-undo-preview?mergeId=${merged.data.mergeId}`); assert.equal(undoPreview.status, 200);
  const undone = await f.api(`/contacts/${f.targetId}/merge-undo`, { method: 'POST', body: { mergeId: merged.data.mergeId, revision: undoPreview.data.revision } }); assert.equal(undone.status, 200);
  runs = f.app.store.tenant(f.admin, f.tenantId).runs;
  assert.equal(runs[2].state, 'tool_unknown'); assert.equal(runs[2].toolReceipt.state, 'unknown'); assert.equal(runs[2].draft, null);
  assert.equal(runs[1].state, 'waiting_approval'); assert.deepEqual(cleared, [[f.tenantId, 'source-draft'], [f.tenantId, 'source-later']]);
});
