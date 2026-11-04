import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorkspaceDomainsUI } from '../public/workspace-domains-ui.js';

const account = (extra = {}) => ({ id: 'business-a', name: 'Empresa QA', accountKind: 'business', parentWorkspaceId: 'reseller-a', version: 2, ...extra });
const time = '2026-10-03T10:00:00.000Z', challenge = 'a'.repeat(64), canonicalHost = 'elozi.je4ndev.com';
const requirements = ['TXT de propriedade e CNAME conferidos no DNS público.', 'Proxy configurado para este hostname e para a aplicação Elozi.', 'HTTPS com certificado válido para o hostname, verificado por inspeção técnica da plataforma.'];
const domain = (state = 'pending', extra = {}) => ({ host: 'chat.empresa.com.br', state, configuredAt: time, verifiedAt: ['verified', 'active'].includes(state) ? time : null, active: state === 'active', challenge,
  records: [{ type: 'TXT', name: '_elozi-verification.chat.empresa.com.br', value: `elozi-verification=${challenge}` }, { type: 'CNAME', name: 'chat.empresa.com.br', value: canonicalHost }], lastCheck: null,
  deployment: state === 'active' ? { host: 'chat.empresa.com.br', httpsOrigin: 'https://chat.empresa.com.br', canonicalHost, tlsValid: true, proxyVerified: true, observedAt: time, certificateExpiresAt: '2099-01-01T00:00:00.000Z', sourceRevision: 'b'.repeat(40) } : null, ...extra });
const dto = (extra = {}) => ({ workspaceId: 'business-a', version: 2, canonicalHost, binding: null, activationRequirements: requirements, deploymentInspectionAvailable: true, canConfirmDeployment: false, ...extra });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function fixture(t, { platform = false, intercept, initial } = {}) {
  const oldFormData = globalThis.FormData;
  globalThis.FormData = class { constructor(form) { this.fields = form.fields; } get(name) { return this.fields[name] ?? null; } };
  t.after(() => { globalThis.FormData = oldFormData; });
  const state = { view: platform ? 'platform' : 'accounts', workspaceId: platform ? 'mep-demo' : 'reseller-a', supportGrantId: null, boot: { csrfToken: 'csrf-qa', session: { userId: 'person-qa', role: 'reseller', platformOwner: platform, resellerId: platform ? 'mep-demo' : 'reseller-a' }, reseller: { accountKind: platform ? 'platform' : 'reseller' }, workspaces: [{ id: 'mep-demo', platformWorkspace: true }] } };
  const calls = [], opened = [], messages = [], updates = [], listeners = new Map();
  let data = dto({ canConfirmDeployment: platform, ...initial });
  const modal = { open: false, html: '', panel: null, error: { textContent: '' },
    querySelector(selector) { return selector === '[data-domains-panel]' ? this.panel : selector === '.form-error' ? this.error : null; }, addEventListener: (name, callback) => listeners.set(name, callback), close() { this.open = false; listeners.get('close')?.(); },
    queueClose() { this.open = false; return new Promise(resolve => setImmediate(() => { listeners.get('close')?.(); resolve(); })); }
  };
  function fallback(path, init) {
    if ((init.method || 'GET') === 'GET') return structuredClone(data);
    const body = JSON.parse(init.body);
    if (body.version !== data.version) throw Object.assign(new Error('A conta mudou.'), { status: 409 });
    data.version++;
    if (init.method === 'DELETE') data.binding = null;
    else if (path.endsWith('/verify')) data.binding = domain('verified', { ...data.binding, state: 'verified', verifiedAt: time, lastCheck: { txtOwnership: true, cnameTarget: true, checkedAt: time } });
    else if (path.endsWith('/activate')) data.binding = domain('active', { challenge: data.binding.challenge, records: data.binding.records });
    else if (path.endsWith('/disable')) data.binding = domain('disabled', { challenge: data.binding.challenge, records: data.binding.records });
    else { const token = data.binding ? 'c'.repeat(64) : challenge; data.binding = domain('pending', { host: body.host, challenge: token, records: [{ type: 'TXT', name: `_elozi-verification.${body.host}`, value: `elozi-verification=${token}` }, { type: 'CNAME', name: body.host, value: canonicalHost }] }); }
    return structuredClone(data);
  }
  const ui = createWorkspaceDomainsUI({ state, api: async (path, init = {}) => { calls.push({ path, init }); return intercept ? intercept(path, init, fallback) : fallback(path, init); },
    openModal(title, subtitle, html) { modal.open = true; modal.html = html; modal.error = { textContent: '' }; const token = html.match(/data-domains-panel data-domains-token="([^"]+)"/)?.[1]; modal.panel = token ? { dataset: { domainsToken: token }, querySelector: selector => selector === '.form-error' ? modal.error : null } : null; opened.push({ title, subtitle, html }); },
    getModal: () => modal, toast: (message, failed) => messages.push({ message, failed }), onUpdate: async () => updates.push(true)
  });
  const node = (name, extra = {}) => ({ dataset: { domainsAction: name, domainsToken: modal.panel?.dataset.domainsToken, ...extra } });
  const action = (name, extra) => ui.action(node(name, extra));
  const form = (type, fields = {}) => ({ dataset: { domainsForm: type, domainsToken: modal.panel?.dataset.domainsToken }, fields, button: { disabled: false }, querySelector(selector) { return selector === '[type="submit"]' ? this.button : selector === '.form-error' ? modal.error : null; } });
  const writes = () => calls.filter(call => call.init.method !== 'GET');
  return { ui, state, calls, modal, opened, messages, updates, node, action, form, writes, setData: next => { data = next; }, getData: () => structuredClone(data), fallback };
}

