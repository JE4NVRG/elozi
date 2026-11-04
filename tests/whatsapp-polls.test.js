// Native WhatsApp polls of a connected agent (reply.send with poll) and the contact's vote (pollUpdateMessage) as a
// poll_vote entry. createApp with a fake Baileys socket; votes are synthetic vectors encrypted with WhatsApp's poll vote
// algorithm (HMAC-SHA256 key chain + AES-256-GCM). No external network, provider or database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { proto } from '@whiskeysockets/baileys';
import { createApp } from '../src/server.js';
import { decryptPollSelection, incomingPollUpdate, normalizePoll, pollSecret, pollText, servicePollFields } from '../src/whatsapp-polls.js';

const status = expected => error => error.status === expected;
const LINE = '5511955550000', LINE_LID = '204812345678901';
const CUSTOMER = '5511987650000@s.whatsapp.net', CUSTOMER_LID = '118745632109876@lid';
const ATTENDANT = ['conversation.read', 'events.read', 'reply.send', 'conversation.manage'];
const POLL = { question: 'Confirmar o pedido #123?', options: ['Sim', 'Não'], selectableCount: 1 };

/** WhatsApp's vote encryption (the inverse of Baileys decryptPollVote), written independently for the synthetic vectors. */
function encryptVote({ secret, pollMsgId, creator, voter, options }) {
  const sign = Buffer.concat([Buffer.from(pollMsgId), Buffer.from(creator), Buffer.from(voter), Buffer.from('Poll Vote'), Buffer.from([1])]);
  const key0 = createHmac('sha256', Buffer.alloc(32)).update(secret).digest(), key = createHmac('sha256', key0).update(sign).digest();
  const plaintext = proto.Message.PollVoteMessage.encode({ selectedOptions: options.map(option => createHash('sha256').update(Buffer.from(option, 'utf8')).digest()) }).finish();
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`${pollMsgId}\u0000${voter}`));
  return { encPayload: Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]), encIv: iv };
}

test('enquete: pergunta, 2 a 12 opções distintas numa linha e uma escolha por voto', () => {
  assert.deepEqual(normalizePoll({ question: '  Confirmar?  ', options: [' Sim', 'Não '] }), { question: 'Confirmar?', options: ['Sim', 'Não'], selectableCount: 1 });
  assert.equal(normalizePoll({ question: 'Pedido #9\nTotal R$ 10', options: ['A', 'B'], selectableCount: 1 }).question, 'Pedido #9\nTotal R$ 10', 'pergunta pode ter quebra de linha');
  assert.equal(normalizePoll({ question: 'x'.repeat(255), options: Array.from({ length: 12 }, (_, i) => `${i}`.padEnd(100, 'o')) }).options.length, 12);
  for (const value of [null, [], { question: 'Q', options: ['A', 'B'], extra: 1 }, { question: '', options: ['A', 'B'] }, { question: 'x'.repeat(256), options: ['A', 'B'] },
    { question: 'Q\u0007', options: ['A', 'B'] }, { question: 'Q', options: ['A'] }, { question: 'Q', options: Array.from({ length: 13 }, (_, i) => `${i}`) },
    { question: 'Q', options: ['A', 'A '] }, { question: 'Q', options: ['A', ''] }, { question: 'Q', options: ['A', 'B\nC'] }, { question: 'Q', options: ['A', 'x'.repeat(101)] },
    { question: 'Q', options: ['A', 7] }, { question: 'Q', options: ['A', 'B'], selectableCount: 2 }, { question: 'Q', options: ['A', 'B'], selectableCount: 0 }])
    assert.throws(() => normalizePoll(value), status(400), JSON.stringify(value));
  assert.equal(pollText(normalizePoll(POLL)), '[Enquete] Confirmar o pedido #123? · Sim / Não');
});

