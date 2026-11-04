import test from 'node:test';
import assert from 'node:assert/strict';
import { createForwarding, eligibleForwardTargets, FORWARD_MEDIA_MAX_BYTES, forwardMessageContent, forwardingContextKey, forwardingFingerprint } from '../public/forwarding.js';

const context = (extra = {}) => ({ workspaceId: 'workspace', tenantId: 'tenant', userId: 'me', conversationId: 'source', active: true, canReply: true,
  channels: [{ id: 'source-channel', name: 'Origem', transport: 'baileys', state: 'connected' }, { id: 'target-channel', name: 'Destino', transport: 'telegram-bot', state: 'connected' }], ...extra });
const file = (extra = {}) => ({ id: 'source-file', name: 'Proposta sintética.pdf', kind: 'document', mime: 'application/pdf', size: 4, status: 'ready', preview: false, ...extra });
const message = (extra = {}) => ({ id: 'source-message', kind: 'customer', text: 'Texto sintético', senderName: 'Contato sintético', ...extra });
const source = (extra = {}) => ({ id: 'source', channelId: 'source-channel', owner: 'human', assignedUserId: 'me', status: 'active', version: 3, messages: [message()], ...extra });
const target = (extra = {}) => ({ id: 'target', contact: 'Conversa sintética', channelId: 'target-channel', owner: 'human', assignedUserId: 'me', status: 'active', version: 9, messages: [], ...extra });
function setup(options = {}) {
  const state = { context: context(options.context), source: source(options.source), targets: [target()], fresh: null };
  const requests = [], downloads = [], changes = [];
  const tenant = () => structuredClone({ id: 'tenant', resellerId: 'workspace', channels: state.context.channels, conversations: [state.source, ...state.targets] });
  const request = async (path, input) => {
    requests.push({ path, input });
    if (options.request) return options.request(path, input, state, tenant);
    if (input.method === 'GET') return state.fresh || tenant();
    assert.equal(input.method, 'POST');
    assert.equal(path, `/api/tenants/${encodeURIComponent(state.context.tenantId)}/conversations/${encodeURIComponent(state.source.id)}/forward`);
    return { id: state.targets[0].id, channelId: state.targets[0].channelId };
  };
  const download = async (path, input) => {
    downloads.push({ path, input });
    assert.fail('O arquivo precisa ser copiado dentro do servidor, sem download no cliente.');
  };
  const ui = createForwarding({ getContext: () => state.context, getConversation: () => state.source, getTargets: () => state.targets, request, download,
    onChange: value => changes.push(value) });
  return { ui, state, requests, downloads, changes, tenant };
}
function choose(ui, id = 'target') { ui.prepare('source-message'); ui.selectTarget(id); }
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

test('chave de autoridade requer workspace, empresa, usuário, conversa, permissão e atividade', () => {
  assert.equal(forwardingContextKey(context()), '["workspace","tenant","me","source",""]');
  for (const extra of [{ workspaceId: '' }, { tenantId: '' }, { userId: '' }, { conversationId: '' }, { active: false }, { canReply: false }, { permissions: ['inbox.read'] }]) {
    assert.equal(forwardingContextKey(context(extra)), '');
  }
  assert.notEqual(forwardingContextKey(context({ authorityKey: 'other' })), forwardingContextKey(context()));
});

test('conteúdo encaminhável exclui notas, sistema, agentes, rascunhos e mensagens sem confirmação', () => {
  const ctx = context(), src = source();
  for (const extra of [{ kind: 'internal' }, { kind: 'system' }, { kind: 'agent' }, { kind: 'assistant' }, { internal: true }, { private: true },
    { draft: true }, { visibility: 'internal' }, ...['draft', 'pending', 'failed', 'unconfirmed', 'unknown'].map(delivery => ({ delivery }))]) {
    assert.throws(() => forwardMessageContent(message(extra), src, ctx), error => error.code === 'private-message');
  }
  assert.equal(forwardMessageContent(message(), src, ctx).text, 'Texto sintético');
  assert.equal(forwardMessageContent(message({ kind: 'human', delivery: 'read' }), src, ctx).kind, 'human');
  assert.throws(() => forwardMessageContent(message({ text: '' }), src, ctx), error => error.code === 'empty-message');
  assert.throws(() => forwardMessageContent(message({ text: 'x'.repeat(4001) }), src, ctx), error => error.code === 'text-limit');
});

