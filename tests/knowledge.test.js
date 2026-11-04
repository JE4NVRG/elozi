import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { KnowledgeBase, knowledgeHash, knowledgePassages, knowledgeTokens } from '../src/knowledge.js';

const admin = { role: 'reseller', resellerId: 'mep-demo', name: 'Conhecimento sintético' };
const status = code => error => error.status === code;
const grant = source => ({ sourceId: source.id, publicationVersion: source.published.version, publicationHash: source.published.hash });
function setup(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const tenant = store.createTenant(admin, { name: 'Conhecimento QA', segment: 'QA' }), agentId = randomUUID();
  store.mutate(admin, tenant.id, 'Agentes sintéticos', state => {
    state.agents = [{ id: agentId, name: 'Hermes QA', provider: 'hermes', version: 1 }, { id: 'claude', provider: 'claude', version: 1 }];
  });
  const service = new KnowledgeBase({ sync: store }), state = () => store.tenant(admin, tenant.id), agent = () => state().agents[0];
  return { store, tenant, agentId, service, state, agent, operator: { ...admin, role: 'operator', tenantId: tenant.id } };
}
const create = (c, input = {}) => c.service.create(admin, c.tenant.id, { title: 'Renovação de plano', category: 'Financeiro', content: 'A renovação do plano exige a confirmação do pagamento.', ...input });
const publish = (c, source) => c.service.publish(admin, c.tenant.id, source.id, { version: source.version });
const authorize = (c, sources) => c.service.setGrants(admin, c.tenant.id, c.agentId, { version: c.agent().version, grants: sources.map(grant) });
const retrieve = (c, query) => c.service.search(c.state(), c.agent(), query);

test('conhecimento mantém CAS, publicação imutável e listagem sem texto', t => {
  const c = setup(t), created = create(c), published = publish(c, created);
  assert.equal(created.version, 1); assert.equal(published.version, 2); assert.equal(published.publicationCounter, 1);
  assert.equal(published.published.hash, knowledgeHash(published.id, published.published));
  const snapshot = structuredClone(published.published);
  published.content = 'Retorno não persiste'; published.published.content = 'Retorno também não persiste';
  const edited = c.service.update(admin, c.tenant.id, created.id, { version: 2, title: 'Título de rascunho', content: 'Conteúdo ainda não publicado' });
  assert.deepEqual(edited.published, snapshot);
  const listed = c.service.list(admin, c.tenant.id);
  assert.equal(listed[0].draftChanged, true); assert.equal(listed[0].status, 'published'); assert.equal(listed[0].contentChars, edited.content.length);
  assert.equal(Object.hasOwn(listed[0], 'content'), false); assert.equal(Object.hasOwn(listed[0].published, 'content'), false);
  assert.equal(JSON.stringify(listed).includes('Conteúdo ainda não publicado'), false);
  assert.throws(() => c.service.update(admin, c.tenant.id, created.id, { version: 2, content: 'Concorrente' }), status(409));
  assert.equal(c.service.get(admin, c.tenant.id, created.id).version, 3);
});

test('republicação renova contador e hash mesmo sem editar, exigindo novo pin', t => {
  const c = setup(t), first = publish(c, create(c)); authorize(c, [first]);
  const run = { agentId: c.agentId, knowledgeSnapshot: c.service.snapshot(c.state(), c.agent()) };
  assert.equal(c.service.current(c.state(), run), true);
  const second = publish(c, first);
  assert.equal(second.published.version, 2); assert.notEqual(second.published.hash, first.published.hash);
  assert.equal(c.service.current(c.state(), run), false);
  assert.throws(() => retrieve(c, 'pagamento'), status(409));
  assert.throws(() => authorize(c, [first]), status(409));
  authorize(c, [second]); assert.equal(retrieve(c, 'pagamento').state, 'matched');
});

test('editar rascunho preserva referências da publicação e não recupera o texto novo', t => {
  const c = setup(t), published = publish(c, create(c, { content: 'Garantia aprovada dura noventa dias.' })); authorize(c, [published]);
  const run = { agentId: c.agentId, knowledgeSnapshot: c.service.snapshot(c.state(), c.agent()) };
  c.service.update(admin, c.tenant.id, published.id, { version: published.version, title: 'Segredo de rascunho', content: 'Promoção secreta com mil dias.' });
  assert.equal(c.service.current(c.state(), run), true);
  const found = retrieve(c, 'garantia'); assert.equal(found.state, 'matched');
  assert.equal(found.references[0].title, published.published.title); assert.equal(found.references[0].publicationHash, published.published.hash);
  assert.equal(retrieve(c, 'secreta').state, 'no_match'); assert.equal(JSON.stringify(found).includes('mil dias'), false);
});

