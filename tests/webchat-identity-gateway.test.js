import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { Auth } from '../src/auth.js';
import { Operations } from '../src/operations.js';
import { WebchatGateway } from '../src/channel-webchat.js';
import { encryptedChannelSecrets } from '../src/channel-secrets.js';
import { WebchatIdentity } from '../src/webchat-identity.js';
import { MediaService } from '../src/media.js';

const origin = 'https://mepmail.identity.example.test';
const code = expected => error => error.code === expected;
const status = expected => error => error.status === expected;
const privateTables = ['webchat_sessions','webchat_visitor_profiles','webchat_identity_jti','webchat_identity_sessions'];
function fixture(t, options = {}) {
  const store = new Store(':memory:'); let clock = Date.parse('2026-10-09T12:00:00Z');
  const auth = new Auth(store.db, {validateTenant:(actor,id) => store.tenant(actor,id)});
  const row = auth.insertUser({username:'webchat-identity-owner',name:'Responsável sintético'},Buffer.alloc(16,3),Buffer.alloc(64,3),'reseller',[],'mep-demo');
  const admin = auth.actor(row), authority = {reauthorize:() => auth.actor(row)}, tenant = store.createTenant(admin,{name:'Identidade gateway RAM',segment:'QA'}), other = store.createTenant(admin,{name:'Outra empresa RAM',segment:'QA'});
  store.mutate(admin,tenant.id,'Fixture canais',state => {state.channels = [{id:'identity-site',kind:'webchat',state:'planned'},{id:'second-site',kind:'webchat',state:'planned'}];});
  store.mutate(admin,other.id,'Fixture outro canal',state => {state.channels = [{id:'other-site',kind:'webchat',state:'planned'}];});
  const {media:mediaOption,...gatewayOptions} = options, media = mediaOption === true ? new MediaService(store,{directory:null,authKey:Buffer.alloc(32,57)}) : mediaOption;
  const gateway = new WebchatGateway(store,{operations:new Operations(store,auth,{now:() => clock}),now:() => clock,...gatewayOptions,media});
  const secrets = encryptedChannelSecrets(store.db,Buffer.alloc(32,43)), identity = new WebchatIdentity(store,{secrets,channelContext:input => gateway.identityContext(input),now:() => clock});
  gateway.identity = identity;
  const keys = new Map();
  for (const [tenantId,channelId] of [[tenant.id,'identity-site'],[tenant.id,'second-site'],[other.id,'other-site']]) {
    gateway.configure(admin,tenantId,channelId,{version:0,origins:[origin]});
    identity.configure(admin,tenantId,channelId,{version:0,enabled:true,issuer:origin,externalIdPrefix:'mepmail'},authority);
    keys.set(channelId,identity.createKey(admin,tenantId,channelId,{version:1},authority));
  }
  t.after(async () => {await gateway.close(); store.close();});
  const token = (patch = {}, {channelId='identity-site',key=keys.get(channelId)} = {}) => {
    const now = Math.floor(clock/1000), head = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT',kid:key.kid})).toString('base64url');
    const body = Buffer.from(JSON.stringify({iss:origin,aud:'elozi:webchat:'+channelId,sub:'mepmail-user-01',email:'Same@Example.test',email_verified:true,name:'Nome do aplicativo',locale:'pt-BR',iat:now-1,exp:now+599,jti:randomUUID(),ctx:{teamId:'synthetic-team',teamName:'Time de teste',plan:'Developer',mailboxes:2},...patch})).toString('base64url');
    return `${head}.${body}.${createHmac('sha256',key.secret).update(`${head}.${body}`).digest('base64url')}`;
  };
  const context = (extra = {}) => ({tenantId:tenant.id,channelId:'identity-site',origin,...extra});
  const open = (identityToken, extra = {}) => {const input = context(extra), challenge = gateway.challenge(input); return gateway.openSession({...input,challenge:challenge.challenge,name:'Nome do formulário',email:'untrusted@example.test',locale:'en',...(identityToken ? {identityToken} : {})});};
  const receive = (session,text='Mensagem sintética') => gateway.receive({token:session.token,origin,text,clientMessageId:randomUUID()});
  const history = (session,extra = {}) => gateway.history({token:session.token,...context(extra)});
  const counts = () => Object.fromEntries(privateTables.map(table => [table,store.db.prepare('SELECT count(*) n FROM '+table).get().n]));
  return {store,auth,admin,authority,tenant,other,gateway,identity,keys,secrets,media,token,context,open,receive,history,counts,advance:ms => {clock += ms;},now:() => clock};
}