test('origem/anexo precisam pertencer ao escopo, mensagem e canal; tamanho/tipo/status são conferidos', () => {
  const ctx = context(), src = source();
  for (const extra of [{ tenantId: 'other' }, { workspaceId: 'other' }, { conversationId: 'other' }, { channelId: 'other' }]) {
    assert.throws(() => forwardMessageContent(message(extra), src, ctx), error => error.code === 'source-message');
    assert.throws(() => forwardMessageContent(message({ attachments: [file(extra)] }), src, ctx), error => error.code === 'attachment-scope');
  }
  assert.throws(() => forwardMessageContent(message({ attachments: [file({ messageId: 'other' })] }), src, ctx), error => error.code === 'attachment-scope');
  for (const extra of [{ size: 0 }, { size: FORWARD_MEDIA_MAX_BYTES + 1 }, { size: NaN }, { status: 'pending' }, { mime: 'text/html' }]) {
    assert.throws(() => forwardMessageContent(message({ attachments: [file(extra)] }), src, ctx));
  }
  assert.throws(() => forwardMessageContent(message({ attachments: [file(), file({ id: 'second' })] }), src, ctx), error => error.code === 'attachment-count');
  assert.throws(() => forwardMessageContent(message(), source({ assignedUserId: 'other' }), ctx), error => error.code === 'source-authority');
});

test('prévia/fingerprint omitem URL e campos privados e cobrem identidade estável do arquivo', () => {
  const original = message({ attachments: [file({ url: 'https://external.invalid/file', thumbnail: 'javascript:bad()', data: 'secret' })], providerPayload: 'private payload' });
  const content = forwardMessageContent(original, source(), context());
  assert.doesNotMatch(JSON.stringify(content), /external\.invalid|javascript:|secret|private payload/);
  assert.equal(forwardingFingerprint(content), forwardingFingerprint(forwardMessageContent({ ...original, delivery: 'read' }, source(), context())));
  assert.notEqual(forwardingFingerprint(content), forwardingFingerprint(forwardMessageContent({ ...original, attachments: [file({ name: 'Changed.pdf' })] }, source(), context())));
});

test('destinos elegíveis são outra conversa assumida pelo usuário no mesmo workspace/empresa/canal autorizado', () => {
  const ctx = context(), good = target();
  const excluded = [{ id: 'source', channelId: 'source-channel' }, { id: 'other-user', assignedUserId: 'other' }, { id: 'queue', assignedUserId: null },
    { id: 'closed', status: 'closed' }, { id: 'agent', owner: 'agent' }, { id: 'cross-company', tenantId: 'other' },
    { id: 'cross-workspace', workspaceId: 'other' }, { id: 'denied', canReply: false }, { id: 'unknown-channel', channelId: 'unknown' }, { id: 'version', version: 0 }].map(extra => target(extra));
  assert.deepEqual(eligibleForwardTargets([good, good, ...excluded], ctx).map(item => item.id), ['target']);
  assert.deepEqual(eligibleForwardTargets([good], { ...ctx, canReply: false }), []);
  assert.deepEqual(eligibleForwardTargets([good], context({ channels: [{ id: 'target-channel', transport: 'sandbox', state: 'connected' }] })), []);
  assert.deepEqual(eligibleForwardTargets([good], context({ channels: [{ id: 'target-channel', transport: 'telegram-bot', state: 'disconnected' }] })), []);
});

test('áudio com legenda não é encaminhado silenciosamente sem texto ao WhatsApp', () => {
  const ctx = context({ channels: [{ id: 'wa', transport: 'baileys', state: 'connected' }, { id: 'target-channel', transport: 'telegram-bot', state: 'connected' }] });
  const content = forwardMessageContent(message({ text: 'Legenda preservada', attachments: [file({ kind: 'audio', mime: 'audio/ogg', voice: true })] }), source(), ctx);
  assert.equal(content.attachment.voice, true);
  assert.deepEqual(eligibleForwardTargets([target({ id: 'wa-target', channelId: 'wa' }), target()], ctx, 'source', content).map(item => item.id), ['target']);
  assert.equal(forwardMessageContent(message({ attachments: [file({ voice: true })] }), source(), ctx).attachment.voice, false);
});