test('arquivar revoga a publicação e reativar não restaura concessões antigas', t => {
  const c = setup(t), source = publish(c, create(c)); authorize(c, [source]);
  const run = { agentId: c.agentId, knowledgeSnapshot: c.service.snapshot(c.state(), c.agent()) };
  const archived = c.service.archive(admin, c.tenant.id, source.id, { version: source.version });
  assert.equal(archived.archived, true); assert.equal(archived.published, undefined); assert.equal(archived.content, source.content);
  assert.equal(c.service.list(admin, c.tenant.id).length, 0); assert.equal(c.service.list(admin, c.tenant.id, { includeArchived: true })[0].status, 'archived');
  assert.equal(c.service.current(c.state(), run), false);
  assert.throws(() => c.service.publish(admin, c.tenant.id, source.id, { version: archived.version }), status(409));
  assert.throws(() => c.service.update(admin, c.tenant.id, source.id, { version: archived.version, title: 'Editar arquivo' }), status(409));
  const reactivated = c.service.reactivate(admin, c.tenant.id, source.id, { version: archived.version });
  assert.equal(reactivated.archived, false); assert.equal(reactivated.published, undefined); assert.equal(reactivated.publicationCounter, 1);
  assert.equal(c.service.current(c.state(), run), false);
  const republished = publish(c, reactivated); assert.equal(republished.published.version, 2);
  assert.equal(c.service.current(c.state(), run), false);
  authorize(c, [republished]); assert.equal(retrieve(c, 'plano').state, 'matched');
});

test('despublicação revoga pins sem excluir fonte e usa CAS', t => {
  const c = setup(t), source = publish(c, create(c)); authorize(c, [source]);
  const run = { agentId: c.agentId, knowledgeSnapshot: c.service.snapshot(c.state(), c.agent()) };
  assert.throws(() => c.service.unpublish(admin, c.tenant.id, source.id, { version: 1 }), status(409));
  const removed = c.service.unpublish(admin, c.tenant.id, source.id, { version: source.version });
  assert.equal(removed.published, undefined); assert.equal(c.service.list(admin, c.tenant.id)[0].status, 'draft');
  assert.equal(c.service.current(c.state(), run), false);
  assert.equal(c.service.get(admin, c.tenant.id, source.id).content, source.content);
});

test('catálogo, texto e concessões ficam reservados à revenda da empresa', t => {
  const c = setup(t), source = publish(c, create(c)), otherTenant = c.store.createTenant(admin, { name: 'Outra QA', segment: 'QA' });
  const operatorCalls = [
    () => c.service.list(c.operator, c.tenant.id), () => c.service.get(c.operator, c.tenant.id, source.id),
    () => c.service.grants(c.operator, c.tenant.id, c.agentId), () => c.service.create(c.operator, c.tenant.id, {}),
    () => c.service.update(c.operator, c.tenant.id, source.id, {}), () => c.service.publish(c.operator, c.tenant.id, source.id, {}),
    () => c.service.unpublish(c.operator, c.tenant.id, source.id, {}), () => c.service.archive(c.operator, c.tenant.id, source.id, {}),
    () => c.service.reactivate(c.operator, c.tenant.id, source.id, {}), () => c.service.setGrants(c.operator, c.tenant.id, c.agentId, {})
  ];
  operatorCalls.forEach(call => assert.throws(call, status(403)));
  assert.throws(() => c.service.get(admin, otherTenant.id, source.id), status(404));
  const resellerId = `reseller_${randomUUID()}`, tenantId = `tenant_${randomUUID()}`;
  c.store.provisionReseller({ resellerId, tenantId, name: 'Revenda sintética separada' });
  const otherAdmin = { ...admin, resellerId };
  assert.throws(() => c.service.list(otherAdmin, c.tenant.id), status(404));
  assert.throws(() => c.service.get(otherAdmin, c.tenant.id, source.id), status(404));
  assert.throws(() => c.service.setGrants(otherAdmin, c.tenant.id, c.agentId, { version: 1, grants: [grant(source)] }), status(404));
  c.store.mutate(otherAdmin, tenantId, 'Agente sintético isolado', tenant => { tenant.agents = [{ id: c.agentId, provider: 'hermes', version: 1 }]; });
  assert.throws(() => c.service.setGrants(otherAdmin, tenantId, c.agentId, { version: 1, grants: [grant(source)] }), status(409));
  assert.deepEqual(c.service.search(c.store.tenant(otherAdmin, tenantId), { provider: 'hermes' }, 'plano'), { state: 'not_configured', references: [] });
});

