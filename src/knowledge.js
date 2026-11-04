import { createHash, randomUUID } from 'node:crypto';
import { fail } from './store.js';
import { allowedFields } from './access.js';
import { assertTelegramAccountAiAllowed, telegramAccountAiAllowed } from './telegram-account-policy.js';

const clone = structuredClone, now = () => new Date().toISOString();
const MAX_SOURCES = 50, MAX_JSON_BYTES = 2 * 1024 * 1024, MAX_CONTENT_BYTES = 64 * 1024;
const MAX_REFERENCES = 5, MAX_REFERENCE_BYTES = 8 * 1024, MAX_EXCERPT_CHARS = 800;
// A short heading joins the next paragraph (up to ~700 characters); longer paragraphs become overlapping windows cut at whitespace.
const PASSAGE_CHARS = 700, PASSAGE_OVERLAP = 150, PASSAGE_MIN_BREAK = 350;
// BM25 over the authorized passages, plus fixed boosts for the published title and the current category.
const BM25_K1 = 1.2, BM25_B = 0.75, TITLE_BOOST = 3, CATEGORY_BOOST = 2;
const forbiddenControls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const stopwords = new Set([
  // Português (sem acentos), incluindo fórmulas de pergunta que não identificam o assunto.
  ...('a ao aos aquela aquelas aquele aqueles aquilo as ate com como da das de dela delas dele deles depois do dos e ela elas ele eles em entre era eram essa essas esse esses esta estas este estes eu foi foram ha isso isto ja mais mas me mesmo meu meus minha minhas muito na nas nao no nos nossa nossas nosso nossos num numa o os ou para pela pelas pelo pelos por qual quando que quem se sem seu seus sua suas sao ser so sobre sua suas tambem te tem temos ter tu um uma umas uns voce voces'
    + ' ainda algo alguem algum alguma algumas alguns antes apenas apos aqui assim boa bom cada coisa consigo demais dessa desse desta deste disso disto dum duma entao estao estava estou faco faz fazer favor funciona funcionam funcionar gostaria jamais la lhe lhes mim muita muitas muitos nada nem nessa nesse nesta neste nisso nunca obrigada obrigado oi ola onde outra outras outro outros pode podem poderia pois porque posso pouco pra preciso quais qualquer quanta quantas quanto quantos queria quero saber seja sejam sera seria sim sido somente somos sou tal tenho toda todas todo todos tudo vai valeu vamos vou').split(' '),
  // English.
  ...'about above after again against all also am an and any are aren at be because been before being below between both but by can cannot could couldn did didn do does doesn doing don down during each few for from further get got had hadn has hasn have haven having he her here hers herself hi hello hey him himself his how if im in into is isn it its itself just know let ll more most my myself need no nor not now of off ok okay on once only or other our ours ourselves out over own please re same shall she should shouldn some such tell than thank thanks that the their theirs them themselves then there these they this those through to too under until up us ve very want was wasn we were weren what when where which while who whom why will with won would wouldn yes you your yours yourself yourselves'.split(' ')
]);
// Light PT/EN stemmer: deterministic suffix rules with minimum stem lengths, at most one rule per stage.
const invariant = new Set('alias atlas bonus campus canvas focus gratis lapis onus pais plus status tenis virus'.split(' '));
const pluralRules = [['coes', 'cao', 1], ['oes', 'ao', 1], ['ais', 'al', 2], ['eis', 'el', 2], ['ois', 'ol', 2], ['uis', 'ul', 2], ['ies', 'i', 2]];
const derivationRules = [['mente', '', 4], ['amento', '', 3], ['imento', '', 3], ['mento', '', 4], ['ation', '', 3], ['acao', '', 3], ['icao', '', 3], ['cao', '', 3],
  ['ando', '', 3], ['endo', '', 3], ['indo', '', 3], ['ing', '', 3], ['ado', '', 3], ['ada', '', 3], ['ido', '', 3], ['ida', '', 3], ['ed', '', 3], ['ly', '', 4], ['ar', '', 3], ['er', '', 3], ['ir', '', 3]];