test('preparar e escolher destino mostram prévia e não fazem qualquer requisição', () => {
  const { ui, requests, downloads } = setup(); const initial = ui.prepare('source-message');
  assert.equal(initial.source.text, 'Texto sintético'); assert.equal(initial.destination, null);
  assert.deepEqual(ui.targets().map(item => item.id), ['target']);
  assert.equal(ui.selectTarget('target').destination.id, 'target');
  assert.throws(() => ui.selectTarget('foreign'), error => error.code === 'destination-authority');
  assert.equal(requests.length, 0); assert.equal(downloads.length, 0);
});


test('origem Webchat sem upload encaminha texto ou mídia por uma única operação autorizada no servidor', async () => {
  for (const attachments of [[], [file()]]) {
    const { ui, state, requests, downloads } = setup({
      context: { channels: [{ id: 'source-channel', transport: 'elozi-webchat', state: 'connected', capabilities: { uploadKinds: [], voice: false, forward: true } },
        { id: 'target-channel', transport: 'telegram-bot', state: 'connected' }] },
      source: { channelAvailability: { replySession: { active: false } }, messages: [message({ attachments })] }
    });
    choose(ui); await ui.execute();
    assert.equal(ui.preview().confirmed, true); assert.equal(downloads.length, 0); assert.equal(requests.length, 2);
    const sent = requests.filter(item => item.input.method === 'POST'); assert.equal(sent.length, 1);
    assert.equal(sent[0].path, '/api/tenants/tenant/conversations/source/forward');
    const body = JSON.parse(sent[0].input.body);
    assert.equal(body.messageId, 'source-message'); assert.equal(body.destinationId, 'target'); assert.equal(body.destinationChannelId, 'target-channel');
    assert.equal(body.fingerprint, forwardingFingerprint(forwardMessageContent(state.source.messages[0], state.source, state.context)));
    for (const field of ['text', 'attachmentIds', 'mime', 'bytes', 'voice']) assert.equal(Object.hasOwn(body, field), false);
    assert.equal(sent[0].input.headers['X-Elozi-Workspace'], 'workspace');
    assert.ok(requests.every(item => !/\/(?:attachments|messages)(?:\/|$)/.test(item.path)));
  }
});


test('execução usa contrato server-forward completo e ambas revisões do snapshot fresco', async () => {
  const { ui, state, tenant, requests } = setup(); choose(ui);
  state.fresh = tenant(); state.fresh.conversations[0].version = 7; state.fresh.conversations[1].version = 12;
  assert.deepEqual(await ui.execute(), { id: 'target', channelId: 'target-channel' });
  assert.equal(requests.length, 2); assert.equal(requests[0].path, '/api/tenants/tenant'); assert.equal(requests[0].input.method, 'GET');
  const body = JSON.parse(requests[1].input.body);
  assert.deepEqual({ ...body, idempotencyKey: 'key' }, {
    messageId: 'source-message', sourceVersion: 7, sourceChannelId: 'source-channel',
    fingerprint: forwardingFingerprint(forwardMessageContent(state.source.messages[0], state.source, state.context)),
    destinationId: 'target', destinationVersion: 12, destinationChannelId: 'target-channel', idempotencyKey: 'key'
  });
  assert.match(body.idempotencyKey, /^[0-9a-f-]{36}$/i); assert.equal(requests[1].path, '/api/tenants/tenant/conversations/source/forward');
  assert.equal(requests[1].input.headers['X-Elozi-Workspace'], 'workspace'); assert.equal(ui.preview().confirmed, true);
});