test('concessões têm CAS de agente, deduplicação e somente Hermes', t => {
  const c = setup(t), source = publish(c, create(c));
  assert.deepEqual(c.service.grants(admin, c.tenant.id, c.agentId), { version: 1, grants: [] });
  const saved = c.service.setGrants(admin, c.tenant.id, c.agentId, { version: 1, grants: [grant(source), grant(source)] });
  assert.equal(saved.version, 2); assert.equal(saved.grants.length, 1);
  saved.grants[0].publicationHash = 'Retorno não persiste'; assert.equal(c.agent().knowledgeGrants[0].publicationHash, source.published.hash);
  assert.throws(() => c.service.setGrants(admin, c.tenant.id, c.agentId, { version: 1, grants: [] }), status(409));
  assert.throws(() => c.service.setGrants(admin, c.tenant.id, 'claude', { version: 1, grants: [grant(source)] }), status(400));
  assert.throws(() => c.service.setGrants(admin, c.tenant.id, 'missing', { version: 1, grants: [] }), status(404));
  assert.throws(() => c.service.setGrants(admin, c.tenant.id, c.agentId, { version: 2, grants: Array(17).fill(grant(source)) }), status(400));
  const run = { agentId: c.agentId, knowledgeSnapshot: c.service.snapshot(c.state(), c.agent()) };
  c.service.setGrants(admin, c.tenant.id, c.agentId, { version: 2, grants: [] }); assert.equal(c.service.current(c.state(), run), false);
});

test('pins exigem fonte ativa publicada, hash exato e mesma empresa', t => {
  const c = setup(t), draft = create(c), published = publish(c, create(c, { title: 'Outra fonte' }));
  const invalid = [
    { sourceId: draft.id, publicationVersion: 1, publicationHash: 'a'.repeat(64) },
    { ...grant(published), publicationHash: 'b'.repeat(64) }, { ...grant(published), publicationVersion: 2 },
    { ...grant(published), sourceId: randomUUID() }
  ];
  invalid.forEach(value => assert.throws(() => c.service.setGrants(admin, c.tenant.id, c.agentId, { version: 1, grants: [value] }), status(409)));
  const otherTenant = c.store.createTenant(admin, { name: 'Outra base QA', segment: 'QA' });
  c.store.mutate(admin, otherTenant.id, 'Agente da segunda empresa', state => { state.agents = [{ id: c.agentId, provider: 'hermes', version: 1 }]; });
  assert.throws(() => c.service.setGrants(admin, otherTenant.id, c.agentId, { version: 1, grants: [grant(published)] }), status(409));
  assert.equal(c.agent().version, 1); assert.equal(c.service.grants(admin, c.tenant.id, c.agentId).grants.length, 0);
});

test('validação rejeita campos desconhecidos, protótipos, controles e tipos errados', t => {
  const c = setup(t), valid = { title: 'QA', category: '', content: 'Texto QA' };
  const invalid = [null, [], Object.create(valid), { ...valid, hidden: true }, JSON.parse('{"title":"QA","content":"QA","__proto__":{}}'),
    { ...valid, title: 'QA\nlinha' }, { ...valid, category: 'QA\tlinha' }, { ...valid, content: 'QA\u0000' }, { ...valid, content: 'QA\u0085' },
    { ...valid, content: '\ud800' }, { ...valid, content: 7 }, { ...valid, title: '' }, { ...valid, content: '  ' }, { ...valid, title: 'x'.repeat(121) },
    { ...valid, category: 'x'.repeat(81) }, { ...valid, content: 'x'.repeat(20001) }];
  invalid.forEach(value => assert.throws(() => c.service.create(admin, c.tenant.id, value), status(400)));
  const accessor = { ...valid }; Object.defineProperty(accessor, 'title', { enumerable: true, get: () => 'Getter' });
  assert.throws(() => c.service.create(admin, c.tenant.id, accessor), status(400));
  const source = create(c, { content: 'Primeira linha.\r\n\r\nSegunda\tlinha.' });
  assert.equal(source.content, 'Primeira linha.\r\n\r\nSegunda\tlinha.');
  assert.throws(() => c.service.update(admin, c.tenant.id, source.id, { version: 1, archived: true }), status(400));
  assert.throws(() => c.service.publish(admin, c.tenant.id, source.id, { version: 1, title: 'Não permitido' }), status(400));
  assert.throws(() => c.service.list(admin, c.tenant.id, { includeArchived: 'sim' }), status(400));
  assert.equal(c.service.list(admin, c.tenant.id).length, 1);
});