const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const v2 = patch => ({ v: 2, accountId: 'account-a', ...patch });
function accountUser(f) {
  const current = f.identity.status(f.admin, f.tenant.id, 'identity-site', {}, f.authority);
  f.identity.configure(f.admin, f.tenant.id, 'identity-site', { version: current.version, scope: 'account-user' }, f.authority);
}
function tenantWriteSnapshot(f) {
  return { data: f.store.db.prepare('SELECT data FROM tenants WHERE id=?').get(f.tenant.id).data,
    audit: f.store.db.prepare('SELECT count(*) n FROM audit WHERE tenant_id=?').get(f.tenant.id).n };
}
const deferred = () => {let resolve;const promise=new Promise(done => {resolve=done;});return {promise,resolve};};
async function attachment(f,session) {
  await f.gateway.receiveMedia({token:session.token,...f.context(),clientMessageId:randomUUID(),text:'Arquivo público sintético',attachment:{bytes:Buffer.from(png),name:'image.png',mime:'image/png',voice:false}});
  const conversation=f.store.tenant(f.admin,f.tenant.id).conversations[0], metadata=conversation.messages.at(-1).attachments[0];
  assert.equal(metadata.status,'ready');return {conversationId:conversation.id,id:metadata.id};
}
function blockedRead(f) {
  const entered=deferred(),release=deferred(),original=f.media.read.bind(f.media);let result;
  f.media.read=async (...args) => {result=await original(...args);entered.resolve();await release.promise;return result;};
  return {entered:entered.promise,release:release.resolve,result:() => result};
}

test('histórico combinado renova identidade v2 expirada sem nova sessão ou escrita de tenant por mera ordem de ctx', async t => {
  const f = fixture(t); accountUser(f);
  const session = f.open(f.token(v2({ exp: Math.floor(f.now()/1000) + 5 })));
  await f.receive(session, 'Histórico próprio antes da renovação');
  assert.equal(session.identityHistorySupported, true);
  const proofBefore = f.store.db.prepare('SELECT * FROM webchat_identity_sessions').get();
  const before = tenantWriteSnapshot(f), counts = f.counts();
  f.advance(65001); assert.throws(() => f.history(session), code('identity_expired'));
  const jwt = f.token(v2({ ctx: { mailboxes: 2, plan: 'Developer', teamName: 'Time de teste', teamId: 'synthetic-team' } }));
  const result = f.history(session, { identityToken: jwt, limit: 1 });
  assert.deepEqual(result.messages.map(message => message.text), ['Histórico próprio antes da renovação']);
  assert.equal(result.identityHistorySupported, true); assert.equal(result.contact.accountId, 'account-a');
  assert.deepEqual(tenantWriteSnapshot(f), before, 'claims equivalentes não regravam tenant nem audit/bridge');
  assert.equal(f.gateway.verifiedConversationCurrent(f.tenant.id, f.store.tenant(f.admin, f.tenant.id).conversations[0].id), true);
  const proofAfter = f.store.db.prepare('SELECT * FROM webchat_identity_sessions').get();
  assert.equal(proofAfter.session_id, proofBefore.session_id);
  assert.ok(proofAfter.verified_at > proofBefore.verified_at); assert.ok(proofAfter.expires_at > proofBefore.expires_at);
  assert.equal(f.counts().webchat_sessions, counts.webchat_sessions);
  assert.equal(f.counts().webchat_identity_sessions, counts.webchat_identity_sessions);
  assert.equal(f.counts().webchat_identity_jti, counts.webchat_identity_jti + 1);
  assert.throws(() => f.history(session, { identityToken: jwt }), code('identity_replay'));
  assert.deepEqual(f.history(session).messages, result.messages, 'replay recusado não derruba a sessão válida');
});