test('cadastro consulta conta, normaliza IDN, envia CAS interno e apresenta TXT/CNAME somente leitura', async t => {
  const f = fixture(t); await f.ui.open(account({ name: '<img onerror="bad()">' }));
  assert.match(f.modal.html, /&lt;img onerror=&quot;bad\(\)&quot;&gt;/); assert.equal(f.modal.html.includes('<img'), false); assert.match(f.modal.html, /Nenhum domínio cadastrado/);
  await f.ui.submit(f.form('register', { host: '  CHAT.MARCAÇÂO.COM.BR.  ', version: '999', tlsValid: 'yes' }));
  const call = f.writes()[0]; assert.equal(call.path, '/api/accounts/business-a/domain'); assert.equal(call.init.method, 'POST'); assert.deepEqual(JSON.parse(call.init.body), { version: 2, host: 'chat.xn--marcao-0ta3b.com.br' });
  assert.match(f.modal.html, /DNS pendente/); assert.match(f.modal.html, /readonly/); assert.match(f.modal.html, /elozi-verification=aaaaaaaa/); assert.match(f.modal.html, /TXT/); assert.match(f.modal.html, /CNAME/);
  assert.equal(f.modal.html.includes('checkbox'), false); assert.equal(f.modal.html.includes('data-domains-action="activate"'), false); assert.equal(f.updates.length, 1); assert.equal(call.init.headers['X-Elozi-Workspace'], 'reseller-a');
});

test('DNS verificado permanece separado da ativação; somente plataforma envia activate sem evidência cliente', async t => {
  for (const platform of [false, true]) await t.test(String(platform), async child => {
    const f = fixture(child, { platform, initial: { binding: domain() } }); await f.ui.open(account()); await f.action('verify');
    assert.match(f.modal.html, /Propriedade verificada/); assert.equal(f.getData().binding.active, false); assert.match(f.modal.html, /proxy e o certificado/);
    assert.deepEqual(JSON.parse(f.writes()[0].init.body), { version: 2 });
    if (platform) { assert.match(f.modal.html, /Inspecionar HTTPS e ativar/); await f.action('activate'); assert.deepEqual(JSON.parse(f.writes()[1].init.body), { version: 3 }); assert.match(f.modal.html, /Endereço ativo/); assert.match(f.modal.html, /Certificado válido até/); }
    else { assert.match(f.modal.html, /administrador da plataforma/); await f.action('activate'); assert.equal(f.writes().length, 1); }
  });
});