test('revisões inválidas e overflow não alteram fonte ou agente', t => {
  const c = setup(t), source = create(c);
  for (const value of [undefined, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => c.service.update(admin, c.tenant.id, source.id, { version: value, title: 'Sem mudança' }), status(400));
    assert.throws(() => c.service.setGrants(admin, c.tenant.id, c.agentId, { version: value, grants: [] }), status(400));
  }
  c.store.mutate(admin, c.tenant.id, 'Overflow sintético', tenant => { tenant.knowledgeSources[0].version = Number.MAX_SAFE_INTEGER; });
  assert.throws(() => c.service.update(admin, c.tenant.id, source.id, { version: Number.MAX_SAFE_INTEGER, title: 'Sem mudança' }), status(409));
  assert.equal(c.service.get(admin, c.tenant.id, source.id).title, source.title);
  c.store.mutate(admin, c.tenant.id, 'Overflow do contador sintético', tenant => { tenant.knowledgeSources[0].version = 1; tenant.knowledgeSources[0].publicationCounter = Number.MAX_SAFE_INTEGER; });
  assert.throws(() => publish(c, source), status(409)); assert.equal(c.service.get(admin, c.tenant.id, source.id).published, undefined);
  c.store.mutate(admin, c.tenant.id, 'Overflow do agente sintético', tenant => { tenant.agents[0].version = Number.MAX_SAFE_INTEGER; });
  assert.throws(() => c.service.setGrants(admin, c.tenant.id, c.agentId, { version: Number.MAX_SAFE_INTEGER, grants: [] }), status(409));
});

test('limite de 50 fontes inclui arquivos e preserva estado em falha', t => {
  const c = setup(t); let first;
  for (let index = 0; index < 50; index++) { const source = create(c, { title: `Fonte ${index}` }); if (!first) first = source; }
  c.service.archive(admin, c.tenant.id, first.id, { version: 1 });
  assert.throws(() => create(c), status(400)); assert.equal(c.service.list(admin, c.tenant.id, { includeArchived: true }).length, 50);
});

test('quota de 2 MiB inclui texto publicado e rollback conserva rascunho', t => {
  const c = setup(t); let last;
  for (let index = 0; index < 18; index++) last = create(c, { title: `Unicode ${index}`, content: '漢'.repeat(20000) });
  for (let index = 0; index < 16; index++) publish(c, c.service.list(admin, c.tenant.id)[index]);
  const before = c.service.get(admin, c.tenant.id, last.id);
  assert.throws(() => publish(c, before), status(400));
  assert.deepEqual(c.service.get(admin, c.tenant.id, last.id), before);
  assert.ok(Buffer.byteLength(JSON.stringify(c.state().knowledgeSources)) <= 2 * 1024 * 1024);
});

test('consulta lexical é determinística, normaliza acentos e prioriza título e categoria', t => {
  const c = setup(t);
  const ordinary = publish(c, create(c, { title: 'Manual geral', category: 'Geral', content: 'A renovação segue o calendário de atendimento.' }));
  const titled = publish(c, create(c, { title: 'Renovação', category: 'Financeiro', content: 'A renovação segue o calendário de atendimento.' }));
  const categorized = publish(c, create(c, { title: 'Documentos', category: 'Renovação', content: 'O cliente confirma seus documentos cadastrais.' }));
  authorize(c, [ordinary, titled, categorized]);
  const result = retrieve(c, 'Como faço a RENOVACAO?'); assert.equal(result.state, 'matched');
  assert.equal(result.references[0].sourceId, titled.id); assert.equal(result.references[1].sourceId, categorized.id);
  assert.equal(result.references[2].sourceId, ordinary.id); assert.deepEqual(result, retrieve(c, 'Como faço a RENOVACAO?'));
  assert.equal(retrieve(c, 'cancelamento').state, 'no_match');
  assert.deepEqual(retrieve(c, 'como é para e você'), { state: 'no_match', references: [] });
});

test('recuperação usa parágrafos e encontra termo após texto longo', t => {
  const c = setup(t), source = publish(c, create(c, { title: 'Manual', category: '', content: `Introdução sem termos relevantes.\n\n${'Texto de contexto genérico. '.repeat(70)}\n\nA garantia contratual dura noventa dias.` }));
  authorize(c, [source]); const result = retrieve(c, 'garantia');
  assert.equal(result.references.length, 1); assert.equal(result.references[0].chunkId, 'p3-c1');
  assert.equal(result.references[0].excerpt, 'A garantia contratual dura noventa dias.');
  const long = publish(c, create(c, { title: 'Manual segundo', category: '', content: `${'Contexto genérico. '.repeat(100)}Garantia contratual válida.` }));
  authorize(c, [long]); const late = retrieve(c, 'garantia');
  assert.equal(late.state, 'matched'); assert.ok(late.references[0].excerpt.includes('Garantia contratual válida.'));
});