test('voto sintético: decifra pelo par criador/votante (telefone ou LID) e recusa outra enquete, opção estranha e voto retirado', () => {
  const secret = pollSecret(Buffer.alloc(32, 9), 'wa', 'poll-message-1'), other = pollSecret(Buffer.alloc(32, 9), 'wa', 'poll-message-2');
  assert.equal(secret.length, 32); assert.notDeepEqual(secret, other, 'um segredo por enquete');
  assert.deepEqual(pollSecret(Buffer.alloc(32, 9), 'wa', 'poll-message-1'), secret, 'segredo recalculado é o mesmo');
  const base = { pollMsgId: '3EB0POLL0001', options: ['Sim', 'Não', 'Talvez'] };
  const context = { secret, pollMessageId: base.pollMsgId, options: base.options, creatorJids: [`${LINE}:7@s.whatsapp.net`, `${LINE_LID}:7@lid`], voterJids: [CUSTOMER_LID, CUSTOMER] };
  // The contact's phone used the line's LID and its own phone JID: the pair is found among the candidates.
  const update = { pollCreationMessageKey: { id: base.pollMsgId }, vote: encryptVote({ ...base, secret, creator: `${LINE_LID}@lid`, voter: CUSTOMER, options: ['Não'] }) };
  assert.deepEqual(decryptPollSelection(update, context), { state: 'ok', selectedOptions: ['Não'] });
  assert.deepEqual(decryptPollSelection({ ...update, vote: encryptVote({ ...base, secret: other, creator: `${LINE}@s.whatsapp.net`, voter: CUSTOMER, options: ['Sim'] }) }, context), { state: 'undecryptable' }, 'segredo de outra enquete');
  assert.deepEqual(decryptPollSelection({ ...update, vote: encryptVote({ ...base, pollMsgId: '3EB0POLL0002', secret, creator: `${LINE}@s.whatsapp.net`, voter: CUSTOMER, options: ['Sim'] }) }, context), { state: 'undecryptable' }, 'cifrado para outro id de enquete');
  assert.deepEqual(decryptPollSelection({ ...update, vote: encryptVote({ ...base, secret, creator: `${LINE}@s.whatsapp.net`, voter: '5511900000000@s.whatsapp.net', options: ['Sim'] }) }, context), { state: 'undecryptable' }, 'outro votante');
  assert.deepEqual(decryptPollSelection({ ...update, vote: encryptVote({ ...base, secret, creator: `${LINE}@s.whatsapp.net`, voter: CUSTOMER_LID, options: ['Outra'] }) }, context), { state: 'invalid' }, 'opção que não é da enquete');
  assert.deepEqual(decryptPollSelection({ ...update, vote: encryptVote({ ...base, secret, creator: `${LINE}@s.whatsapp.net`, voter: CUSTOMER, options: ['Sim', 'Não'] }) }, context), { state: 'invalid' }, 'duas escolhas numa enquete de escolha única');
  assert.deepEqual(decryptPollSelection({ ...update, vote: encryptVote({ ...base, secret, creator: `${LINE}@s.whatsapp.net`, voter: CUSTOMER, options: [] }) }, context), { state: 'empty' }, 'voto retirado');
  const tampered = encryptVote({ ...base, secret, creator: `${LINE}@s.whatsapp.net`, voter: CUSTOMER, options: ['Sim'] }); tampered.encPayload[0] ^= 1;
  assert.deepEqual(decryptPollSelection({ ...update, vote: tampered }, context), { state: 'undecryptable' }, 'conteúdo adulterado');
  // Extraction: inside an ephemeral wrapper; malformed nodes are ignored.
  assert.equal(incomingPollUpdate({ ephemeralMessage: { message: { pollUpdateMessage: update } } }), update);
  for (const message of [{ pollUpdateMessage: { vote: update.vote } }, { pollUpdateMessage: { pollCreationMessageKey: { id: 'x' }, vote: {} } }, { conversation: 'Sim' }]) assert.equal(incomingPollUpdate(message), null);
  assert.deepEqual(servicePollFields({ kind: 'customer', pollVote: { pollMessageId: 'm1', selectedOptions: ['Sim'] } }), { kind: 'poll_vote', pollMessageId: 'm1', selectedOptions: ['Sim'] });
  assert.deepEqual(servicePollFields({ kind: 'customer', text: 'Sim' }), {});
});