for (const page of [{ limit: 0 }, { limit: 101 }, { limit: '1' }, { after: 'bad' }, { after: randomUUID() }]) {
  test(`página inválida ${JSON.stringify(page)} não consome JWT de histórico combinado`, async t => {
    const f = fixture(t); accountUser(f); const session = f.open(f.token(v2()));
    await f.receive(session, 'Somente histórico próprio');
    const jwt = f.token(v2()), counts = f.counts(), before = tenantWriteSnapshot(f);
    assert.throws(() => f.history(session, { identityToken: jwt, ...page }), status(400));
    assert.deepEqual(f.counts(), counts); assert.deepEqual(tenantWriteSnapshot(f), before);
    assert.equal(f.history(session, { identityToken: jwt }).messages[0].text, 'Somente histórico próprio');
  });
}

test('cursor de outra conta não vaza histórico e não consome a renovação própria', async t => {
  const f = fixture(t); accountUser(f);
  const a = f.open(f.token(v2())), b = f.open(f.token(v2({ accountId: 'account-b' })));
  await f.receive(a, 'Histórico A'); const foreign = await f.receive(b, 'Histórico B privado');
  const jwt = f.token(v2()), counts = f.counts();
  assert.throws(() => f.history(a, { identityToken: jwt, after: foreign.messageId }), status(400));
  assert.deepEqual(f.counts(), counts);
  assert.deepEqual(f.history(a, { identityToken: jwt }).messages.map(message => message.text), ['Histórico A']);
});

for (const patch of [{ accountId: 'account-b' }, { sub: 'mepmail-user-02' }]) {
  test(`renovação combinada recusa trocar ${Object.keys(patch)[0]} sem consumir JWT ou prejudicar sessão original`, async t => {
    const f = fixture(t); accountUser(f); const own = f.open(f.token(v2()));
    await f.receive(own, 'Histórico da identidade original');
    const jwt = f.token(v2(patch)), counts = f.counts(), before = tenantWriteSnapshot(f);
    assert.throws(() => f.history(own, { identityToken: jwt }), code('identity_account_changed'));
    assert.deepEqual(f.counts(), counts); assert.deepEqual(tenantWriteSnapshot(f), before);
    assert.deepEqual(f.history(own).messages.map(message => message.text), ['Histórico da identidade original']);
    const other = f.open(jwt); assert.notEqual(other.contact.externalId, own.contact.externalId);
    assert.deepEqual(f.history(other).messages, []);
  });
}

for (const denied of ['origin', 'channel', 'tenant', 'audience', 'signature', 'legacy-scope', 'revoked-key', 'revoked-session']) {
  test(`histórico combinado mantém a barreira ${denied} sem consumir JWT ou escrever tenant`, async t => {
    const f = fixture(t); accountUser(f); const session = f.open(f.token(v2())); await f.receive(session, 'Histórico protegido');
    let jwt = f.token(v2()), extra = {};
    if (denied === 'origin') extra.origin = 'https://denied.example.test';
    if (denied === 'channel') extra.channelId = 'second-site';
    if (denied === 'tenant') extra = { tenantId: f.other.id, channelId: 'other-site' };
    if (denied === 'audience') jwt = f.token(v2(), { channelId: 'second-site' });
    if (denied === 'signature') jwt = f.token(v2(), { key: { kid: f.keys.get('identity-site').kid, secret: 'Z'.repeat(43) } });
    if (denied === 'legacy-scope') jwt = f.token();
    if (denied === 'revoked-key') {
      const current = f.identity.status(f.admin, f.tenant.id, 'identity-site', {}, f.authority);
      f.identity.revokeKey(f.admin, f.tenant.id, 'identity-site', { version: current.version, kid: f.keys.get('identity-site').kid }, f.authority);
    }
    if (denied === 'revoked-session') f.gateway.logout({ token: session.token, ...f.context() });
    const counts = f.counts(), before = tenantWriteSnapshot(f);
    assert.throws(() => f.history(session, { identityToken: jwt, ...extra }), error => [401, 403, 409].includes(error.status));
    assert.deepEqual(f.counts(), counts); assert.deepEqual(tenantWriteSnapshot(f), before);
  });
}