test('limites de referências, JSON UTF-8 e trechos preservam Unicode íntegro', t => {
  const c = setup(t), sources = [];
  for (let index = 0; index < 7; index++) sources.push(publish(c, create(c, { title: '漢'.repeat(120), category: '', content: `Garantia ${'😀'.repeat(395)}\n\nGarantia ${'漢'.repeat(792)}` })));
  authorize(c, sources); const result = retrieve(c, 'garantia');
  assert.equal(result.state, 'matched'); assert.ok(result.references.length > 0 && result.references.length <= 5);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  for (const reference of result.references) {
    assert.ok(reference.excerpt.length <= 800); assert.equal(reference.excerpt.isWellFormed(), true);
    const source = sources.find(item => item.id === reference.sourceId);
    assert.ok(source.published.content.includes(reference.excerpt)); assert.equal(reference.publicationHash, source.published.hash);
    assert.equal(reference.publicationVersion, source.published.version); assert.equal(reference.title, source.published.title);
  }
});

test('fontes não concedidas não entram na busca e ausência fica explícita', t => {
  const c = setup(t), granted = publish(c, create(c, { title: 'Garantia', content: 'Garantia contratual válida.' }));
  publish(c, create(c, { title: 'Promoção privada', content: 'Promoção privada com desconto reservado.' }));
  assert.deepEqual(retrieve(c, 'garantia'), { state: 'not_configured', references: [] });
  authorize(c, [granted]); assert.deepEqual(retrieve(c, 'promoção'), { state: 'no_match', references: [] });
  assert.deepEqual(retrieve(c, ''), { state: 'no_match', references: [] });
  assert.throws(() => retrieve(c, 'x'.repeat(1301)), status(400)); assert.throws(() => retrieve(c, null), status(400));
  assert.throws(() => retrieve(c, 'garantia\u0001'), status(400));
  assert.equal(retrieve(c, 'x'.repeat(1300)).state, 'no_match');
});

test('snapshot é cópia mínima e recibos antigos sem snapshot permanecem válidos', t => {
  const c = setup(t), source = publish(c, create(c)); authorize(c, [source]);
  const snapshot = c.service.snapshot(c.state(), c.agent()); assert.deepEqual(snapshot, [grant(source)]);
  snapshot[0].publicationHash = 'c'.repeat(64); assert.equal(c.agent().knowledgeGrants[0].publicationHash, source.published.hash);
  assert.equal(c.service.current(c.state(), {}), true); assert.equal(c.service.current(c.state(), { knowledgeSnapshot: [] }), true);
  assert.equal(c.service.current(c.state(), { knowledgeSnapshot: null }), false);
  assert.equal(c.service.current(c.state(), { agentId: c.agentId, knowledgeSnapshot: snapshot }), false);
  assert.equal(c.service.current(c.state(), { agentId: 'missing', knowledgeSnapshot: [grant(source)] }), false);
});

test('alterar publicação sem hash válido invalida pin e impede referência corrompida', t => {
  const c = setup(t), source = publish(c, create(c)); authorize(c, [source]);
  const run = { agentId: c.agentId, knowledgeSnapshot: c.service.snapshot(c.state(), c.agent()) };
  c.store.mutate(admin, c.tenant.id, 'Corrupção sintética do snapshot', tenant => { tenant.knowledgeSources[0].published.content = 'Publicação alterada fora do contrato.'; });
  assert.equal(c.service.current(c.state(), run), false); assert.throws(() => c.service.snapshot(c.state(), c.agent()), status(409));
  assert.throws(() => retrieve(c, 'contrato'), status(409));
});

test('concessões rejeitam formato inválido e campos extras sem mudar agente', t => {
  const c = setup(t), source = publish(c, create(c)), valid = grant(source);
  const invalid = [null, [], Object.create(valid), { ...valid, content: 'Texto injetado' }, { ...valid, publicationVersion: 0 },
    { ...valid, publicationVersion: '1' }, { ...valid, publicationHash: 'hash' }, { ...valid, sourceId: '\u0000' }];
  invalid.forEach(value => assert.throws(() => c.service.setGrants(admin, c.tenant.id, c.agentId, { version: 1, grants: [value] }), status(400)));
  assert.throws(() => c.service.setGrants(admin, c.tenant.id, c.agentId, { version: 1, grants: [valid], unknown: true }), status(400));
  assert.deepEqual(c.service.grants(admin, c.tenant.id, c.agentId), { version: 1, grants: [] });
});

test('redução pelo orçamento UTF-8 conserva o termo relevante no trecho final', t => {
  const c = setup(t), sources = [];
  for (let index = 0; index < 5; index++) sources.push(publish(c, create(c, { title: '漢'.repeat(120), category: '', content: `${'漢 '.repeat(390)}garantia válida.` })));
  authorize(c, sources); const result = retrieve(c, 'garantia');
  assert.equal(result.state, 'matched'); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  assert.ok(result.references.length >= 2);
  result.references.forEach(reference => assert.ok(reference.excerpt.includes('garantia')));
});