function fields(input, names) {
  allowedFields(input, names);
  if (Object.values(Object.getOwnPropertyDescriptors(input)).some(property => !Object.hasOwn(property, 'value'))) fail(400, 'Informe somente campos de dados.');
}
function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'Informe a versão atual.');
}
function increment(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) fail(409, 'O limite de versões foi atingido.');
  return value + 1;
}
function string(value, limit, label, { optional = false, multiline = false } = {}) {
  if (typeof value !== 'string' || !value.isWellFormed() || value.length > limit || forbiddenControls.test(value)
      || !multiline && /[\t\r\n]/u.test(value) || !optional && !value.trim()) fail(400, `${label} inválido ou acima do limite de ${limit} caracteres.`);
  return multiline ? value : value.trim();
}
function content(value) {
  const result = string(value, 20000, 'Conteúdo', { multiline: true });
  if (Buffer.byteLength(result) > MAX_CONTENT_BYTES) fail(400, 'O conteúdo excedeu 64 KiB.');
  return result;
}
function quota(sources) {
  if (!Array.isArray(sources) || sources.length > MAX_SOURCES || Buffer.byteLength(JSON.stringify(sources)) > MAX_JSON_BYTES) fail(400, 'Limite da base de conhecimento atingido (50 fontes ou 2 MiB).');
}
function findSource(tenant, id) {
  const source = (tenant.knowledgeSources || []).find(item => item.id === id);
  if (!source) fail(404, 'Fonte não encontrada nesta empresa.');
  return source;
}
function findAgent(tenant, id) {
  const agent = (tenant.agents || []).find(item => item.id === id);
  if (!agent) fail(404, 'Agente não encontrado nesta empresa.');
  return agent;
}
function expected(source, revision, { archived = false } = {}) {
  if (source.version !== revision) fail(409, 'A fonte mudou. Atualize antes de continuar.');
  if (!archived && source.archived) fail(409, 'A fonte está arquivada.');
  return increment(source.version);
}
function grantFields(grant) {
  fields(grant, ['sourceId', 'publicationVersion', 'publicationHash']);
  if (typeof grant.sourceId !== 'string' || !grant.sourceId || grant.sourceId.length > 120 || /[\u0000-\u001f\u007f-\u009f]/u.test(grant.sourceId)) fail(400, 'Identidade da fonte inválida.');
  version(grant.publicationVersion);
  if (typeof grant.publicationHash !== 'string' || !/^[0-9a-f]{64}$/u.test(grant.publicationHash)) fail(400, 'Hash da publicação inválido.');
}