test('TXT e rota HTTPS assinada confirmam a propriedade mesmo com CNAME oculto, sem ativação automática', async t => {
  for (const platform of [false, true]) await t.test(String(platform), async child => {
    const result = dto({ version: 3, canConfirmDeployment: platform, binding: domain('verified', { lastCheck: { txtOwnership: true, cnameTarget: false, routeVerified: true, verificationMethod: 'txt+signed-https', checkedAt: time } }) });
    const f = fixture(child, { platform, initial: { binding: domain() }, intercept: (path, init, fallback) => { if (path.endsWith('/verify')) { f.setData(result); return structuredClone(result); } return fallback(path, init); } });
    assert.equal(await f.ui.open(account()), true); await f.action('verify');
    const notice = 'Propriedade DNS confirmada. Revise a etapa HTTPS.';
    assert.match(f.modal.html, /Propriedade verificada/); assert.ok(f.modal.html.includes(notice)); assert.match(f.modal.html, /CNAME oculto pelo proxy · rota HTTPS assinada confirmada/);
    assert.equal(f.modal.html.includes('Os registros ainda não foram confirmados'), false); assert.equal(f.modal.html.includes('Resposta da alteração pendente'), false); assert.equal(f.modal.error.textContent, '');
    assert.deepEqual(f.messages, [{ message: notice, failed: undefined }]); assert.equal(f.updates.length, 1);
    assert.deepEqual(f.writes().map(call => [call.path, JSON.parse(call.init.body)]), [['/api/accounts/business-a/domain/verify', { version: 2 }]]);
    assert.equal(f.getData().binding.state, 'verified'); assert.equal(f.getData().binding.active, false); assert.equal(f.getData().binding.deployment, null); assert.equal(f.modal.html.includes('Endereço ativo'), false);
    assert.equal(f.modal.html.includes('data-domains-action="activate"'), platform);
  });
});

test('TXT sem CNAME ou rota, método sem prova e rota sem TXT continuam pendentes e não permitem ativação', async t => {
  for (const [label, check] of [
    ['TXT sem rota', { txtOwnership: true, cnameTarget: false, routeVerified: false }],
    ['método sem prova', { txtOwnership: true, cnameTarget: false, verificationMethod: 'txt+signed-https' }],
    ['rota sem TXT', { txtOwnership: false, cnameTarget: false, routeVerified: true, verificationMethod: 'txt+signed-https' }],
    ['CNAME sem TXT', { txtOwnership: false, cnameTarget: true, routeVerified: false }]
  ]) await t.test(label, async child => {
    const result = dto({ version: 3, canConfirmDeployment: true, binding: domain('pending', { lastCheck: { ...check, checkedAt: time } }) });
    const f = fixture(child, { platform: true, initial: { binding: domain() }, intercept: (path, init, fallback) => { if (path.endsWith('/verify')) { f.setData(result); return structuredClone(result); } return fallback(path, init); } });
    assert.equal(await f.ui.open(account()), true); await f.action('verify');
    assert.match(f.modal.html, /DNS pendente/); assert.match(f.modal.html, /DNS consultado\. Os registros ainda não foram confirmados\./); assert.equal(f.modal.html.includes('Propriedade DNS confirmada.'), false); assert.equal(f.modal.html.includes('data-domains-action="activate"'), false);
    assert.deepEqual(f.messages, [{ message: 'DNS consultado. Os registros ainda não foram confirmados.', failed: undefined }]); assert.equal(f.modal.error.textContent, '');
    await f.action('activate'); assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].path, '/api/accounts/business-a/domain/verify'); assert.equal(f.getData().binding.state, 'pending'); assert.equal(f.getData().binding.verifiedAt, null); assert.equal(f.getData().binding.active, false); assert.equal(f.getData().binding.deployment, null);
  });
});

test('routeVerified precisa ser booleano no DTO e não aceita confirmação textual', async t => {
  const f = fixture(t, { initial: { binding: domain('pending', { lastCheck: { txtOwnership: true, cnameTarget: false, routeVerified: 'true', verificationMethod: 'txt+signed-https', checkedAt: time } }) } });
  assert.equal(await f.ui.open(account()), false); assert.match(f.modal.html, /Não foi possível consultar/); assert.equal(f.modal.html.includes('rota HTTPS assinada confirmada'), false); assert.equal(f.modal.html.includes('data-domains-action="activate"'), false); assert.equal(f.writes().length, 0);
});

test('certificado expirado e inspeção indisponível são explícitos e não simulam ativação', async t => {
  const expired = domain('active', { active: false }); expired.deployment.certificateExpiresAt = '2020-01-01T00:00:00.000Z';
  const f = fixture(t, { initial: { binding: expired, deploymentInspectionAvailable: false } }); await f.ui.open(account());
  assert.match(f.modal.html, /Certificado expirado · endereço inativo/); assert.match(f.modal.html, /inspeção HTTPS está indisponível/); assert.equal(f.modal.html.includes('data-domains-action="activate"'), false); assert.equal(f.writes().length, 0);
});