test('stemming leve casa plurais e derivações em português e inglês', t => {
  assert.deepEqual(knowledgeTokens('preço preços'), ['preco', 'preco']);
  assert.deepEqual(new Set(knowledgeTokens('cancelamento cancelar cancelado cancellation cancelled')), new Set(['cancel']));
  assert.deepEqual(new Set(knowledgeTokens('configurações configuração configurar configure configured configuring')), new Set(['configur']));
  assert.deepEqual(knowledgeTokens('mensagem mensagens canal canais disponível disponíveis botões'), ['mensagen', 'mensagen', 'canal', 'canal', 'disponivel', 'disponivel', 'botao']);
  assert.deepEqual(knowledgeTokens('rapidamente policies policy shipping shipped ships'), ['rapida', 'polici', 'polici', 'ship', 'ship', 'ship']);
  assert.deepEqual(knowledgeTokens('status país países 2026 v2'), ['status', 'pais', 'pais', '2026', 'v2']);
  assert.deepEqual(knowledgeTokens('What is the price of this, and how do I get it?'), ['pric']);
  const c = setup(t), source = publish(c, create(c, { title: 'Tabela comercial', category: '', content: 'O preço do plano anual inclui o cancelamento sem multa.' }));
  const english = publish(c, create(c, { title: 'Pricing', category: '', content: 'Prices are listed per month and refunds take seven days.' }));
  authorize(c, [source, english]);
  assert.equal(retrieve(c, 'preços').references[0].sourceId, source.id);
  assert.equal(retrieve(c, 'Quero cancelar').references[0].sourceId, source.id);
  assert.equal(retrieve(c, 'Quais são os preços para cancelar?').references[0].sourceId, source.id);
  const refund = retrieve(c, 'refund price'); assert.equal(refund.state, 'matched'); assert.equal(refund.references[0].sourceId, english.id);
});

test('stopwords em inglês não geram correspondência', t => {
  const c = setup(t), source = publish(c, create(c, { title: 'Device policy', category: '', content: 'The warranty covers the device for ninety days.' })); authorize(c, [source]);
  assert.deepEqual(retrieve(c, 'What is the price of this?'), { state: 'no_match', references: [] });
  assert.deepEqual(retrieve(c, 'Is it for the one you have?'), { state: 'no_match', references: [] });
  const found = retrieve(c, 'Does the warranty cover the device?'); assert.equal(found.state, 'matched'); assert.equal(found.references[0].sourceId, source.id);
});

test('BM25 prioriza termo raro sobre termo comum, de forma determinística', t => {
  const c = setup(t), sources = [
    'O plano inclui suporte por email.', 'O plano aceita boleto bancário.', 'O plano anual inclui suporte prioritário.', 'Suporte do plano empresarial por telefone.'
  ].map((content, index) => publish(c, create(c, { title: `Fonte ${['um', 'dois', 'três', 'quatro'][index]}`, category: '', content })));
  authorize(c, sources);
  const result = retrieve(c, 'plano suporte boleto');
  assert.equal(result.state, 'matched'); assert.equal(result.references.length, 4);
  assert.equal(result.references[0].sourceId, sources[1].id);
  result.references.forEach((reference, index) => { assert.ok(Number.isFinite(reference.score) && reference.score > 0); if (index) assert.ok(reference.score <= result.references[index - 1].score); });
  assert.deepEqual(retrieve(c, 'plano suporte boleto'), result);
});