test('rota escapa IDs e envia referência privada sem download, upload, Blob ou URLs recebidas', async () => {
  const { ui, state, requests, downloads } = setup({ source: { messages: [message({ text: 'Legenda', attachments: [file({ id: 'file /?', url: 'https://external.invalid/file', data: 'private bytes' })] })] } });
  state.context.tenantId = 'tenant /?'; state.source.id = 'source /?'; state.context.conversationId = state.source.id; state.targets[0].id = 'target /?';
  state.fresh = { id: state.context.tenantId, resellerId: 'workspace', channels: state.context.channels, conversations: [state.source, ...state.targets] };
  ui.prepare('source-message'); ui.selectTarget('target /?'); await ui.execute();
  assert.equal(downloads.length, 0); assert.equal(requests.length, 2);
  assert.equal(requests[0].path, '/api/tenants/tenant%20%2F%3F');
  assert.equal(requests[1].path, '/api/tenants/tenant%20%2F%3F/conversations/source%20%2F%3F/forward');
  assert.equal(typeof requests[1].input.body, 'string');
  const body = JSON.parse(requests[1].input.body); assert.equal(body.destinationId, 'target /?');
  assert.equal(body.fingerprint, forwardingFingerprint(forwardMessageContent(state.source.messages[0], state.source, state.context)));
  assert.doesNotMatch(JSON.stringify([requests, ui.preview()]), /external\.invalid|private bytes/);
});


test('voz mantém identidade na prévia sem construção de arquivo ou flag de upload no cliente', async () => {
  for (const voice of [true, false]) {
    const { ui, state, requests, downloads } = setup({ source: { messages: [message({ text: '', attachments: [file({ kind: 'audio', mime: 'audio/ogg', voice })] })] } });
    choose(ui); await ui.execute(); assert.equal(requests.length, 2); assert.equal(downloads.length, 0);
    assert.equal(JSON.parse(requests[1].input.body).fingerprint, forwardingFingerprint(forwardMessageContent(state.source.messages[0], state.source, state.context)));
    assert.equal(requests[1].input.headers['X-Elozi-Voice'], undefined);
  }
});


test('retry de texto após perda de confirmação conserva body/key e ambas revisões ao reabrir', async () => {
  let sends = 0;
  const { ui, state, requests } = setup({ request: async (path, input, state, tenant) => {
    if (input.method === 'GET') return tenant(); if (++sends === 1) throw new Error('Resposta perdida');
    return { id: 'target', channelId: 'target-channel' };
  } });
  choose(ui); await assert.rejects(ui.execute(), /Resposta perdida/); assert.equal(ui.preview().uncertain, true);
  const original = requests.at(-1).input.body;
  ui.close(); state.source.version++; state.targets[0].version++; choose(ui);
  assert.equal(sends, 1, 'Reabrir a prévia não repete envio.');
  await ui.execute(); assert.equal(requests.at(-1).input.body, original);
  assert.equal(JSON.parse(original).sourceVersion, 3); assert.equal(JSON.parse(original).destinationVersion, 9); assert.equal(sends, 2);
});


test('retry de mídia usa a mesma intenção server-forward sem baixar ou anexar no cliente', async () => {
  let sends = 0;
  const { ui, state, requests, downloads } = setup({ source: { messages: [message({ attachments: [file()] })] }, request: async (path, input, state, tenant) => {
    if (input.method === 'GET') return tenant();
    if (++sends === 1) throw new Error('Confirmação perdida'); return { id: 'target', channelId: 'target-channel' };
  } });
  choose(ui); await assert.rejects(ui.execute(), /Confirmação perdida/); const original = requests.at(-1).input.body;
  ui.close(); state.source.version++; state.targets[0].version++; choose(ui); await ui.execute();
  assert.equal(requests.at(-1).input.body, original); assert.equal(downloads.length, 0); assert.equal(requests.length, 4);
  assert.ok(requests.filter(item => item.input.method === 'POST').every(item => item.path.endsWith('/source/forward')));
});

test('tentativa confirmada reaberta atualiza autoridade e não publica novamente', async () => {
  const { ui, state, requests } = setup(); choose(ui); await ui.execute(); ui.close();
  state.targets[0].messages = [message({ id: 'fresh-only', text: 'Histórico atual autorizado' })];
  choose(ui); const refreshed = await ui.execute();
  assert.equal(refreshed.messages[0].id, 'fresh-only');
  assert.equal(requests.filter(item => item.path.endsWith('/forward')).length, 1);
  assert.equal(requests.filter(item => item.input.method === 'GET').length, 2);
});