/** Identity and publication revision are hashed along with the immutable text. */
export function knowledgeHash(sourceId, publication) {
  return createHash('sha256').update(JSON.stringify({ sourceId, version: publication.version, title: publication.title, content: publication.content })).digest('hex');
}
function selectedSource(tenant, grant) {
  if (!grant || typeof grant !== 'object') return null;
  const source = (tenant.knowledgeSources || []).find(item => item.id === grant.sourceId), published = source?.published;
  if (source?.archived || !published || !Number.isSafeInteger(published.version) || published.version < 1
      || published.version !== grant.publicationVersion || published.hash !== grant.publicationHash
      || typeof published.title !== 'string' || typeof published.content !== 'string' || knowledgeHash(source.id, published) !== published.hash) return null;
  return source;
}
const sameGrant = (left, right) => Boolean(left && right && left.sourceId === right.sourceId && left.publicationVersion === right.publicationVersion && left.publicationHash === right.publicationHash);
function suffix(word, rules) {
  for (const [ending, replacement, minimum] of rules) if (word.endsWith(ending) && word.length - ending.length >= minimum) return word.slice(0, -ending.length) + replacement;
  return null;
}
/** preços→preco, configurações/configurar/configured→configur, cancelamento/cancelar/cancelled→cancel, mensagens→mensagen. */
export function knowledgeStem(word) {
  if (word.length < 3 || /\p{N}/u.test(word) || invariant.has(word)) return word;
  let result = suffix(word, pluralRules) ?? (word.length >= 5 && /[b-df-hj-np-tv-z]es$/u.test(word) ? word.slice(0, -2) : null)
    ?? (word.length >= 4 && /[^s]s$/u.test(word) ? word.slice(0, -1) : word);
  result = suffix(result, derivationRules) ?? result;
  if (result.length >= 4 && result.endsWith('e')) result = result.slice(0, -1);
  result = result.replace(/([eiou])m$/u, '$1n');
  if (result.endsWith('y')) result = `${result.slice(0, -1)}i`;
  return result.length >= 4 && /([b-df-hj-np-tv-z])\1$/u.test(result) ? result.slice(0, -1) : result;
}
/** NFKD, no marks, lowercase, PT/EN stopwords removed before stemming. */
export function knowledgeTokens(value) {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR').match(/[\p{L}\p{N}]+/gu)?.filter(word => word.length > 1 && !stopwords.has(word)).map(knowledgeStem) || [];
}
const tokens = knowledgeTokens;
/** Internal callers may name generic terms (support product names): they still rank, but never qualify a passage. */
function genericTerms(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'generic')
      || options.generic !== undefined && (!Array.isArray(options.generic) || options.generic.length > 16
        || options.generic.some(value => typeof value !== 'string' || value.length > 120 || !value.isWellFormed()))) throw new TypeError('Opções da busca de conhecimento inválidas.');
  return new Set((options.generic || []).flatMap(value => tokens(value)));
}
function prefix(value, maxChars, maxJsonBytes = Infinity) {
  let result = '', bytes = 0;
  for (const character of value) {
    const cost = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (result.length + character.length > maxChars || bytes + cost > maxJsonBytes) break;
    result += character; bytes += cost;
  }
  return result;
}
const space = character => character !== undefined && /\s/u.test(character);
// Never cut between the two halves of a surrogate pair; content is validated as well-formed.
const safe = (value, index) => { const code = value.charCodeAt(index - 1); return index > 0 && index < value.length && code >= 0xd800 && code <= 0xdbff ? index - 1 : index; };
function windows(value, start, end) {
  const result = [];
  while (end - start > PASSAGE_CHARS) {
    let cut = safe(value, start + PASSAGE_CHARS), last;
    if (!space(value[cut])) for (let index = cut - 1; index >= start + PASSAGE_MIN_BREAK; index--) if (space(value[index])) { cut = index; break; }
    for (last = cut; last > start && space(value[last - 1]); last--);
    result.push([start, last]);
    let next = safe(value, cut - PASSAGE_OVERLAP);
    if (!space(value[next - 1])) { let index = next; while (index < cut && !space(value[index])) index++; if (index < cut) next = index; }
    while (next < end && space(value[next])) next++;
    start = Math.max(next, start + 1);
  }
  if (start < end) result.push([start, end]);
  return result;
}
// One line, up to 120 characters, without final punctuation: "Estorno", "Horário:", "2. Cancelamento".
const heading = text => text.length <= 120 && !/[\r\n]/u.test(text) && !/[.!?…;]$/u.test(text);
/**
 * Offsets into the published text: excerpts are always exact substrings of the pinned publication.
 * Headings join the following paragraph; body paragraphs never share a passage, so FAQ entries stay apart.
 */
export function knowledgePassages(value) {
  const result = [], separator = /\r?\n[\t ]*\r?\n+/gu;
  let group = null, start = 0, paragraph = 0;
  const flush = () => {
    if (group) result.push({ chunkId: group.first === group.last ? `p${group.first}-c1` : `p${group.first}-p${group.last}-c1`, start: group.start, end: group.end });
    group = null;
  };
  for (const match of [...value.matchAll(separator), { index: value.length, 0: '' }]) {
    const raw = value.slice(start, match.index), text = raw.trim(), from = start + raw.length - raw.trimStart().length, to = from + text.length;
    start = match.index + match[0].length; paragraph++;
    if (!text) continue;
    if (text.length > PASSAGE_CHARS) { flush(); windows(value, from, to).forEach(([begin, end], index) => result.push({ chunkId: `p${paragraph}-c${index + 1}`, start: begin, end })); continue; }
    if (group?.open && to - group.start <= PASSAGE_CHARS) { Object.assign(group, { end: to, last: paragraph, open: heading(text) }); continue; }
    flush(); group = { first: paragraph, last: paragraph, start: from, end: to, open: heading(text) };
  }
  flush();
  return result;
}
/** Bounded LRU of tokenized passages, keyed by the verified publication hash; excerpts are sliced from current state. */
class PassageCache {
  constructor(maxEntries, maxChars) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || !Number.isSafeInteger(maxChars) || maxChars < 1) throw new TypeError('Cache da base de conhecimento inválido.');
    Object.assign(this, { maxEntries, maxChars, chars: 0, hits: 0, misses: 0, entries: new Map() });
  }
  get size() { return this.entries.size; }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) { this.misses++; return null; }
    this.entries.delete(key); this.entries.set(key, entry); this.hits++; return entry.value;
  }
  set(key, value, weight) {
    const previous = this.entries.get(key);
    if (previous) { this.entries.delete(key); this.chars -= previous.weight; }
    this.entries.set(key, { value, weight }); this.chars += weight;
    for (const [oldest, entry] of this.entries) {
      if (this.entries.size === 1 || this.entries.size <= this.maxEntries && this.chars <= this.maxChars) break;
      this.entries.delete(oldest); this.chars -= entry.weight;
    }
  }
}