test('limiar de relevância ignora palavra comum isolada sem bloquear o assunto do cliente', t => {
  const c = setup(t), sources = [
    { title: 'Plano mensal', content: 'O plano mensal custa noventa reais.' },
    { title: 'Plano anual', content: 'O plano anual tem desconto de dez por cento.' },
    { title: 'Encerramento', content: 'O cancelamento do plano pode ser feito em sete dias.' }
  ].map(input => publish(c, create(c, { ...input, category: '' })));
  authorize(c, sources);
  assert.deepEqual(retrieve(c, 'Qual o horário do plano?'), { state: 'no_match', references: [] });
  assert.deepEqual(retrieve(c, 'Qual o horário de atendimento do plano?'), { state: 'no_match', references: [] });
  assert.equal(retrieve(c, 'plano').references.length, 3);
  const specific = retrieve(c, 'horário de cancelamento'); assert.deepEqual(specific.references.map(reference => reference.sourceId), [sources[2].id]);
  // Context words in a natural question do not hide its single specific subject.
  for (const question of ['horário de atendimento para cancelamento', 'Comprei ontem e queria entender o cancelamento']) {
    assert.deepEqual(retrieve(c, question).references.map(reference => reference.sourceId), [sources[2].id], question);
  }
  const covered = retrieve(c, 'cancelamento do plano anual').references.map(reference => reference.sourceId);
  assert.deepEqual(new Set(covered), new Set([sources[1].id, sources[2].id]));
  const single = setup(t), product = publish(single, create(single, { title: 'Acesso Elozi', category: '', content: 'Para configurar o acesso à Elozi, abra Configurações e escolha o canal de webchat.' }));
  authorize(single, [product]);
  assert.equal(retrieve(single, 'Como configurar o acesso?').state, 'matched');
  // One source cannot tell which words are common: the product guard is explicit, not statistical.
  assert.equal(retrieve(single, 'Como faço login na Elozi?').state, 'matched');
  const generic = { generic: ['Elozi'] }, guarded = (query, base = single) => base.service.search(base.state(), base.agent(), query, generic);
  assert.deepEqual(guarded('Como faço login na Elozi?'), { state: 'no_match', references: [] });
  assert.deepEqual(guarded('Elozi?'), { state: 'no_match', references: [] });
  assert.equal(guarded('Como configurar a Elozi?').references[0].sourceId, product.id);
  const wide = setup(t), sourcesWide = [{ title: 'Acesso Elozi', content: 'Para configurar o acesso à Elozi, abra Configurações.' },
    { title: 'Pagamentos', content: 'Aceitamos pix, boleto e cartão de crédito.' }, { title: 'Entrega', content: 'A entrega leva cinco dias úteis.' }]
    .map(input => publish(wide, create(wide, { ...input, category: '' })));
  authorize(wide, sourcesWide);
  assert.equal(retrieve(wide, 'Como faço login na Elozi?').state, 'matched');
  assert.deepEqual(guarded('Como faço login na Elozi?', wide), { state: 'no_match', references: [] });
  for (const options of [null, [], { generic: 'Elozi' }, { generic: [1] }, { generic: Array(17).fill('Elozi') }, { other: [] }]) {
    assert.throws(() => single.service.search(single.state(), single.agent(), 'acesso', options), TypeError);
  }
});

test('assunto de uma fonte longa no título continua discriminativo e pergunta natural de uma fonte casa', t => {
  const c = setup(t), manual = Array.from({ length: 12 }, (_, index) => `Etapa ${index + 1}: envie o aparelho com nota fiscal e embalagem original para análise técnica.`).join('\n\n');
  const sources = [{ title: 'Garantia', content: manual }, { title: 'Pagamentos', content: 'Aceitamos pix, boleto e cartão de crédito.' },
    { title: 'Entrega', content: 'A entrega leva cinco dias úteis.' }].map(input => publish(c, create(c, { ...input, category: '' })));
  authorize(c, sources);
  for (const question of ['garantia do celular', 'Comprei ontem, como funciona a garantia?', 'Oi, boa tarde! Comprei ontem e queria entender a garantia']) {
    const result = retrieve(c, question); assert.equal(result.state, 'matched', question); assert.equal(result.references[0].sourceId, sources[0].id, question);
  }
  const single = setup(t), payment = publish(single, create(single, { title: 'Formas de pagamento', category: '', content: 'Aceitamos pix, boleto e cartão de crédito.' }));
  authorize(single, [payment]);
  for (const question of ['Vocês aceitam pix?', 'Aceita pix?']) assert.equal(retrieve(single, question).references[0]?.sourceId, payment.id, question);
});

test('cabeçalho curto junta-se ao corpo, mas entradas de FAQ não somam termos entre si', t => {
  const faq = 'Horário\n\nAtendemos de segunda a sexta, das 8h às 18h.\n\nCancelamento:\n\nO cancelamento é feito pelo aplicativo.';
  assert.deepEqual(knowledgePassages(faq).map(passage => [passage.chunkId, faq.slice(passage.start, passage.end)]), [
    ['p1-p2-c1', 'Horário\n\nAtendemos de segunda a sexta, das 8h às 18h.'], ['p3-p4-c1', 'Cancelamento:\n\nO cancelamento é feito pelo aplicativo.']]);
  assert.deepEqual(knowledgePassages('Primeira resposta curta.\n\nSegunda resposta curta.').map(passage => passage.chunkId), ['p1-c1', 'p2-c1']);
  const c = setup(t), source = publish(c, create(c, { title: 'FAQ', category: '', content: faq })); authorize(c, [source]);
  assert.deepEqual(retrieve(c, 'cancelamento').references.map(reference => reference.chunkId), ['p3-p4-c1']);
});

test('termos de produto pro e AI não são stopwords', t => {
  assert.deepEqual(knowledgeTokens('Quanto custa o plano Pro?'), ['custa', 'plano', 'pro']);
  assert.deepEqual(knowledgeTokens('How does the AI work?'), ['ai', 'work']);
  const c = setup(t), sources = [{ title: 'Plano Basic', content: 'O plano Basic custa cinquenta reais.' }, { title: 'Plano Pro', content: 'O plano Pro custa cem reais.' }]
    .map(input => publish(c, create(c, { ...input, category: '' })));
  authorize(c, sources);
  assert.equal(retrieve(c, 'Quanto custa o plano Pro?').references[0].sourceId, sources[1].id);
});