test('desativação e remoção exigem revisão do hostname e afetam somente vínculo; novo TXT após desativar', async t => {
  const f = fixture(t, { initial: { binding: domain('active') } }); await f.ui.open(account());
  await f.action('disable-review'); assert.equal(f.writes().length, 0); assert.match(f.modal.html, /somente o endereço personalizado/); assert.match(f.modal.html, /Dados, canais e conta serão preservados/); assert.match(f.modal.html, /continuará reservado/);
  await f.ui.submit(f.form('disable', { version: '999' })); assert.equal(f.writes()[0].path, '/api/accounts/business-a/domain/disable'); assert.deepEqual(JSON.parse(f.writes()[0].init.body), { version: 2 }); assert.match(f.modal.html, /Endereço desativado/);
  await f.ui.submit(f.form('register', { host: 'chat.empresa.com.br' })); assert.match(f.modal.html, /elozi-verification=cccccccc/);
  await f.action('remove-review'); assert.equal(f.writes().length, 2); assert.match(f.modal.html, /ficará livre para outro cadastro/); await f.ui.submit(f.form('remove'));
  assert.equal(f.writes()[2].init.method, 'DELETE'); assert.deepEqual(JSON.parse(f.writes()[2].init.body), { version: 4 }); assert.match(f.modal.html, /Hostname liberado/); assert.equal(f.getData().binding, null);
  assert.equal(f.calls.some(call => /tenant|channel|billing|invitation|logout/.test(call.path)), false);
});

test('readonly de reingresso não permite trocar hostname sem remover vínculo e rejeita hosts técnicos inválidos', async t => {
  for (const host of ['https://marca.com', 'marca.com:443', 'marca.com/path', '*.marca.com', '127.0.0.1', '[::1]', 'host.local', 'host.invalid', 'marca.com?x=1', 'marca.com@another.com']) await t.test(host, async child => {
    const f = fixture(child); await f.ui.open(account()); await f.ui.submit(f.form('register', { host })); assert.equal(f.writes().length, 0); assert.ok(f.modal.error.textContent);
  });
  const f = fixture(t, { initial: { binding: domain('disabled') } }); await f.ui.open(account()); await f.ui.submit(f.form('register', { host: 'outro.empresa.com.br' })); assert.equal(f.writes().length, 0); assert.match(f.modal.error.textContent, /Remova o vínculo anterior/);
});

test('cópia usa registro validado da conta e ignora valores forjados no botão', async t => {
  const oldNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator'), copied = [];
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async value => copied.push(value) } } });
  t.after(() => oldNavigator ? Object.defineProperty(globalThis, 'navigator', oldNavigator) : delete globalThis.navigator);
  const f = fixture(t, { initial: { binding: domain() } }); await f.ui.open(account());
  await f.action('copy', { domainsRecord: '0', domainsField: 'value', value: 'forged' }); assert.deepEqual(copied, [`elozi-verification=${challenge}`]);
  await f.action('copy', { domainsRecord: '2', domainsField: 'value' }); await f.action('copy', { domainsRecord: '0', domainsField: 'challenge' }); assert.equal(copied.length, 1);
});

test('trocas de contexto invalidam formulário, abortam GET e descartam resposta antiga', async t => {
  const changes = { workspace: f => { f.state.workspaceId = 'other'; }, person: f => { f.state.boot.session.userId = 'other'; }, csrf: f => { f.state.boot.csrfToken = 'other'; }, sessionCsrf: f => { f.state.boot.session.csrfToken = 'other'; }, role: f => { f.state.boot.session.role = 'operator'; }, support: f => { f.state.supportGrantId = 'grant'; }, sessionSupport: f => { f.state.boot.session.supportGrantId = 'grant'; }, route: f => { f.state.view = 'inbox'; }, kind: f => { f.state.boot.reseller.accountKind = 'business'; }, owner: f => { f.state.boot.session.platformOwner = true; } };
  for (const [name, change] of Object.entries(changes)) await t.test(name, async child => {
    const waiting = deferred(), f = fixture(child, { intercept: () => waiting.promise });
    const reading = f.ui.open(account()), old = f.form('register', { host: 'chat.empresa.com.br' }); change(f); await f.ui.submit(old);
    assert.equal(f.calls[0].init.signal.aborted, true); waiting.resolve(dto({ binding: domain() })); await reading; assert.equal(f.modal.open, false); assert.equal(f.modal.html.includes('elozi-verification=aaaa'), false); assert.equal(f.writes().length, 0);
  });
});