test('histórico combinado atualiza visitor apenas quando claims realmente mudam e conserva mensagens', async t => {
  const f = fixture(t); accountUser(f); const session = f.open(f.token(v2())); await f.receive(session, 'Histórico preservado');
  const before = tenantWriteSnapshot(f);
  const result = f.history(session, { identityToken: f.token(v2({ name: 'Novo nome', ctx: { accountName: 'Conta atualizada', pagePath: '/support' } })) });
  assert.equal(result.contact.name, 'Novo nome'); assert.deepEqual(result.contact.ctx, { accountName: 'Conta atualizada', pagePath: '/support' });
  assert.deepEqual(result.messages.map(message => message.text), ['Histórico preservado']);
  assert.equal(tenantWriteSnapshot(f).audit, before.audit + 1);
  assert.equal(f.gateway.verifiedConversationCurrent(f.tenant.id, f.store.tenant(f.admin, f.tenant.id).conversations[0].id), true);
});

test('histórico legado continua compatível e JWT opcional nunca transforma visitante anônimo em conta verificada', async t => {
  const f = fixture(t), legacy = f.open(f.token()); await f.receive(legacy, 'Histórico legado');
  assert.deepEqual(f.history(legacy, { identityToken: f.token() }).messages.map(message => message.text), ['Histórico legado']);
  const guest = f.open(); await f.receive(guest, 'Histórico anônimo');
  const jwt = f.token(v2()), counts = f.counts();
  assert.throws(() => f.history(guest, { identityToken: jwt }), status(403));
  assert.deepEqual(f.counts(), counts);
  assert.deepEqual(f.history(guest).messages.map(message => message.text), ['Histórico anônimo']);
  assert.equal(f.open(jwt).contact.verified, true, 'JWT recusado no visitante não foi consumido');
});

test('mesmo usuário em duas contas v2 tem contatos e históricos separados sem absorver legado', async t => {
  const f = fixture(t), legacy = f.open(f.token()), a = f.open(f.token({ v: 2, accountId: 'account-a' })), b = f.open(f.token({ v: 2, accountId: 'account-b' }));
  await f.receive(legacy, 'Somente legado'); await f.receive(a, 'Somente conta A'); await f.receive(b, 'Somente conta B');
  assert.equal(a.contact.v, 2); assert.equal(a.contact.accountId, 'account-a'); assert.equal(a.contact.userId, 'mepmail-user-01'); assert.equal(b.contact.accountId, 'account-b');
  assert.equal(legacy.contact.v, undefined); assert.equal(legacy.contact.accountId, undefined); assert.equal(legacy.contact.userId, undefined);
  assert.notEqual(a.contact.externalId, b.contact.externalId); assert.notEqual(a.contact.externalId, legacy.contact.externalId);
  const againA = f.open(f.token({ v: 2, accountId: 'account-a', ctx: { accountName: 'Conta A', product: 'Produto sintético', pagePath: '/settings' } }));
  assert.deepEqual(f.history(againA).messages.map(message => message.text), ['Somente conta A']);
  assert.deepEqual(f.history(b).messages.map(message => message.text), ['Somente conta B']);
  assert.deepEqual(f.history(legacy).messages.map(message => message.text), ['Somente legado']);
  const state = f.store.tenant(f.admin, f.tenant.id), conversations = state.conversations;
  assert.equal(state.contacts.length, 3); assert.equal(new Set(conversations.map(conversation => conversation.contactId)).size, 3);
  const own = conversations.find(conversation => conversation.webchatVisitor.accountId === 'account-a');
  assert.equal(own.webchatVisitor.v, 2); assert.equal(own.webchatVisitor.accountId, 'account-a'); assert.equal(own.webchatVisitor.userId, 'mepmail-user-01'); assert.equal(f.gateway.verifiedConversationCurrent(f.tenant.id, own.id), true);
  assert.deepEqual(f.history(f.open()).messages, []);
});