async function fixture(t) {
  const key = Buffer.alloc(32, 53), external = [];
  const deny = async () => { external.push(true); throw new Error('Rede externa proibida no ensaio das enquetes'); };
  const app = createApp({ databasePath: ':memory:', serviceKey: key, providerCall: deny, mcpFetchImpl: deny,
    gatewayOptions: { authKey: key, socketFactory: deny }, telegramOptions: { authKey: key, polling: false, fetchImpl: deny },
    googleOptions: { clientId: '' }, emailOptions: { apiKey: '', from: '', fetchImpl: deny }, emailChannelOptions: { fetchImpl: deny }, metaOptions: { fetchImpl: deny } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const { store, auth, webchat, servicePrincipals: principals, serviceApi: api } = app;
  const admin = auth.session(auth.insertUser({ username: 'polls.owner', name: 'Administração sintética' }, Buffer.alloc(16, 8), Buffer.alloc(64, 8), 'reseller', [], 'mep-demo')).actor;
  const now = () => new Date().toISOString();
  const direct = (id, channelId, extra = {}) => ({ id, contact: 'Cliente', channelId, departmentId: null, owner: 'agent', agentId: 'ext', status: 'open', version: 1, conversationKind: 'direct',
    messages: [{ id: `${id}-1`, kind: 'customer', text: 'Quero confirmar o pedido', createdAt: now(), transport: 'whatsapp' }], updatedAt: now(), ...extra });
  const company = (name, channelId, number, conversations) => {
    const tenant = store.createTenant(admin, { name, segment: 'Varejo' });
    store.mutate(admin, tenant.id, 'Fixture das enquetes', state => {
      state.channels = [{ id: channelId, kind: 'whatsapp_qr', transport: 'baileys', name: 'WhatsApp', expectedNumber: number, state: 'connected' }, { id: `${channelId}-site`, kind: 'webchat', name: 'Site', state: 'planned' }];
      state.departments = [];
      state.agents = [{ id: 'ext', name: 'Agente externo', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }, { id: 'ext-2', name: 'Outro agente', provider: 'mcp', mode: 'copilot', configured: true, version: 1, tools: [] }];
      state.conversations = conversations(channelId);
    });
    return tenant;
  };
  const tenant = company('Loja das enquetes', 'wa', LINE, channelId => [direct('wa-own', channelId, { remoteJid: CUSTOMER, remoteAliases: [CUSTOMER, CUSTOMER_LID] }),
    direct('wa-other-customer', channelId, { remoteJid: '5511922223333@s.whatsapp.net' }), direct('wa-other-agent', channelId, { remoteJid: '5511944445555@s.whatsapp.net', agentId: 'ext-2' }),
    { id: 'wa-group', contact: 'Grupo', channelId, departmentId: null, owner: 'agent', agentId: 'ext', status: 'open', version: 1, conversationKind: 'group', remoteJid: '1203630@g.us', messages: [] }]);
  // Another company whose line also talks to the same customer.
  const other = company('Outra loja', 'wa-b', '5511966660000', channelId => [direct('wa-b-own', channelId, { remoteJid: CUSTOMER, remoteAliases: [CUSTOMER] })]);
  webchat.configure(admin, tenant.id, 'wa-site', { version: 0, origins: ['https://loja.example.test'] });
  const sent = [];
  const line = (tenantId, channelId, number, lid) => {
    const socket = { user: { id: `${number}:5@s.whatsapp.net`, lid: `${lid}:5@lid` },
      sendMessage: async (jid, payload, options) => { sent.push({ channelId, jid, payload, options }); return { key: { id: options.messageId, remoteJid: jid, fromMe: true } }; } };
    const entry = { channelId, tenantId, actor: app.gateway.actor(admin.resellerId), expectedNumber: number, state: 'connected', matched: true, generation: 1, groupCache: new Map(), historyCursors: new Map(), socket };
    app.gateway.entries.set(channelId, entry); return entry;
  };
  const lineA = line(tenant.id, 'wa', LINE, LINE_LID), lineB = line(other.id, 'wa-b', '5511966660000', '209999999999999');
  const principal = (tenantId, channelIds, capabilities = ATTENDANT) => {
    const created = principals.create(admin, tenantId, { name: `Serviço ${channelIds.join('+')}`, agentId: 'ext', capabilities, channelIds, departmentIds: null, dailyRequests: 200, maxConcurrent: 3, ttlHours: 24 });
    return { ...created, actor: principals.authenticate('Bearer ' + created.token) };
  };
  const rest = (path, body, token, method = 'POST') => fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    .then(async response => ({ status: response.status, data: await response.json().catch(() => null) }));
  const conversation = (id, tenantId = tenant.id) => store.getConversation(store.tenant(admin, tenantId), id);
  const receipts = id => store.db.prepare('SELECT count(*) n FROM service_principal_receipts WHERE principal_id=?').get(id).n;
  let votes = 0;
  /** A pollUpdateMessage as the contact's phone sends it: the poll key seen from the contact's side and the encrypted vote. */
  const vote = (entry, pollExternalId, vector, { from = CUSTOMER, fromMe = false } = {}) => app.gateway.receive(entry, { key: { id: `3EB0VOTE${String(++votes).padStart(4, '0')}`, remoteJid: from, fromMe },
    messageTimestamp: Math.floor(Date.now() / 1000), message: { pollUpdateMessage: { pollCreationMessageKey: { remoteJid: `${LINE}@s.whatsapp.net`, fromMe: false, id: pollExternalId }, vote: vector, senderTimestampMs: Date.now() } } });
  t.after(async () => {
    app.gateway.entries.delete('wa'); app.gateway.entries.delete('wa-b');
    await app.autopilot.close(); await app.centralSupport.close();
    await Promise.all([app.webchat.close(), app.emailChannel.close(), app.meta.close(), app.email.close(), app.gateway.close(), app.telegram.close(), app.bridge.close()]);
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    assert.equal(external.length, 0, 'nenhuma rede externa'); store.close();
  });
  return { app, store, api, key, admin, tenant, other, lineA, lineB, principal, rest, conversation, receipts, vote, sent };
}

test('REST envia a enquete nativa pelo Baileys com segredo de 32 bytes, recibo, outbox e anúncio de supportsPolls', async t => {
  const f = await fixture(t), owner = f.principal(f.tenant.id, ['wa', 'wa-site']), siteOnly = f.principal(f.tenant.id, ['wa-site']), reader = f.principal(f.tenant.id, ['wa'], ['conversation.read']);
  const me = await f.rest('/api/service/v1/me', undefined, owner.token, 'GET');
  assert.equal(me.status, 200); assert.equal(me.data.supportsPolls, true);
  assert.deepEqual(me.data.polls, { channelIds: ['wa'], questionMaxLength: 255, minOptions: 2, maxOptions: 12, optionMaxLength: 100, selectableCount: 1, voteKind: 'poll_vote' });
  assert.equal(f.api.me(siteOnly.actor).supportsPolls, false, 'sem canal WhatsApp QR no escopo');
  assert.equal(f.api.me(reader.actor).supportsPolls, false, 'sem reply.send');
  assert.equal(f.api.read(owner.actor, 'wa-own', 'poll-read-0001').conversation.supportsPolls, true);
  const version = f.conversation('wa-own').version;
  const response = await f.rest('/api/service/v1/replies', { requestId: 'poll-send-0001', conversationId: 'wa-own', version, poll: POLL }, owner.token);
  assert.equal(response.status, 200, JSON.stringify(response.data));
  assert.equal(response.data.receipt.state, 'confirmed'); assert.equal(response.data.result.state, 'confirmed');
  const pollMessage = f.conversation('wa-own').messages.at(-1);
  assert.equal(response.data.result.messageId, pollMessage.id);
  assert.deepEqual([pollMessage.kind, pollMessage.text, pollMessage.poll, pollMessage.authorServiceId], ['agent', '[Enquete] Confirmar o pedido #123? · Sim / Não', POLL, owner.principal.id]);
  assert.equal(f.sent.length, 1); const [call] = f.sent;
  assert.equal(call.jid, CUSTOMER); assert.equal(call.options.messageId, pollMessage.externalId);
  assert.deepEqual(Object.keys(call.payload), ['poll']); assert.deepEqual(Object.keys(call.payload.poll).sort(), ['messageSecret', 'name', 'selectableCount', 'values']);
  assert.deepEqual([call.payload.poll.name, call.payload.poll.values, call.payload.poll.selectableCount], [POLL.question, POLL.options, 1]);
  assert.ok(Buffer.isBuffer(call.payload.poll.messageSecret) && call.payload.poll.messageSecret.length === 32);
  assert.deepEqual(call.payload.poll.messageSecret, pollSecret(f.key, 'wa', pollMessage.id), 'segredo recalculável para decifrar os votos');
  assert.equal(JSON.stringify(f.conversation('wa-own')).includes(call.payload.poll.messageSecret.toString('hex')), false, 'segredo fora do registro');
  const command = f.store.db.prepare('SELECT state,payload FROM outbound_commands WHERE tenant_id=? AND idempotency_key=?').get(f.tenant.id, `service_${response.data.receipt.id}`);
  assert.equal(command.state, 'confirmed'); assert.deepEqual(JSON.parse(command.payload).poll, POLL);
  // The agent reads its own poll.
  const read = f.api.read(owner.actor, 'wa-own', 'poll-read-0003').conversation.messages.at(-1);
  assert.deepEqual(read.poll, POLL); assert.equal(read.kind, 'agent');
});

test('idempotência e regras da resposta: replay sem novo envio, outra enquete na mesma chave, campos, canal e dono', async t => {
  const f = await fixture(t), owner = f.principal(f.tenant.id, ['wa', 'wa-site']);
  const version = f.conversation('wa-own').version, body = { requestId: 'poll-idem-0001', conversationId: 'wa-own', version, poll: POLL };
  const first = await f.api.sendReply(owner.actor, body);
  const replay = await f.api.sendReply(owner.actor, { ...body, poll: { ...POLL, question: `  ${POLL.question} ` } });
  assert.equal(replay.receipt.id, first.receipt.id); assert.deepEqual(replay.result, first.result);
  assert.equal(f.sent.length, 1, 'replay não reenvia');
  await assert.rejects(f.api.sendReply(owner.actor, { ...body, poll: { ...POLL, options: ['Sim', 'Cancelar'] } }), status(409), 'mesma chave, outra enquete');
  const receiptsBefore = f.receipts(owner.principal.id), current = f.conversation('wa-own').version;
  for (const [input, code] of [[{ requestId: 'poll-text-0001', conversationId: 'wa-own', version: current, poll: POLL, text: 'Confirma?' }, 400],
    [{ requestId: 'poll-file-0001', conversationId: 'wa-own', version: current, poll: POLL, attachment: { mime: 'application/pdf', name: 'a.pdf', data: '', sha256: '' } }, 400],
    [{ requestId: 'poll-bad-0001', conversationId: 'wa-own', version: current, poll: { ...POLL, options: ['Só uma'] } }, 400],
    [{ requestId: 'poll-group-0001', conversationId: 'wa-group', version: 1, poll: POLL }, 403],
    [{ requestId: 'poll-agent-0001', conversationId: 'wa-other-agent', version: 1, poll: POLL }, 403]])
    await assert.rejects(f.api.sendReply(owner.actor, input), status(code), input.requestId);
  assert.equal(f.receipts(owner.principal.id), receiptsBefore, 'recusas antes do recibo');
  // A conversation of another channel (webchat) never sends the poll's text in place of the poll.
  f.store.mutate(f.admin, f.tenant.id, 'Conversa do site', state => { state.conversations.push({ id: 'site-own', contact: 'Visitante', channelId: 'wa-site', departmentId: null, owner: 'agent', agentId: 'ext', status: 'open', version: 1, conversationKind: 'direct', remoteSessionId: 'synthetic', messages: [{ id: 'site-1', kind: 'customer', text: 'Oi', createdAt: new Date().toISOString() }] }); });
  await assert.rejects(f.api.sendReply(owner.actor, { requestId: 'poll-site-0001', conversationId: 'site-own', version: 1, poll: POLL }), status(400));
  assert.equal(f.api.read(owner.actor, 'site-own', 'poll-site-read').conversation.supportsPolls, false);
  assert.equal(f.sent.length, 1, 'nada além da primeira enquete chegou ao provedor');
});

test('voto do contato vira entrada poll_vote na conversa, na leitura, no histórico e nos eventos; inválido ou de outra enquete é descartado', async t => {
  const f = await fixture(t), owner = f.principal(f.tenant.id, ['wa']);
  const start = await f.api.waitForEvents(owner.actor, { timeoutMs: 0 });
  const sentPoll = await f.api.sendReply(owner.actor, { requestId: 'poll-vote-0001', conversationId: 'wa-own', version: f.conversation('wa-own').version, poll: POLL });
  const pollMessage = f.conversation('wa-own').messages.at(-1), secret = pollSecret(f.key, 'wa', pollMessage.id);
  const vector = (options, extra = {}) => encryptVote({ secret, pollMsgId: pollMessage.externalId, creator: `${LINE}@s.whatsapp.net`, voter: CUSTOMER, options, ...extra });
  const count = () => f.conversation('wa-own').messages.length;
  let before = count();
  // Invalid votes leave no entry: another poll's secret, an option outside the poll, a withdrawn vote, an unknown poll id, the line's own vote.
  await f.vote(f.lineA, pollMessage.externalId, vector(['Sim'], { secret: pollSecret(f.key, 'wa', 'outra-enquete') }));
  await f.vote(f.lineA, pollMessage.externalId, vector(['Talvez']));
  await f.vote(f.lineA, pollMessage.externalId, vector([]));
  await f.vote(f.lineA, '3EB0DESCONHECIDA', vector(['Sim'], { pollMsgId: '3EB0DESCONHECIDA' }));
  await f.vote(f.lineA, pollMessage.externalId, vector(['Sim']), { fromMe: true });
  // A vote for this poll arriving from another contact (another conversation of the same line) is not this poll's vote.
  await f.vote(f.lineA, pollMessage.externalId, encryptVote({ secret, pollMsgId: pollMessage.externalId, creator: `${LINE}@s.whatsapp.net`, voter: '5511922223333@s.whatsapp.net', options: ['Sim'] }), { from: '5511922223333@s.whatsapp.net' });
  assert.equal(count(), before, 'nenhum voto inválido registrado');
  assert.equal(f.conversation('wa-other-customer').messages.length, 1);
  // The contact's phone addressed the line by its LID and itself by the LID: the vote still decrypts.
  const version = f.conversation('wa-own').version;
  await f.vote(f.lineA, pollMessage.externalId, vector(['Sim'], { creator: `${LINE_LID}@lid`, voter: CUSTOMER_LID }), { from: CUSTOMER_LID });
  const stored = f.conversation('wa-own').messages.at(-1);
  assert.equal(count(), before + 1);
  assert.deepEqual([stored.kind, stored.text, stored.pollVote], ['customer', 'Sim', { pollMessageId: sentPoll.result.messageId, selectedOptions: ['Sim'] }]);
  assert.equal(f.conversation('wa-own').version, version + 1, 'entrada nova muda a versão como as demais');
  // Service views: kind poll_vote with the Elozi id of the poll message.
  const read = f.api.read(owner.actor, 'wa-own', 'poll-vote-read').conversation.messages.at(-1);
  assert.deepEqual(read, { id: stored.id, kind: 'poll_vote', text: 'Sim', createdAt: stored.createdAt, pollMessageId: pollMessage.id, selectedOptions: ['Sim'], attachments: [] });
  const history = f.api.readConversationHistory(owner.actor, { requestId: 'poll-vote-history', conversationId: 'wa-own' });
  assert.deepEqual(history.messages.filter(item => item.id === stored.id).map(item => [item.kind, item.text, item.pollMessageId, item.selectedOptions]), [['poll_vote', 'Sim', pollMessage.id, ['Sim']]]);
  assert.deepEqual(history.messages.find(item => item.id === pollMessage.id).poll, POLL);
  const events = await f.api.waitForEvents(owner.actor, { cursor: start.cursor, timeoutMs: 1000 });
  const messages = events.events.filter(event => event.type === 'conversation.message' && event.conversationId === 'wa-own').map(event => [event.messageId, event.kind]);
  assert.deepEqual(messages, [[pollMessage.id, 'agent'], [stored.id, 'poll_vote']]);
  // A changed vote is a new entry; the same provider message again is not.
  await f.vote(f.lineA, pollMessage.externalId, vector(['Não']));
  assert.deepEqual(f.conversation('wa-own').messages.at(-1).pollVote.selectedOptions, ['Não']);
  const replayed = { key: { id: `3EB0VOTE${String(8).padStart(4, '0')}`, remoteJid: CUSTOMER, fromMe: false }, messageTimestamp: Math.floor(Date.now() / 1000), message: { pollUpdateMessage: { pollCreationMessageKey: { id: pollMessage.externalId }, vote: vector(['Sim']) } } };
  const after = count(); await f.app.gateway.receive(f.lineA, replayed);
  assert.equal(count(), after, 'mesmo voto do provedor não duplica');
  // The agent answers a vote like any other customer entry.
  const reply = await f.api.sendReply(owner.actor, { requestId: 'poll-vote-reply', conversationId: 'wa-own', version: f.conversation('wa-own').version, text: 'Pedido confirmado.' });
  assert.equal(reply.receipt.state, 'confirmed');
});

test('isolamento por empresa: o voto só vale na linha e na conversa em que a enquete foi enviada', async t => {
  const f = await fixture(t), owner = f.principal(f.tenant.id, ['wa']), otherOwner = f.principal(f.other.id, ['wa-b']);
  await f.api.sendReply(owner.actor, { requestId: 'poll-iso-0001', conversationId: 'wa-own', version: f.conversation('wa-own').version, poll: POLL });
  const pollMessage = f.conversation('wa-own').messages.at(-1), secret = pollSecret(f.key, 'wa', pollMessage.id);
  const before = f.conversation('wa-b-own', f.other.id).messages.length;
  // The same customer votes, but the update arrives on the other company's line: that line never sent this poll.
  await f.vote(f.lineB, pollMessage.externalId, encryptVote({ secret, pollMsgId: pollMessage.externalId, creator: `${LINE}@s.whatsapp.net`, voter: CUSTOMER, options: ['Sim'] }));
  assert.equal(f.conversation('wa-b-own', f.other.id).messages.length, before, 'outra empresa não registra o voto');
  assert.equal(f.conversation('wa-own').messages.at(-1).id, pollMessage.id, 'nem a empresa de origem por esse caminho');
  // The other company cannot read the poll's conversation nor reuse its id.
  await assert.rejects(async () => f.api.read(otherOwner.actor, 'wa-own', 'poll-iso-read'), status(404));
  assert.equal(f.api.read(otherOwner.actor, 'wa-b-own', 'poll-iso-own').conversation.messages.some(message => message.kind === 'poll_vote' || message.poll), false);
  // Through its own line the vote lands only in the company that sent the poll.
  await f.vote(f.lineA, pollMessage.externalId, encryptVote({ secret, pollMsgId: pollMessage.externalId, creator: `${LINE}@s.whatsapp.net`, voter: CUSTOMER, options: ['Sim'] }));
  assert.equal(f.conversation('wa-own').messages.at(-1).pollVote.pollMessageId, pollMessage.id);
  assert.equal(f.conversation('wa-b-own', f.other.id).messages.length, before);
});