test('atendente, serviço, suporte e conta fora do vínculo não consultam nem alteram domínio', async t => {
  for (const mode of ['role', 'service', 'support', 'outside']) await t.test(mode, async child => {
    const f = fixture(child); if (mode === 'role') f.state.boot.session.role = 'operator'; if (mode === 'service') f.state.boot.session.kind = 'service'; if (mode === 'support') f.state.supportGrantId = 'grant';
    assert.equal(await f.ui.open(account(mode === 'outside' ? { parentWorkspaceId: 'another' } : {})), false); await f.ui.submit(f.form('register', { host: 'chat.empresa.com.br' })); assert.equal(f.calls.length, 0);
  });
  const f = fixture(t); f.state.workspaceId = 'business-a'; f.state.boot.reseller.accountKind = 'business'; await f.ui.open(account()); assert.equal(f.calls.length, 1);
});

test('respostas de outra conta, DNS alterado, versão antiga e prova falsa não aparecem no modal', async t => {
  const bad = [dto({ workspaceId: 'another', binding: domain() }), dto({ version: 1 }), dto({ canConfirmDeployment: true }), dto({ binding: domain('verified', { verifiedAt: null }) }), dto({ binding: domain('active', { deployment: null }) }), dto({ binding: domain('pending', { records: [{ type: 'TXT', name: 'another', value: 'private-secret' }, { type: 'CNAME', name: 'another', value: 'internal' }] }) })];
  for (const value of bad) await t.test(JSON.stringify(value).slice(0, 45), async child => {
    const f = fixture(child, { intercept: () => value }); assert.equal(await f.ui.open(account()), false); assert.match(f.modal.html, /Não foi possível consultar/); assert.equal(f.modal.html.includes('private-secret'), false); assert.equal(f.modal.html.includes('data-domains-action="verify"'), false);
  });
});

test('token antigo e modal estrangeiro não escrevem; reset não fecha modal de outro componente', async t => {
  const f = fixture(t); await f.ui.open(account()); const form = f.form('register', { host: 'chat.empresa.com.br' }), old = f.node('verify');
  await f.action('refresh'); await f.ui.submit(form); await f.ui.action(old); assert.equal(f.writes().length, 0);
  f.modal.panel = null; f.modal.html = 'Outro componente'; f.ui.reset(); assert.equal(f.modal.open, true); assert.equal(f.modal.html, 'Outro componente');
});

test('GET mais recente vence e fechamento aborta leitura sem reabrir modal', async t => {
  const first = deferred(), second = deferred(); let count = 0;
  const f = fixture(t, { intercept: () => ++count === 1 ? first.promise : second.promise });
  const one = f.ui.open(account()), two = f.ui.open(account()); assert.equal(f.calls[0].init.signal.aborted, true);
  second.resolve(dto({ binding: domain() })); await two; const latest = f.modal.html; first.resolve(dto({ binding: domain('verified') })); await one; assert.equal(f.modal.html, latest);
  const third = deferred(); const g = fixture(t, { intercept: () => third.promise }); const reading = g.ui.open(account()); g.modal.close(); assert.equal(g.calls[0].init.signal.aborted, true); third.resolve(dto({ binding: domain() })); await reading; assert.equal(g.modal.open, false);
});

test('close enfileirado da conta não cancela domínio reaberto; fechamento atual ainda aborta GET', async t => {
  const first = deferred(), second = deferred(); let reads = 0;
  const f = fixture(t, { platform: true, initial: { binding: domain() }, intercept: (path, init, fallback) => (init.method || 'GET') === 'GET' ? ++reads === 1 ? first.promise : second.promise : fallback(path, init) });
  f.modal.open = true; f.modal.html = 'Detalhe de conta em outro componente'; f.modal.panel = null;
  const priorClose = f.modal.queueClose(), reading = f.ui.open(account());
  assert.equal(f.modal.open, true); assert.match(f.modal.html, /Consultando o domínio/); const openingSignal = f.calls[0].init.signal;
  await priorClose;
  assert.equal(f.modal.open, true); assert.equal(openingSignal.aborted, false, 'O evento antigo chega após a reabertura e não pode cancelar sua leitura.');
  first.resolve(dto({ canConfirmDeployment: true, binding: domain() })); assert.equal(await reading, true);
  assert.match(f.modal.html, /DNS pendente/); assert.equal(f.modal.html.includes('Consultando o domínio'), false); assert.equal(f.modal.error.textContent, '');
  await f.action('verify'); assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].path, '/api/accounts/business-a/domain/verify'); assert.match(f.modal.html, /Propriedade verificada/); assert.equal(f.updates.length, 1);
  const refreshing = f.action('refresh'), closingSignal = f.calls.at(-1).init.signal, opened = f.opened.length, currentClose = f.modal.queueClose();
  assert.equal(f.modal.open, false); await currentClose; assert.equal(closingSignal.aborted, true, 'Fechamento atual continua abortando a leitura.');
  second.resolve(dto({ version: 3, canConfirmDeployment: true, binding: domain('verified') })); await refreshing;
  assert.equal(f.modal.open, false); assert.equal(f.opened.length, opened); assert.equal(f.writes().length, 1); assert.equal(f.messages.some(message => message.failed), false);
});