test('contexto alterado no GET impede POST; no POST confirmado bloqueia exposição e não duplica envio', async t => {
  for (const stage of ['fresh', 'post']) {
    for (const change of [{ tenantId: 'other' }, { workspaceId: 'other' }, { userId: 'other' }, { conversationId: 'other' }, { canReply: false }, { authorityKey: 'revoked' }]) {
      await t.test(stage + ': ' + Object.keys(change)[0], async () => {
        let first = true;
        const { ui, state, requests, downloads } = setup({ source: { messages: [message({ attachments: [file()] })] }, request: async (path, input, state, tenant) => {
          if (input.method === 'GET') { const fresh = tenant(); if (stage === 'fresh' && first) { first = false; Object.assign(state.context, change); } return fresh; }
          if (stage === 'post' && first) { first = false; Object.assign(state.context, change); }
          return { id: 'target', channelId: 'target-channel' };
        } });
        const original = { ...state.context }; choose(ui);
        await assert.rejects(ui.execute(), error => stage === 'post' ? error.confirmed === true : error.status === 403);
        assert.equal(requests.filter(item => item.input.method === 'POST').length, stage === 'post' ? 1 : 0);
        assert.equal(downloads.length, 0); assert.equal(ui.preview(), null);
        if (stage === 'post') {
          Object.assign(state.context, original); ui.close(); choose(ui); assert.equal(ui.preview().confirmed, true); await ui.execute();
          assert.equal(requests.filter(item => item.input.method === 'POST').length, 1);
        }
      });
    }
  }
});


test('texto, metadados ou autoridade da origem alterados durante GET interrompem antes do forward', async () => {
  for (const change of [state => { state.source.messages[0].text = 'Outro corpo'; }, state => { state.source.messages[0].attachments[0].name = 'Outro.pdf'; },
    state => { state.source.messages[0].attachments[0].id = 'other'; }, state => { state.source.messages[0].kind = 'internal'; },
    state => { state.source.assignedUserId = 'other'; }, state => { state.source.channelId = 'other'; }]) {
    const { ui, requests } = setup({ source: { messages: [message({ attachments: [file()] })] }, request: async (path, input, state, tenant) => {
      assert.equal(input.method, 'GET'); const fresh = tenant(); change(state); return fresh;
    } });
    choose(ui); await assert.rejects(ui.execute()); assert.equal(requests.length, 1);
  }
});


test('destino precisa continuar permitido, assumido, presente e conectado após GET', async () => {
  for (const change of [state => { state.targets[0].assignedUserId = 'other'; }, state => { state.targets = []; }, state => { state.targets[0].canReply = false; },
    state => { state.context.channels[1].state = 'disconnected'; }, state => { state.targets[0].channelId = 'source-channel'; }, state => { state.targets[0].workspaceId = 'other'; }]) {
    const { ui, requests } = setup({ source: { messages: [message({ attachments: [file()] })] }, request: async (path, input, state, tenant) => {
      assert.equal(input.method, 'GET'); const fresh = tenant(); change(state); return fresh;
    } });
    choose(ui); await assert.rejects(ui.execute()); assert.equal(requests.length, 1);
  }
});


test('revisão local avançada após GET impede POST e nova prévia usa versões frescas', async () => {
  for (const side of ['source', 'destination']) {
    let changed = false;
    const { ui, state, requests } = setup({ request: async (path, input, state, tenant) => {
      if (input.method === 'GET') { const fresh = tenant(); if (!changed) { changed = true; if (side === 'source') state.source.version++; else state.targets[0].version++; } return fresh; }
      return { id: 'target', channelId: 'target-channel' };
    } });
    choose(ui); await assert.rejects(ui.execute(), error => error.code === side + '-version');
    assert.equal(requests.filter(item => item.input.method === 'POST').length, 0);
    ui.close(); choose(ui); await ui.execute();
    const body = JSON.parse(requests.at(-1).input.body);
    assert.equal(body.sourceVersion, state.source.version); assert.equal(body.destinationVersion, state.targets[0].version);
    assert.ok(requests.every(item => item.input.method !== 'DELETE'));
  }
});