test('trechos sobrepostos de ~700 caracteres focam o excerpt e agrupam títulos curtos', t => {
  const c = setup(t), sentence = 'O prazo de reembolso integral é de sete dias corridos após a entrega.';
  const filler = 'Texto introdutório sobre a operação diária da loja. ', paragraph = `${filler.repeat(13)}${sentence} ${filler.repeat(15)}`.trim();
  const long = publish(c, create(c, { title: 'Manual da loja', category: '', content: paragraph }));
  const faq = publish(c, create(c, { title: 'Perguntas', category: '', content: `Estorno\n\nO estorno é feito no cartão em até sete dias.\n\n${'Informação genérica sem termo. '.repeat(30)}` }));
  authorize(c, [long, faq]);
  const result = retrieve(c, 'prazo de reembolso integral');
  assert.equal(result.references[0].sourceId, long.id); assert.equal(result.references[0].chunkId, 'p1-c2');
  assert.ok(result.references[0].excerpt.includes(sentence)); assert.ok(result.references[0].excerpt.length <= 700);
  assert.ok(paragraph.includes(result.references[0].excerpt)); assert.ok(!result.references[0].excerpt.startsWith(filler));
  const packed = retrieve(c, 'estorno');
  assert.equal(packed.references[0].chunkId, 'p1-p2-c1'); assert.equal(packed.references[0].excerpt, 'Estorno\n\nO estorno é feito no cartão em até sete dias.');
});

test('fonte longa respeita 5 referências, 8 KiB, ids únicos e trechos exatos', t => {
  const c = setup(t), content = Array.from({ length: 330 }, (_, index) => `A garantia cobre defeito número ${index}.`).join(' ').slice(0, 20000);
  const source = publish(c, create(c, { title: 'Garantia estendida', category: 'Pós-venda', content })); authorize(c, [source]);
  const result = retrieve(c, 'garantia');
  assert.equal(result.state, 'matched'); assert.equal(result.references.length, 5); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8192);
  assert.equal(new Set(result.references.map(reference => reference.chunkId)).size, 5);
  result.references.forEach((reference, index) => {
    assert.ok(reference.excerpt.length <= 700 && content.includes(reference.excerpt) && reference.excerpt.includes('garantia'));
    if (index) assert.ok(reference.score <= result.references[index - 1].score);
  });
});

test('IDF considera somente as fontes autorizadas ao agente nesta busca', t => {
  const c = setup(t), first = publish(c, create(c, { title: 'Fonte A', category: '', content: 'O boleto vence no dia dez.' }));
  const second = publish(c, create(c, { title: 'Fonte B', category: '', content: 'O cartão aceita parcelamento.' }));
  authorize(c, [first, second]); const before = retrieve(c, 'boleto');
  const hidden = publish(c, create(c, { title: 'Fonte C', category: '', content: 'Boleto bancário com desconto.' }));
  assert.deepEqual(retrieve(c, 'boleto'), before);
  const otherAgent = { id: 'other-hermes', provider: 'hermes', knowledgeGrants: [grant(hidden)] };
  assert.deepEqual(c.service.search(c.state(), otherAgent, 'boleto').references.map(reference => reference.sourceId), [hidden.id]);
  authorize(c, [first, second, hidden]); const after = retrieve(c, 'boleto');
  assert.ok(after.references.find(reference => reference.sourceId === first.id).score < before.references[0].score);
});

test('cache LRU reutiliza passagens tokenizadas pelo hash da publicação', t => {
  const c = setup(t), source = publish(c, create(c)); authorize(c, [source]);
  const cache = c.service.passageCache; retrieve(c, 'pagamento');
  assert.equal(cache.size, 1); const { hits, misses } = cache;
  retrieve(c, 'plano'); assert.equal(cache.misses, misses); assert.equal(cache.hits, hits + 1);
  const republished = publish(c, source); authorize(c, [republished]); retrieve(c, 'plano');
  assert.equal(cache.misses, misses + 1); assert.equal(cache.size, 2);
  const sources = [republished, publish(c, create(c, { title: 'Plano dois' })), publish(c, create(c, { title: 'Plano três' }))]; authorize(c, sources);
  const bounded = new KnowledgeBase({ sync: c.store }, { cacheEntries: 2 });
  assert.equal(bounded.search(c.state(), c.agent(), 'plano').references.length, 3); assert.equal(bounded.passageCache.size, 2);
  assert.deepEqual(bounded.search(c.state(), c.agent(), 'plano'), retrieve(c, 'plano'));
  assert.throws(() => new KnowledgeBase({ sync: c.store }, { cacheEntries: 0 }), TypeError);
});