test('renovação gateway não troca conta nem versão; nova sessão recebe só o histórico da sua conta', async t => {
  const f = fixture(t), a = f.open(f.token({ v: 2, accountId: 'a' })); await f.receive(a, 'Histórico A');
  const otherToken = f.token({ v: 2, accountId: 'b' });
  assert.throws(() => f.gateway.renewIdentity({ token: a.token, ...f.context(), identityToken: otherToken }), code('identity_account_changed'));
  const b = f.open(otherToken); assert.deepEqual(f.history(b).messages, []); assert.deepEqual(f.history(a).messages.map(message => message.text), ['Histórico A']);
  const legacyToken = f.token(); assert.throws(() => f.gateway.renewIdentity({ token: a.token, ...f.context(), identityToken: legacyToken }), code('identity_account_changed'));
  const legacy = f.open(legacyToken); assert.deepEqual(f.history(legacy).messages, []);
  const renewed = f.gateway.renewIdentity({ token: a.token, ...f.context(), identityToken: f.token({ v: 2, accountId: 'a', ctx: { accountName: 'Conta A', pagePath: '/support' } }) });
  assert.equal(renewed.contact.accountId, 'a'); assert.equal(renewed.contact.v, 2); assert.equal(renewed.contact.userId, 'mepmail-user-01'); assert.deepEqual(renewed.contact.ctx, { accountName: 'Conta A', pagePath: '/support' });
  assert.deepEqual(f.history(a).messages.map(message => message.text), ['Histórico A']);
  const conversation = f.store.tenant(f.admin, f.tenant.id).conversations[0]; assert.equal(conversation.webchatVisitor.accountId, 'a');
});

test('canal account-user nega token legado sem criar sessão parcial e mantém visitante explícito separado', async t => {
  const f = fixture(t), current = f.identity.status(f.admin, f.tenant.id, 'identity-site', {}, f.authority);
  f.identity.configure(f.admin, f.tenant.id, 'identity-site', { version: current.version, scope: 'account-user' }, f.authority);
  const before = f.counts(); assert.throws(() => f.open(f.token()), code('identity_invalid')); assert.deepEqual(f.counts(), before);
  const a = f.open(f.token({ v: 2, accountId: 'a' })); await f.receive(a, 'Conta identificada');
  const visitor = f.open(); assert.equal(visitor.contact.verified, false); assert.equal(visitor.contact.accountId, undefined); assert.deepEqual(f.history(visitor).messages, []);
  f.gateway.logout({ token: a.token, ...f.context() }); assert.throws(() => f.history(a), status(403));
  const again = f.open(f.token({ v: 2, accountId: 'a' })); assert.deepEqual(f.history(again).messages.map(message => message.text), ['Conta identificada']);
});

test('anexos v2 só abrem na mesma conta e usuário, inclusive com o mesmo email e contexto legado', async t => {
  const f = fixture(t, { media: true }), a = f.open(f.token({ v: 2, accountId: 'a' })), file = await attachment(f, a);
  const same = f.open(f.token({ v: 2, accountId: 'a' })), otherAccount = f.open(f.token({ v: 2, accountId: 'b' })), legacy = f.open(f.token());
  const bytes = await f.gateway.readMedia({ token: same.token, ...f.context(), attachmentId: file.id }); assert.deepEqual(bytes.bytes, png); bytes.bytes.fill(0);
  for (const session of [otherAccount, legacy]) {
    assert.deepEqual(f.history(session).messages, []);
    await assert.rejects(f.gateway.readMedia({ token: session.token, ...f.context(), attachmentId: file.id }), status(404));
  }
});

test('aplicativo verificado prevalece sobre formulário sem criar conversa antes da primeira mensagem', async t => {
  const f = fixture(t), jwt = f.token({name:'N'.repeat(100)}), session = f.open(jwt);
  assert.equal(session.contact.name,'N'.repeat(100)); assert.equal(session.contact.email,'same@example.test'); assert.equal(session.contact.verified,true);
  assert.equal(session.contact.externalId,'mepmail:mepmail-user-01'); assert.deepEqual(session.contact.ctx,{teamId:'synthetic-team',teamName:'Time de teste',plan:'Developer',mailboxes:2});
  assert.equal(f.store.tenant(f.admin,f.tenant.id).conversations.length,0); assert.equal((f.store.tenant(f.admin,f.tenant.id).contacts || []).length,0);
  await f.receive(session);
  const state = f.store.tenant(f.admin,f.tenant.id), conversation = state.conversations[0], contact = state.contacts[0];
  assert.equal(conversation.webchatVisitor.name,'N'.repeat(100)); assert.equal(conversation.webchatVisitor.email,'same@example.test'); assert.equal(conversation.webchatVisitor.verified,true);
  assert.equal(contact.email,'same@example.test'); assert.equal(contact.identities[0].externalId,session.contact.externalId); assert.equal(contact.identities[0].verified,true);
  const publicValues = JSON.stringify([state,f.history(session),f.store.audit(f.admin,f.tenant.id)]);
  for (const sensitive of [jwt,f.keys.get('identity-site').secret,session.token]) assert.equal(publicValues.includes(sensitive),false);
  assert.throws(() => f.gateway.updateContact({token:session.token,...f.context(),email:'changed@example.test'}),status(409));
});