/** Drafts stay administrative; runtime retrieval sees only explicitly pinned publications. */
export class KnowledgeBase {
  constructor(store, { cacheEntries = 256, cacheChars = 1_000_000 } = {}) { this.store = store.sync ?? store; this.passageCache = new PassageCache(cacheEntries, cacheChars); }
  #index(published) {
    const cached = this.passageCache.get(published.hash);
    if (cached) return cached;
    const index = { title: new Set(tokens(published.title)), passages: knowledgePassages(published.content).map(passage => {
      const words = tokens(published.content.slice(passage.start, passage.end)), terms = new Map();
      for (const word of words) terms.set(word, (terms.get(word) || 0) + 1);
      return Object.freeze({ ...passage, length: words.length, terms });
    }) };
    this.passageCache.set(published.hash, Object.freeze(index), published.content.length + published.title.length);
    return index;
  }
  list(actor, tenantId, options = {}) {
    this.store.admin(actor); fields(options, ['includeArchived']);
    if (options.includeArchived !== undefined && typeof options.includeArchived !== 'boolean') fail(400, 'Informe um filtro de arquivo válido.');
    return (this.store.tenant(actor, tenantId).knowledgeSources || []).filter(source => options.includeArchived || !source.archived).map(source => ({
      id: source.id, title: source.title, category: source.category, version: source.version, archived: source.archived,
      status: source.archived ? 'archived' : source.published ? 'published' : 'draft',
      draftChanged: Boolean(source.published && (source.title !== source.published.title || source.content !== source.published.content)), contentChars: source.content.length,
      ...(source.published ? { published: { version: source.published.version, title: source.published.title, hash: source.published.hash, publishedAt: source.published.publishedAt } } : {})
    }));
  }
  get(actor, tenantId, sourceId) { this.store.admin(actor); return clone(findSource(this.store.tenant(actor, tenantId), sourceId)); }
  create(actor, tenantId, input) {
    this.store.admin(actor); fields(input, ['title', 'category', 'content']);
    const draft = { title: string(input.title, 120, 'Título'), category: string(input.category ?? '', 80, 'Categoria', { optional: true }), content: content(input.content) };
    return this.store.mutate(actor, tenantId, 'Fonte de conhecimento criada', tenant => {
      tenant.knowledgeSources ??= [];
      const date = now(), source = { id: randomUUID(), ...draft, version: 1, archived: false, createdAt: date, updatedAt: date, publicationCounter: 0 };
      tenant.knowledgeSources.push(source); quota(tenant.knowledgeSources); return clone(source);
    });
  }
  update(actor, tenantId, sourceId, input) {
    this.store.admin(actor); fields(input, ['version', 'title', 'category', 'content']); version(input.version);
    const patch = {};
    if (Object.hasOwn(input, 'title')) patch.title = string(input.title, 120, 'Título');
    if (Object.hasOwn(input, 'category')) patch.category = string(input.category, 80, 'Categoria', { optional: true });
    if (Object.hasOwn(input, 'content')) patch.content = content(input.content);
    return this.store.mutate(actor, tenantId, 'Rascunho de conhecimento atualizado', tenant => {
      const source = findSource(tenant, sourceId), nextVersion = expected(source, input.version);
      Object.assign(source, patch, { version: nextVersion, updatedAt: now() }); quota(tenant.knowledgeSources); return clone(source);
    });
  }
  publish(actor, tenantId, sourceId, input) {
    this.store.admin(actor); fields(input, ['version']); version(input.version);
    return this.store.mutate(actor, tenantId, 'Fonte de conhecimento publicada', tenant => {
      const source = findSource(tenant, sourceId), nextVersion = expected(source, input.version), publicationVersion = increment(source.publicationCounter ?? 0), date = now();
      source.published = { version: publicationVersion, title: source.title, content: source.content, publishedAt: date };
      source.published.hash = knowledgeHash(source.id, source.published);
      Object.assign(source, { publicationCounter: publicationVersion, version: nextVersion, updatedAt: date }); quota(tenant.knowledgeSources); return clone(source);
    });
  }
  unpublish(actor, tenantId, sourceId, input) { return this.#changeState(actor, tenantId, sourceId, input, 'unpublish'); }
  archive(actor, tenantId, sourceId, input) { return this.#changeState(actor, tenantId, sourceId, input, 'archive'); }
  reactivate(actor, tenantId, sourceId, input) { return this.#changeState(actor, tenantId, sourceId, input, 'reactivate'); }
  #changeState(actor, tenantId, sourceId, input, action) {
    this.store.admin(actor); fields(input, ['version']); version(input.version);
    const label = { unpublish: 'Publicação de conhecimento revogada', archive: 'Fonte de conhecimento arquivada', reactivate: 'Fonte de conhecimento reativada' }[action];
    return this.store.mutate(actor, tenantId, label, tenant => {
      const source = findSource(tenant, sourceId), nextVersion = expected(source, input.version, { archived: action === 'reactivate' });
      if (action === 'reactivate' && !source.archived) fail(409, 'A fonte já está ativa.');
      source.archived = action === 'archive'; delete source.published;
      Object.assign(source, { version: nextVersion, updatedAt: now() }); quota(tenant.knowledgeSources); return clone(source);
    });
  }
  grants(actor, tenantId, agentId) {
    this.store.admin(actor); const agent = findAgent(this.store.tenant(actor, tenantId), agentId);
    return { version: agent.version || 1, grants: clone(agent.knowledgeGrants || []) };
  }
  setGrants(actor, tenantId, agentId, input) {
    this.store.admin(actor); fields(input, ['version', 'grants']); version(input.version);
    if (!Array.isArray(input.grants) || input.grants.length > 16) fail(400, 'Autorize até 16 fontes por agente.');
    input.grants.forEach(grantFields);
    return this.store.mutate(actor, tenantId, 'Conhecimento autorizado para agente', tenant => {
      const agent = findAgent(tenant, agentId);
      if (agent.provider !== 'hermes') fail(400, 'Autorize conhecimento somente para o Hermes.');
      if ((agent.version || 1) !== input.version) fail(409, 'O agente mudou. Atualize antes de salvar.');
      const nextVersion = increment(agent.version || 1), seen = new Set(), grants = [];
      for (const grant of input.grants) {
        if (!selectedSource(tenant, grant)) fail(409, 'Publique e atualize a fonte antes de autorizar o conhecimento.');
        if (!seen.has(grant.sourceId)) { seen.add(grant.sourceId); grants.push(clone(grant)); }
      }
      agent.knowledgeGrants = grants; agent.version = nextVersion;
      return { version: agent.version, grants: clone(grants) };
    });
  }
  snapshot(tenant, agent, conversationOrContext) {
    assertTelegramAccountAiAllowed(tenant, conversationOrContext);
    const grants = agent.knowledgeGrants || [];
    if (!Array.isArray(grants) || grants.length > 16 || grants.length && agent.provider !== 'hermes') fail(409, 'Atualize o conhecimento autorizado deste agente.');
    const seen = new Set();
    return grants.map(grant => {
      if (!selectedSource(tenant, grant) || seen.has(grant.sourceId)) fail(409, 'Atualize o conhecimento autorizado deste agente.');
      seen.add(grant.sourceId); return { sourceId: grant.sourceId, publicationVersion: grant.publicationVersion, publicationHash: grant.publicationHash };
    });
  }
  current(tenant, run) {
    if (!telegramAccountAiAllowed(tenant, run)) return false;
    if (!Object.hasOwn(run, 'knowledgeSnapshot')) return true;
    if (!Array.isArray(run.knowledgeSnapshot) || run.knowledgeSnapshot.length > 16) return false;
    if (!run.knowledgeSnapshot.length) return true;
    const agent = (tenant.agents || []).find(item => item.id === run.agentId), seen = new Set();
    if (agent?.provider !== 'hermes' || !Array.isArray(agent.knowledgeGrants)) return false;
    return run.knowledgeSnapshot.every(grant => {
      if (!selectedSource(tenant, grant) || seen.has(grant.sourceId) || !agent.knowledgeGrants.some(current => sameGrant(current, grant))) return false;
      seen.add(grant.sourceId); return true;
    });
  }
  /**
   * BM25 over passages of the sources granted to this agent in this search (IDF never sees other agents or tenants).
   * Each source header (published title + current category) counts once as its own pseudo-document.
   * Relevance: a passage (with its header) needs two distinct qualifying terms, or one that is not common, i.e. present in
   * at most half of the authorized sources (a single source cannot tell), or the query's only qualifying term.
   */
  search(tenant, agent, query = '', options = {}, conversationOrContext) {
    assertTelegramAccountAiAllowed(tenant, conversationOrContext);
    string(query, 1300, 'Consulta', { optional: true, multiline: true });
    const generic = genericTerms(options), snapshot = this.snapshot(tenant, agent, conversationOrContext);
    if (!snapshot.length) return { state: 'not_configured', references: [] };
    const terms = [...new Set(tokens(query))], qualifying = new Set(terms.filter(term => !generic.has(term)));
    if (!qualifying.size) return { state: 'no_match', references: [] };
    const corpus = snapshot.map(grant => {
      const source = selectedSource(tenant, grant), published = source.published;
      return { source, published, index: this.#index(published), category: new Set(tokens(source.category || '')) };
    });
    const frequency = new Map(terms.map(term => [term, 0])), spread = new Map(terms.map(term => [term, 0]));
    let total = 0, passages = 0, words = 0;
    const count = (term, seen) => { frequency.set(term, frequency.get(term) + 1); seen.add(term); };
    for (const { index, category } of corpus) {
      const seen = new Set(); total++;
      for (const term of terms) if (index.title.has(term) || category.has(term)) count(term, seen);
      for (const passage of index.passages) {
        total++; passages++; words += passage.length;
        for (const term of terms) if (passage.terms.has(term)) count(term, seen);
      }
      for (const term of seen) spread.set(term, spread.get(term) + 1);
    }
    const average = Math.max(words / Math.max(passages, 1), 1);
    const idf = new Map(terms.map(term => [term, Math.log(1 + (total - frequency.get(term) + 0.5) / (frequency.get(term) + 0.5))]));
    const common = term => corpus.length >= 2 && 2 * spread.get(term) > corpus.length;
    const relevant = matched => {
      const hits = [...matched].filter(term => qualifying.has(term));
      return hits.length >= 2 || hits.length === 1 && (qualifying.size === 1 || !common(hits[0]));
    };
    const candidates = [];
    for (const { source, published, index, category } of corpus) {
      const fields = terms.filter(term => index.title.has(term) || category.has(term)), header = relevant(new Set(fields)), relevantPassages = [];
      const boost = fields.reduce((sum, term) => sum + idf.get(term) * ((index.title.has(term) ? TITLE_BOOST : 0) + (category.has(term) ? CATEGORY_BOOST : 0)), 0);
      index.passages.forEach((passage, ordinal) => {
        const matched = new Set(fields); let score = boost, body = false;
        for (const term of terms) {
          const count = passage.terms.get(term);
          if (!count) continue;
          matched.add(term); body = true;
          score += idf.get(term) * count * (BM25_K1 + 1) / (count + BM25_K1 * (1 - BM25_B + BM25_B * passage.length / average));
        }
        if (body && relevant(matched)) relevantPassages.push({ passage, ordinal, score, needsTerm: !header });
      });
      if (!relevantPassages.length && header && index.passages.length) relevantPassages.push({ passage: index.passages[0], ordinal: 0, score: boost, needsTerm: false });
      for (const candidate of relevantPassages) candidates.push({ ...candidate, sourceId: source.id, published });
    }
    candidates.sort((left, right) => right.score - left.score || (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0) || left.ordinal - right.ordinal);
    const result = { state: 'no_match', references: [] };
    for (const candidate of candidates) {
      if (result.references.length >= MAX_REFERENCES) break;
      const { published, passage } = candidate, text = published.content.slice(passage.start, passage.end);
      // score is relative to this search only; projections keep their own metadata allowlist.
      const reference = { sourceId: candidate.sourceId, title: published.title, publicationVersion: published.version, publicationHash: published.hash, chunkId: passage.chunkId, excerpt: '', score: Number(candidate.score.toFixed(4)) };
      const bytes = Buffer.byteLength(JSON.stringify({ state: 'matched', references: [...result.references, reference] }));
      if (bytes >= MAX_REFERENCE_BYTES) break;
      reference.excerpt = prefix(text, MAX_EXCERPT_CHARS, MAX_REFERENCE_BYTES - bytes);
      if (candidate.needsTerm && !tokens(reference.excerpt).some(word => qualifying.has(word))) {
        const found = [...text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].find(match => tokens(match[0]).some(word => qualifying.has(word)));
        reference.excerpt = found ? prefix(text.slice(found.index), MAX_EXCERPT_CHARS, MAX_REFERENCE_BYTES - bytes) : '';
        if (!tokens(reference.excerpt).some(word => qualifying.has(word))) continue;
      }
      if (!reference.excerpt) continue;
      result.references.push(reference); result.state = 'matched';
    }
    return result;
  }
}