test('duplo clique grava uma vez e resposta incerta só consulta GET inclusive ao reabrir', async t => {
  const waiting = deferred(); let writeCount = 0;
  const f = fixture(t, { intercept: (path, init, fallback) => { if (init.method === 'POST') { writeCount++; fallback(path, init); return waiting.promise; } return fallback(path, init); } });
  await f.ui.open(account()); const form = f.form('register', { host: 'chat.empresa.com.br' }); const saving = f.ui.submit(form); await f.ui.submit(form); await f.action('verify'); assert.equal(writeCount, 1); assert.equal(form.button.disabled, true);
  waiting.reject(new Error('Conexão interrompida')); await saving; assert.match(f.modal.html, /Resposta da alteração pendente/); assert.equal(form.button.disabled, false);
  await f.action('close'); await f.ui.open(account()); assert.match(f.modal.html, /Consultar resultado/); assert.equal(f.calls.filter(call => call.init.method === 'GET').length, 1);
  await f.action('reconcile'); assert.match(f.modal.html, /Estado atual consultado/); assert.match(f.modal.html, /DNS pendente/); assert.equal(writeCount, 1); assert.equal(f.updates.length, 1);
});

test('conflito CAS impede repetir gravação até consultar a nova revisão global da conta', async t => {
  let conflict = true;
  const f = fixture(t, { initial: { binding: domain() }, intercept: (path, init, fallback) => { if (init.method === 'POST' && conflict) { conflict = false; f.setData(dto({ version: 9, binding: domain() })); throw Object.assign(new Error('Outro editor alterou plano ou estado comercial.'), { status: 409 }); } return fallback(path, init); } });
  await f.ui.open(account()); await f.action('verify'); assert.match(f.modal.error.textContent, /A conta mudou/); await f.action('verify'); await f.action('remove-review'); await f.ui.submit(f.form('remove')); assert.equal(f.writes().length, 1); assert.equal(f.modal.html.includes('Confirmar remoção'), false);
  await f.action('refresh'); await f.action('verify'); assert.equal(f.writes().length, 2); assert.deepEqual(JSON.parse(f.writes()[1].init.body), { version: 9 });
});

test('revogação 403 fecha somente modal próprio e uma resposta tardia não atualiza outra pessoa', async t => {
  const f = fixture(t, { intercept: () => { throw Object.assign(new Error('Negado'), { status: 403 }); } }); await f.ui.open(account()); assert.equal(f.modal.open, false); assert.match(f.messages.at(-1).message, /Este acesso/);
  const waiting = deferred(), g = fixture(t, { intercept: (path, init, fallback) => init.method === 'POST' ? waiting.promise : fallback(path, init) }); await g.ui.open(account()); const saving = g.ui.submit(g.form('register', { host: 'chat.empresa.com.br' })); g.state.boot.session.userId = 'other'; g.ui.reset(); waiting.resolve(dto({ version: 3, binding: domain() })); await saving;
  assert.equal(g.modal.open, false); assert.equal(g.updates.length, 0); assert.equal(g.messages.length, 0);
});

test('resposta de gravação inválida e falha de reconciliação mantêm bloqueio, sem repetir POST', async t => {
  let reconcile = false;
  const f = fixture(t, { intercept: (path, init, fallback) => { if (init.method === 'POST') return dto({ workspaceId: 'another', version: 3, binding: domain() }); if (reconcile) throw new Error('Ainda indisponível'); return fallback(path, init); } }); await f.ui.open(account()); await f.ui.submit(f.form('register', { host: 'chat.empresa.com.br' })); assert.match(f.modal.html, /Resposta da alteração pendente/);
  reconcile = true; await f.action('reconcile'); assert.match(f.modal.html, /Consultar resultado/); await f.ui.submit(f.form('register', { host: 'chat.empresa.com.br' })); assert.equal(f.writes().length, 1);
});