test('histórico em dois dispositivos usa sub/canal/empresa e nunca e-mail para juntar contas ou visitantes', async t => {
  const f = fixture(t), first = f.open(f.token()); await f.receive(first,'Histórico da conta A');
  const firstConversation = f.store.tenant(f.admin,f.tenant.id).conversations[0], firstContact = firstConversation.contactId;
  f.store.mutate(f.admin,f.tenant.id,'Fixture nota privada',state => {state.conversations[0].messages.push({id:randomUUID(),kind:'note',text:'Nota interna não pública',delivery:'sent',createdAt:new Date(f.now()).toISOString()});});
  const second = f.open(f.token()); assert.deepEqual(f.history(second).messages.map(item => item.text),['Histórico da conta A']);
  await f.receive(second,'Outro dispositivo A');
  assert.equal(f.store.tenant(f.admin,f.tenant.id).conversations[0].contactId,firstContact);
  const otherAccount = f.open(f.token({sub:'mepmail-user-02'})); assert.deepEqual(f.history(otherAccount).messages,[]); await f.receive(otherAccount,'Conta B com mesmo e-mail');
  assert.notEqual(f.store.tenant(f.admin,f.tenant.id).conversations[0].contactId,firstContact);
  const guest = f.open(); assert.equal(guest.contact.verified,false); assert.deepEqual(f.history(guest).messages,[]); await f.receive(guest,'Visitante');
  assert.notEqual(f.store.tenant(f.admin,f.tenant.id).conversations[0].contactId,firstContact);
  const anotherChannel = f.open(f.token({}, {channelId:'second-site'}),{channelId:'second-site'}); assert.deepEqual(f.history(anotherChannel,{channelId:'second-site'}).messages,[]);
  const anotherTenant = f.open(f.token({}, {channelId:'other-site'}),{tenantId:f.other.id,channelId:'other-site'}); assert.deepEqual(f.history(anotherTenant,{tenantId:f.other.id,channelId:'other-site'}).messages,[]);
  assert.throws(() => f.history(first,{tenantId:f.other.id,channelId:'other-site'}),status(403));
  assert.throws(() => f.history(first,{origin:'https://attacker.example.test'}),status(403));
  assert.equal(f.history(first).messages.length,2);
});

test('JWT inválido ou repetido não cria sessão parcial e visitante continua disponível por abertura explícita', t => {
  const f = fixture(t), jwt = f.token(), session = f.open(jwt), before = f.counts();
  assert.throws(() => f.open(jwt),code('identity_replay')); assert.deepEqual(f.counts(),before);
  const parts = f.token().split('.'); parts[2] = 'A'.repeat(43);
  assert.throws(() => f.open(parts.join('.')),code('identity_invalid')); assert.deepEqual(f.counts(),before);
  const guest = f.open(); assert.equal(guest.contact.verified,false); assert.equal(f.counts().webchat_identity_jti,1); assert.deepEqual(f.history(session).messages,[]);
});

test('consumo, sessão, perfil e vínculo fazem rollback juntos se bind falhar', t => {
  const f = fixture(t), jwt = f.token(), original = f.identity.bindSession.bind(f.identity), before = f.counts();
  f.identity.bindSession = (...args) => {original(...args); throw Object.assign(new Error('Falha sintética pós-vínculo'),{code:'synthetic_binding_failure'});};
  assert.throws(() => f.open(jwt),code('synthetic_binding_failure')); assert.deepEqual(f.counts(),before);
  f.identity.bindSession = original;
  const retried = f.open(jwt); assert.equal(retried.contact.verified,true); assert.deepEqual(f.counts(),Object.fromEntries(privateTables.map(table => [table,1])));
});