test('snapshot fresco de outra empresa/workspace ou destino sem autoridade não gera forward', async () => {
  for (const change of [fresh => { fresh.id = 'other'; }, fresh => { fresh.resellerId = 'other'; }, fresh => { fresh.conversations[1].assignedUserId = 'other'; },
    fresh => { fresh.channels[1].state = 'disconnected'; }, fresh => { fresh.conversations[0].messages[0].text = 'Alterado remotamente'; }]) {
    const { ui, state, tenant, requests, downloads } = setup({ source: { messages: [message({ attachments: [file()] })] } });
    state.fresh = tenant(); change(state.fresh); choose(ui); await assert.rejects(ui.execute()); assert.equal(requests.length, 1); assert.equal(downloads.length, 0);
  }
});


test('401/403/404 no GET ou forward bloqueiam a intenção sem retry automático ou rota legada', async () => {
  for (const stage of ['fresh', 'post']) for (const status of [401, 403, 404]) {
    const { ui, requests, downloads } = setup({ source: { messages: [message({ attachments: [file()] })] }, request: async (path, input, state, tenant) => {
      if (input.method === 'GET' && stage === 'post') return tenant(); throw Object.assign(new Error('Autoridade revogada'), { status });
    } });
    choose(ui); await assert.rejects(ui.execute(), /Autoridade revogada/); const count = requests.length;
    await assert.rejects(ui.execute(), error => error.code === 'blocked');
    assert.equal(requests.length, count); assert.equal(downloads.length, 0);
    assert.equal(requests.filter(item => item.input.method === 'POST').length, stage === 'post' ? 1 : 0);
  }
});


test('revisão inválida da origem no snapshot fresco não inicia POST', async () => {
  for (const version of [undefined, null, 0, -1, 1.5, '3', Number.MAX_SAFE_INTEGER + 1]) {
    const { ui, state, tenant, requests } = setup(); state.fresh = tenant(); state.fresh.conversations[0].version = version;
    choose(ui); await assert.rejects(ui.execute(), error => error.code === 'source-version'); assert.equal(requests.length, 1);
  }
});


test('fechar ou resetar durante GET aborta e bloqueia forward; nova prévia reautoriza', async () => {
  for (const action of ['close', 'reset']) {
    const waiting = deferred(), entered = deferred(); let calls = 0;
    const { ui, requests, tenant } = setup({ request: async (path, input, state, tenant) => {
      if (input.method === 'GET') { if (++calls === 1) { entered.resolve(); return waiting.promise; } return tenant(); }
      return { id: 'target', channelId: 'target-channel' };
    } });
    choose(ui); const execution = ui.execute(); await entered.promise; ui[action](); assert.equal(requests[0].input.signal.aborted, true);
    waiting.resolve(tenant()); await assert.rejects(execution, error => error.code === 'closed');
    assert.equal(requests.length, 1); choose(ui); await ui.execute();
    assert.equal(requests.filter(item => item.input.method === 'POST').length, 1);
  }
});

test('fechar durante POST sem recibo preserva incerteza e o mesmo body para conferência explícita', async () => {
  const waiting = deferred(), entered = deferred(); let sends = 0;
  const { ui, state, requests } = setup({ request: async (path, input, state, tenant) => {
    if (input.method === 'GET') return tenant(); if (++sends === 1) { entered.resolve(); return waiting.promise; }
    return { id: 'target', channelId: 'target-channel' };
  } });
  choose(ui); const execution = ui.execute(); await entered.promise; const original = requests.at(-1).input.body;
  ui.close(); assert.equal(requests.at(-1).input.signal.aborted, true);
  waiting.reject(Object.assign(new Error('Interrompido sem recibo'), { name: 'AbortError' }));
  await assert.rejects(execution, /Interrompido sem recibo/); state.source.version++; state.targets[0].version++; choose(ui);
  assert.equal(ui.preview().uncertain, true); assert.equal(sends, 1); await ui.execute(); assert.equal(requests.at(-1).input.body, original);
});

test('tentativa confirmada não retorna cache quando GET fresco revoga autoridade do destino', async () => {
  const { ui, state, tenant, requests } = setup(); choose(ui); await ui.execute(); ui.close(); choose(ui);
  state.fresh = tenant(); state.fresh.conversations[1].assignedUserId = 'other';
  await assert.rejects(ui.execute(), error => error.code === 'fresh-destination' && error.confirmed === true);
  assert.equal(requests.filter(item => item.input.method === 'POST').length, 1);
});