test('renovação após expirar mantém sub e histórico; troca de conta não consome JWT nem muda sessão', async t => {
  const f = fixture(t), session = f.open(f.token({exp:Math.floor(f.now()/1000)+10})); await f.receive(session,'Antes da renovação');
  f.advance(70_001); assert.throws(() => f.history(session),code('identity_expired')); await assert.rejects(f.receive(session,'Não autorizado'),code('identity_expired'));
  const otherToken = f.token({sub:'mepmail-user-02'}), before = f.counts();
  assert.throws(() => f.gateway.renewIdentity({token:session.token,...f.context(),identityToken:otherToken}),code('identity_account_changed')); assert.deepEqual(f.counts(),before);
  const renewal = f.gateway.renewIdentity({token:session.token,...f.context(),identityToken:f.token({email:'new@example.test'})});
  assert.equal(renewal.contact.externalId,session.contact.externalId); assert.equal(renewal.contact.email,'new@example.test'); assert.deepEqual(f.history(session).messages.map(item => item.text),['Antes da renovação']);
  const otherSession = f.open(otherToken); assert.equal(otherSession.contact.externalId,'mepmail:mepmail-user-02'); assert.deepEqual(f.history(otherSession).messages,[]);
});

test('logout invalida apenas a sessão atual e revogar chave corta leitura/envio das demais sem apagar histórico', async t => {
  const f = fixture(t), first = f.open(f.token()), second = f.open(f.token()); await f.receive(first,'Preservado');
  assert.deepEqual(f.gateway.logout({token:first.token,...f.context()}),{loggedOut:true}); assert.throws(() => f.history(first),status(403)); assert.equal(f.history(second).messages.length,1);
  const current = f.identity.status(f.admin,f.tenant.id,'identity-site',{},f.authority);
  f.identity.revokeKey(f.admin,f.tenant.id,'identity-site',{version:current.version,kid:f.keys.get('identity-site').kid},f.authority);
  assert.throws(() => f.history(second),code('identity_revoked')); await assert.rejects(f.receive(second,'Após revogação'),code('identity_revoked'));
  assert.equal(f.store.tenant(f.admin,f.tenant.id).conversations[0].messages.length,1);
});

test('rotação mantém antigo por até11min e renovação com nova chave não muda contato', async t => {
  const f = fixture(t), session = f.open(f.token()); await f.receive(session,'Histórico da rotação');
  const rotated = f.identity.rotateKey(f.admin,f.tenant.id,'identity-site',{version:2},f.authority);
  assert.equal(f.history(session).messages.length,1);
  f.gateway.renewIdentity({token:session.token,...f.context(),identityToken:f.token({}, {key:rotated})});
  f.advance(660_001); assert.throws(() => f.open(f.token()),code('identity_revoked'));
  f.gateway.renewIdentity({token:session.token,...f.context(),identityToken:f.token({}, {key:rotated})});
  assert.equal(f.history(session).messages.length,1); assert.equal(f.history(session).contact.externalId,'mepmail:mepmail-user-01');
});

test('mudança do namespace de identidade e origem rejeita sessão antiga preservando dados', async t => {
  const f = fixture(t), session = f.open(f.token()); await f.receive(session,'Histórico anterior');
  f.identity.configure(f.admin,f.tenant.id,'identity-site',{version:2,externalIdPrefix:'anotherapp'},f.authority);
  assert.throws(() => f.history(session),code('identity_configchanged'));
  const next = f.open(f.token()); assert.equal(next.contact.externalId,'anotherapp:mepmail-user-01'); assert.deepEqual(f.history(next).messages,[]);
  f.gateway.configure(f.admin,f.tenant.id,'identity-site',{version:1,enabled:false}); assert.throws(() => f.history(next),status(403));
  assert.equal(f.store.tenant(f.admin,f.tenant.id).conversations[0].messages.length,1);
});

test('anexo do histórico abre em outro dispositivo da mesma conta e nega visitante/sub/canal/empresa diferentes', async t => {
  const f=fixture(t,{media:true}), first=f.open(f.token()), file=await attachment(f,first), second=f.open(f.token());
  assert.equal(f.history(second).messages[0].attachments[0].id,file.id);
  const result=await f.gateway.readMedia({token:second.token,...f.context(),attachmentId:file.id});assert.deepEqual(result.bytes,png);assert.equal(result.metadata.id,file.id);result.bytes.fill(0);
  const contexts=[{session:f.open()},{session:f.open(f.token({sub:'another-account'}))},{session:f.open(f.token({}, {channelId:'second-site'}),{channelId:'second-site'}),channelId:'second-site'},{session:f.open(f.token({}, {channelId:'other-site'}),{tenantId:f.other.id,channelId:'other-site'}),tenantId:f.other.id,channelId:'other-site'}];
  for(const {session,tenantId=f.tenant.id,channelId='identity-site'} of contexts)await assert.rejects(f.gateway.readMedia({token:session.token,...f.context({tenantId,channelId}),attachmentId:file.id}),status(404));
  await assert.rejects(f.gateway.readMedia({token:second.token,...f.context({tenantId:f.other.id,channelId:'other-site'}),attachmentId:file.id}),status(403));
  f.store.mutate(f.admin,f.tenant.id,'Fixture arquivo em nota privada',state => {const current=state.conversations.find(item => item.id===file.conversationId), attachments=current.messages[0].attachments;delete current.messages[0].attachments;current.messages.push({id:randomUUID(),kind:'note',text:'Nota interna',delivery:'sent',attachments});});
  await assert.rejects(f.gateway.readMedia({token:second.token,...f.context(),attachmentId:file.id}),status(404));assert.equal(f.history(second).messages[0].attachments,undefined);
});

for(const change of ['revogar chave','expirar chave anterior','expirar JWT'])test('leitura entre dispositivos revalida após await e zera bytes ao '+change, async t => {
  const f=fixture(t,{media:true}), first=f.open(f.token()), file=await attachment(f,first), second=f.open(f.token());
  if(change==='expirar chave anterior') {
    f.identity.rotateKey(f.admin,f.tenant.id,'identity-site',{version:2},f.authority);f.advance(60_000);
    f.gateway.renewIdentity({token:second.token,...f.context(),identityToken:f.token()});
  }
  const gate=blockedRead(f), reading=f.gateway.readMedia({token:second.token,...f.context(),attachmentId:file.id});
  // Install the rejection observer before allowing the deliberately revoked read to finish.
  const rejected=assert.rejects(reading,code(change==='expirar JWT'?'identity_expired':'identity_revoked'));
  try {
    await gate.entered;assert.deepEqual(gate.result().bytes,png);
    if(change==='revogar chave')f.identity.revokeKey(f.admin,f.tenant.id,'identity-site',{version:2,kid:f.keys.get('identity-site').kid},f.authority);
    else f.advance(change==='expirar chave anterior'?600_001:660_001);
  } finally {gate.release();}
  await rejected;assert.ok(gate.result().bytes.every(byte => byte===0));
});

test('trocar a conversa candidata durante await não redireciona o contexto de arquivo nem libera bytes', async t => {
  const f=fixture(t,{media:true}), first=f.open(f.token()), file=await attachment(f,first), second=f.open(f.token());await f.receive(second,'Outro dispositivo');
  const destination=f.store.tenant(f.admin,f.tenant.id).conversations.find(value => value.id!==file.conversationId), gate=blockedRead(f), reading=f.gateway.readMedia({token:second.token,...f.context(),attachmentId:file.id}), rejected=assert.rejects(reading,status(404));
  try {
    await gate.entered;
    f.store.mutate(f.admin,f.tenant.id,'Fixture mudança de candidato',state => {const source=state.conversations.find(value => value.id===file.conversationId),target=state.conversations.find(value => value.id===destination.id), metadata=source.messages[0].attachments[0];delete source.messages[0].attachments;target.messages[0].attachments=[metadata];});
  } finally {gate.release();}
  await rejected;assert.ok(gate.result().bytes.every(byte => byte===0));
});