test('sucesso recebido após troca de contexto permanece confirmado e retry não gera outro POST', async () => {
  const waiting = deferred(), entered = deferred(); let sends = 0;
  const { ui, state, requests } = setup({ request: async (path, input, state, tenant) => {
    if (input.method === 'GET') return tenant(); sends++; entered.resolve(); return waiting.promise;
  } });
  choose(ui); const execution = ui.execute(); await entered.promise; state.context.tenantId = 'other'; waiting.resolve({ id: 'target', channelId: 'target-channel' });
  await assert.rejects(execution, error => error.confirmed === true); assert.equal(ui.preview(), null);
  state.context.tenantId = 'tenant'; ui.close(); choose(ui); assert.equal(ui.preview().confirmed, true); await ui.execute();
  assert.equal(sends, 1); assert.equal(requests.filter(item => item.path.endsWith('/forward')).length, 1);
});

test('resposta de outro destino conserva incerteza e payload idempotente para conferência', async () => {
  let sends = 0;
  const { ui, requests } = setup({ request: async (path, input, state, tenant) => {
    if (input.method === 'GET') return tenant(); return ++sends === 1 ? { id: 'other', channelId: 'target-channel' } : { id: 'target', channelId: 'target-channel' };
  } });
  choose(ui); await assert.rejects(ui.execute(), error => error.code === 'send-result'); assert.equal(ui.preview().uncertain, true);
  const before = requests.at(-1).input.body; await ui.execute(); assert.equal(requests.at(-1).input.body, before);
});

test('executar duplamente ou alterar prévia enquanto envio espera não cria outro efeito', async () => {
  const waiting = deferred(), entered = deferred();
  const { ui, requests, tenant } = setup({ request: async (path, input) => { if (input.method === 'GET') { entered.resolve(); return waiting.promise; } return { id: 'target', channelId: 'target-channel' }; } });
  choose(ui); const execution = ui.execute(); await entered.promise;
  await assert.rejects(ui.execute(), error => error.code === 'busy'); assert.throws(() => ui.prepare('source-message'), error => error.code === 'busy');
  assert.throws(() => ui.selectTarget('target'), error => error.code === 'busy'); waiting.resolve(tenant()); await execution; assert.equal(requests.length, 2);
});

test('API base externa, origem duplicada e contexto fora do inbox são rejeitados antes de efeitos', () => {
  const external = setup({ context: { basePath: 'https://external.invalid/api/tenants/tenant' } });
  assert.throws(() => external.ui.prepare('source-message'), error => error.code === 'api-scope'); assert.equal(external.requests.length, 0);
  const duplicate = setup({ source: { messages: [message(), message()] } }); assert.throws(() => duplicate.ui.prepare('source-message'), error => error.code === 'source-message');
  const { ui, state, changes } = setup(); choose(ui); state.context.active = false; assert.equal(ui.preview(), null); assert.deepEqual(ui.targets(), []);
  ui.close(); assert.ok(changes.every(change => !Object.hasOwn(change, 'source') && !Object.hasOwn(change, 'text')));
});

test('módulo não acessa DOM/storage/blob URLs nem executa fetch direto', async t => {
  const blocked = () => { throw new Error('Encaminhamento não pode alterar compositor/DOM/storage nem usar fetch direto.'); };
  t.mock.method(globalThis, 'fetch', blocked); t.mock.method(URL, 'createObjectURL', blocked);
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { querySelector: blocked } }); Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: blocked });
  t.after(() => { if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument); else delete globalThis.document;
    if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage); else delete globalThis.localStorage; });
  const draft = { text: 'Rascunho físico', quoteId: 'quote', file: { id: 'draft-file' }, playerTime: 4.2 };
  const { ui } = setup({ source: { messages: [message({ attachments: [file()] })] } }); choose(ui); await ui.execute(); ui.close(); ui.reset();
  assert.deepEqual(draft, { text: 'Rascunho físico', quoteId: 'quote', file: { id: 'draft-file' }, playerTime: 4.2 });
});
