import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateProfileAvatar } from './profile.js';
import { snapshotTenant, publishTenantChanges } from './events.js';
import { ServiceReadModel, SCOPED_REPLACEMENT_PROOF_ERROR, validatePrivateHeaderSchema } from './service-read-model.js';
import { ReadonlyHeaderCache, freezeReadonly as readonly } from './readonly-header-cache.js';
import { prepareConversationJournal, activateJournalForForward, effectiveTenantDataSql, materializeTenant } from './conversation-journal.js';

export const CHANNEL_KINDS = ['whatsapp_qr', 'whatsapp_cloud', 'telegram', 'telegram_user', 'instagram', 'messenger', 'webchat', 'email'];
export const PROVIDERS = ['hermes', 'claude', 'codex', 'webhook', 'mcp'];
export const MODES = ['copilot', 'approval', 'automatic'];

export function fail(status, message) { throw Object.assign(new Error(message), { status }); }
export function text(value, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(400, `Informe um texto entre 1 e ${max} caracteres.`);
  return value.trim();
}
export function choice(value, values) { if (!values.includes(value)) fail(400, 'Opção inválida.'); return value; }
export function brand(input) {
  const name = text(input.name, 48);
  if (!/^#[0-9a-f]{6}$/i.test(input.accent)) fail(400, 'Escolha uma cor hexadecimal válida.');
  return { name, accent: input.accent, initials: text(input.initials, 3), domain: input.domain ? text(input.domain, 100) : '', ...(Object.hasOwn(input, 'logo') ? { logo: validateProfileAvatar(input.logo) } : {}) };
}
const now = () => new Date().toISOString();

function fixture(name, segment, accent = '#3157d5') {
  const channels = [
    { id: randomUUID(), name: 'Atendimento principal', kind: 'whatsapp_qr', state: 'sandbox', label: 'Número A · demonstração' },
    { id: randomUUID(), name: 'Comercial', kind: 'whatsapp_qr', state: 'sandbox', label: 'Número B · demonstração' },
    { id: randomUUID(), name: 'Site', kind: 'webchat', state: 'sandbox', label: 'Widget de demonstração' },
    { id: randomUUID(), name: 'Comunidade', kind: 'telegram', state: 'planned', label: 'Integração pendente' }
  ];
  const agents = [
    { id: randomUUID(), name: 'Hermes · Suporte', provider: 'hermes', mode: 'copilot', state: 'planned', description: 'Consultar produtos e apoiar o atendimento.', tools: ['conversation.read', 'knowledge.search', 'reply.draft'] },
    { id: randomUUID(), name: 'Claude · Comercial', provider: 'claude', mode: 'approval', state: 'planned', description: 'Preparar propostas com aprovação do atendente.', tools: ['conversation.read', 'reply.draft'] },
    { id: randomUUID(), name: 'Codex · Operações', provider: 'codex', mode: 'approval', state: 'planned', description: 'Executar rotinas com ferramentas delimitadas.', tools: ['conversation.read', 'handoff.request'] }
  ];
  const requests = [
    ['Marina', 'Como faço para renovar meu plano?', 0, 'human', 'Financeiro'],
    ['Rafael', 'Preciso de ajuda para configurar meu acesso.', 0, 'agent', 'Suporte'],
    ['Camila', 'Vocês atendem empresas com vários números?', 1, 'human', 'Comercial'],
    ['Lucas', 'Quero conhecer os planos disponíveis.', 2, 'agent', 'Comercial'],
    ['Beatriz', 'Posso falar com uma pessoa da equipe?', 0, 'queue', 'Suporte'],
    ['Diego', 'Obrigado! Já consegui acessar.', 1, 'human', 'Suporte']
  ];
  const conversations = requests.map(([person, question, channel, owner, department], index) => {
    const date = new Date(Date.now() - (index + 1) * 8 * 60000).toISOString();
    return {
      id: randomUUID(), contact: `${person} (demo)`, initials: person.slice(0, 2).toUpperCase(), channelId: channels[channel].id,
      department, owner, status: 'open', version: 1, unread: index % 2 === 0 ? 1 : 0,
      agentId: owner === 'agent' ? agents[channel === 2 ? 1 : 0].id : null,
      updatedAt: date, tags: index % 2 === 0 ? ['Cliente'] : ['Novo contato'],
      messages: [{ id: randomUUID(), kind: 'customer', text: question, createdAt: date }]
    };
  });
  return { name, segment, plan: 'Partner', brand: { name: `${name} Chat`, initials: name.slice(0, 2).toUpperCase(), accent, domain: '' }, channels, agents, conversations };
}

// On-demand demonstration company: the empty-database fixture inside a real workspace, marked by tenant.demo.
// Never a concrete transport, never in billing, the PostgreSQL mirror or the consolidated alerts; removable by an admin.
export const DEMO_CHANNEL_REFUSAL = 'Empresa de demonstração não conecta canais. Use uma empresa real.';
/** 403 with code DEMO_COMPANY, so panels show the refusal itself instead of a generic access message. */
export const demoRefusal = message => Object.assign(new Error(message), { status: 403, code: 'DEMO_COMPANY' });
const DEMO_NAME = 'Empresa de demonstração';
const concreteTransport = channel => typeof channel?.transport === 'string' && !['', 'none', 'sandbox'].includes(channel.transport);
function demoCompany(session, createdAt) {
  const data = fixture(DEMO_NAME, 'Atendimento e vendas · dados fictícios');
  const departments = [...new Set(data.conversations.map(conversation => conversation.department))]
    .map(name => ({ id: randomUUID(), name, active: true, memberIds: session.userId ? [session.userId] : [] }));
  for (const conversation of data.conversations) {
    conversation.departmentId = departments.find(department => department.name === conversation.department).id;
    if (conversation.owner === 'human' && session.userId) Object.assign(conversation, { assignedUserId: session.userId, assignedUserName: session.name });
  }
  return { ...data, parentTenantId: null, identityVersion: 1, plan: 'Pilot', brand: { name: DEMO_NAME, initials: 'ED', accent: '#3157d5', domain: '' },
    departments, flows: [], runs: [], demo: { createdAt, createdBy: session.userId || null } };
}

export class Store {
  constructor(path, { conversationJournal = false } = {}) {
    if (typeof conversationJournal !== 'boolean') throw new TypeError('A opção conversationJournal precisa ser booleana.');
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA main.cache_size=-131072;');
      const { page_size: pageSize } = this.db.prepare('PRAGMA main.page_size').get();
      if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new Error('O tamanho de página SQLite não pôde ser verificado.');
      // A connection-local checkpoint threshold, not a WAL size cap. FULL commit
      // durability and spill behaviour remain unchanged, including with readers.
      const checkpointPages = Math.max(1, Math.floor(64 * 1024 ** 2 / pageSize));
      this.db.exec(`PRAGMA wal_autocheckpoint=${checkpointPages};
        CREATE TABLE IF NOT EXISTS resellers (id TEXT PRIMARY KEY, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, reseller_id TEXT NOT NULL REFERENCES resellers(id), data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL REFERENCES tenants(id), action TEXT NOT NULL, created_at TEXT NOT NULL, actor TEXT NOT NULL);`);
      if (!this.db.prepare('SELECT id FROM resellers LIMIT 1').get()) {
        this.db.prepare('INSERT INTO resellers VALUES (?,?)').run('mep-demo', JSON.stringify({ name: 'JE4NDEV', brand: { name: 'Elozi', initials: 'E', accent: '#3157d5', domain: '' } }));
        for (const [id, name, segment, accent] of [
          ['playtech-demo', 'Playtech', 'Atendimento e assinaturas', '#3157d5'],
          ['studio-demo', 'Studio Aurora', 'Serviços e agendamentos', '#0c7370'],
          ['loja-demo', 'Casa & Forma', 'Varejo e pós-venda', '#9a451e']
        ]) this.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(id, 'mep-demo', JSON.stringify(fixture(name, segment, accent)));
      }
      validatePrivateHeaderSchema(this.db);
      this.conversationJournal = prepareConversationJournal(this.db, conversationJournal);
      this.serviceReadModel = new ServiceReadModel(this.db);
      if (this.conversationJournal) activateJournalForForward(this.db);
      this.readonlyHeaderCache = new ReadonlyHeaderCache();
      this.conversationReadSequence = 0;
    } catch (error) {
      try { this.db.close(); } catch { /* Preserve the original bootstrap failure. */ }
      throw error;
    }
  }
  close() { this.readonlyHeaderCache.clear(); this.db.close(); }
  reseller(session) { const row=this.db.prepare('SELECT data FROM resellers WHERE id=?').get(session.resellerId); if(!row)fail(403,'Conta não encontrada no seu acesso.');const data=JSON.parse(row.data),{commercialPlans,workspaceDomain,commercialLifecycle,stripeBilling,stripe,billingProvider,...publicData}=data;return {...publicData,accountKind:data.accountKind||(session.resellerId==='mep-demo'?'platform':'reseller'),parentWorkspaceId:data.parentWorkspaceId||null}; }
  provisionReseller({resellerId,tenantId,name,accountKind='business',parentWorkspaceId='mep-demo',initialTenantName,segment='Atendimento',onboardingTrial}) {
    if(!/^reseller_[0-9a-f-]{36}$/.test(resellerId)||!/^tenant_[0-9a-f-]{36}$/.test(tenantId))fail(400,'Identidade de cadastro inválida.');
    const company=text(name,80);
    if(this.db.prepare('SELECT 1 FROM resellers WHERE id=?').get(resellerId)||this.db.prepare('SELECT 1 FROM tenants WHERE id=?').get(tenantId))fail(409,'Este espaço já foi criado.');
    const branding={name:'Elozi',initials:'E',accent:'#3157d5',domain:''};
    choice(accountKind,['business','reseller']);
    if(parentWorkspaceId!==null&&!this.db.prepare('SELECT 1 FROM resellers WHERE id=?').get(parentWorkspaceId))fail(400,'Conta comercial responsável não encontrada.');
    let commercialLifecycle;
    if(onboardingTrial!==undefined){
      const validInstant=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
      if(!onboardingTrial||typeof onboardingTrial!=='object'||Array.isArray(onboardingTrial)||Object.keys(onboardingTrial).some(key=>!['startsAt','expiresAt'].includes(key))||!validInstant(onboardingTrial.startsAt)||!validInstant(onboardingTrial.expiresAt)||Date.parse(onboardingTrial.expiresAt)-Date.parse(onboardingTrial.startsAt)!==7*86400000)fail(400,'Período inicial do teste inválido.');
      commercialLifecycle={state:'trial',trialStartsAt:onboardingTrial.startsAt.slice(0,10),trialEndsAt:onboardingTrial.expiresAt.slice(0,10),trialExpiresAt:onboardingTrial.expiresAt,changedAt:onboardingTrial.startsAt,changedBy:{userId:'self-registration',workspaceId:resellerId},reason:'Teste iniciado no cadastro público'};
    }
    this.db.prepare('INSERT INTO resellers VALUES (?,?)').run(resellerId,JSON.stringify({name:company,brand:branding,accountKind,parentWorkspaceId,version:1,createdAt:onboardingTrial?.startsAt||now(),...(commercialLifecycle?{commercialLifecycle}:{})}));
    this.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(tenantId,resellerId,JSON.stringify({name:text(initialTenantName||company,80),segment:text(segment,80),parentTenantId:null,identityVersion:1,plan:'Pilot',brand:branding,channels:[],agents:[],conversations:[],flows:[],runs:[]}));
    this.queuePostgres?.(tenantId);
    return {resellerId,tenantId};
  }
  setResellerBrand(session, branding) {
    this.admin(session);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row=this.db.prepare('SELECT data FROM resellers WHERE id=?').get(session.resellerId);
      if(!row)fail(403,'Conta não encontrada no seu acesso.');
      const data=JSON.parse(row.data);
      data.brand = { ...data.brand, ...branding };
      this.db.prepare('UPDATE resellers SET data=? WHERE id=?').run(JSON.stringify(data), session.resellerId);
      for (const row of this.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').all(session.resellerId)) this.queuePostgres?.(row.id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.reseller(session);
  }
  tenant(session, id) {
    if (session.role === 'operator' && !(session.tenantIds || [session.tenantId]).includes(id)) fail(403, 'Esta empresa não está no seu acesso.');
    const row = this.db.prepare(this.conversationJournal
      ? `SELECT t.id,t.reseller_id,${effectiveTenantDataSql(this.db)} AS data FROM tenants t WHERE t.id=? AND t.reseller_id=?`
      : 'SELECT * FROM tenants WHERE id=? AND reseller_id=?').get(id, session.resellerId);
    if (!row) fail(404, 'Empresa não encontrada.');
    return { id: row.id, resellerId: row.reseller_id, ...JSON.parse(row.data) };
  }
  /** Internal authorization/bootstrap header. Never opens conversation histories; live SQL tokens only reuse parsing. */
  readonlyTenantHeader(session, id, { conversationSummaries = false } = {}) {
    if (session.role === 'operator' && !(session.tenantIds || [session.tenantId]).includes(id)) fail(403, 'Esta empresa não está no seu acesso.');
    const savepoint = `store_header_read_${++this.conversationReadSequence}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const hint = this.readonlyHeaderCache.token(session.resellerId, id);
      const row = this.db.prepare(`SELECT t.id,t.reseller_id,CASE WHEN p.header_token IS ?3 THEN NULL ELSE p.data END AS header,
        p.header_token AS headerToken,p.valid FROM tenants t
        JOIN service_tenant_private p ON p.tenant_id=t.id AND p.reseller_id=t.reseller_id
        JOIN service_read_model_meta version ON version.id='routing' AND version.version=9
        WHERE t.id=?1 AND t.reseller_id=?2`).get(id, session.resellerId, hint);
      if (!row) fail(404, 'Empresa não encontrada.');
      if (row.valid !== 1) {
        this.readonlyHeaderCache.invalidate(row.reseller_id, row.id);
        // Retain the canonical malformed-JSON error, without a full-history fallback.
        this.db.prepare("SELECT json_remove(data,'$.conversations') FROM tenants WHERE id=? AND reseller_id=?").get(id, session.resellerId);
        fail(409, 'O header da empresa é inválido; reabra o armazenamento para reconciliá-lo.');
      }
      if (typeof row.headerToken !== 'string' || !/^[a-f0-9]{32}$/.test(row.headerToken)) {
        this.readonlyHeaderCache.invalidate(row.reseller_id, row.id);
        throw Object.assign(new Error('O token privado do header é inválido; reabra o armazenamento para reconciliá-lo.'), { code: 'ELOZI_READONLY_HEADER_TOKEN' });
      }
      let header = row.header === null ? this.readonlyHeaderCache.readToken(row.reseller_id, row.id, row.headerToken)?.value : undefined;
      if (!header) {
        if (row.header === null) {
          const fresh = this.db.prepare(`SELECT p.data AS header FROM tenants t
            JOIN service_tenant_private p ON p.tenant_id=t.id AND p.reseller_id=t.reseller_id
            JOIN service_read_model_meta version ON version.id='routing' AND version.version=9
            WHERE t.id=? AND t.reseller_id=? AND p.header_token=?`).get(id, session.resellerId, row.headerToken);
          if (!fresh) fail(409, 'O contexto da empresa mudou durante a leitura.');
          row.header = fresh.header;
        }
        header = this.readonlyHeaderCache.read(row.reseller_id, row.id, row.header, row.headerToken);
      }
      const result = { id: row.id, resellerId: row.reseller_id, ...header };
      if (conversationSummaries) result.conversations = this.serviceTenant(session.resellerId, id).conversations;
      this.db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
  }
  #conversationRecord(session, id, conversationId, readonlyHeader = false, tokenHeader = false) {
    if (session.role === 'operator' && !(session.tenantIds || [session.tenantId]).includes(id)) fail(403, 'Esta empresa não está no seu acesso.');
    const hint = tokenHeader ? this.readonlyHeaderCache.token(session.resellerId, id) : null;
    const headerProjection = tokenHeader ? 'CASE WHEN p.header_token IS ?3 THEN NULL ELSE p.data END' : 'p.data';
    const row = this.db.prepare(`SELECT t.id,t.reseller_id,${headerProjection} AS header,p.header_token AS headerToken,p.valid,p.source_type FROM tenants t JOIN service_tenant_private p ON p.tenant_id=t.id AND p.reseller_id=t.reseller_id JOIN service_read_model_meta version ON version.id='routing' AND version.version=9 WHERE t.id=?1 AND t.reseller_id=?2`)
      .get(...(tokenHeader ? [id, session.resellerId, hint] : [id, session.resellerId]));
    if (!row) fail(404, 'Empresa não encontrada.');
    // Preserve the canonical JSON error on corrupt source; normal reads never open that document.
    if (row.valid !== 1) {
      this.readonlyHeaderCache.invalidate(row.reseller_id, row.id);
      this.db.prepare("SELECT json_remove(data,'$.conversations') FROM tenants WHERE id=? AND reseller_id=?").get(id, session.resellerId);
    }
    const selected = this.db.prepare("SELECT c.position AS key,c.data AS value FROM service_conversation_private c JOIN tenants t ON t.id=c.tenant_id JOIN service_read_model_meta version ON version.id='routing' AND version.version=9 WHERE t.id=? AND t.reseller_id=? AND c.id=?").get(id, session.resellerId, conversationId);
    if (!selected) fail(404, 'Conversa não encontrada nesta empresa.');
    if (typeof row.headerToken !== 'string' || !/^[a-f0-9]{32}$/.test(row.headerToken)) {
      this.readonlyHeaderCache.invalidate(row.reseller_id, row.id);
      throw Object.assign(new Error('O token privado do header é inválido; reabra o armazenamento para reconciliá-lo.'), { code: 'ELOZI_READONLY_HEADER_TOKEN' });
    }
    let header;
    if (readonlyHeader) {
      const cached = tokenHeader && row.header === null ? this.readonlyHeaderCache.readToken(row.reseller_id, row.id, row.headerToken) : undefined;
      if (cached) header = cached.value;
      else {
        if (row.header === null) {
          // An internal hook may evict between the SQL hint and cache consumption.
          // Fetch the header in this same snapshot; null is never a header payload.
          const fresh = this.db.prepare("SELECT p.data AS header FROM tenants t JOIN service_tenant_private p ON p.tenant_id=t.id AND p.reseller_id=t.reseller_id JOIN service_read_model_meta version ON version.id='routing' AND version.version=9 WHERE t.id=? AND t.reseller_id=? AND p.header_token=?")
            .get(id, session.resellerId, row.headerToken);
          if (!fresh) fail(409, 'O contexto da empresa mudou durante a leitura.');
          row.header = fresh.header;
        }
        header = this.readonlyHeaderCache.read(row.reseller_id, row.id, row.header, row.headerToken);
      }
    } else header = JSON.parse(row.header);
    return { ...selected, header: row.header, headerToken: row.headerToken, metadata: { id: row.id, resellerId: row.reseller_id, ...header }, conversation: JSON.parse(selected.value) };
  }
  /** Internal full header plus exactly one history, read in one SQLite snapshot (also inside mutate transactions). */
  conversationTenant(session, id, conversationId) {
    const savepoint = `store_conversation_read_${++this.conversationReadSequence}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const { metadata, conversation } = this.#conversationRecord(session, id, conversationId);
      this.db.exec(`RELEASE ${savepoint}`);
      return { ...metadata, conversations: [conversation] };
    } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
  }
  /** Same live SQL snapshot; only nested header values are immutable and eligible for bounded parse reuse. */
  readonlyConversationTenant(session, id, conversationId) {
    const savepoint = `store_conversation_read_${++this.conversationReadSequence}`;
    this.db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const { metadata, conversation } = this.#conversationRecord(session, id, conversationId, true, true);
      this.db.exec(`RELEASE ${savepoint}`);
      return { ...metadata, conversations: [conversation] };
    } catch (error) { this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`); throw error; }
  }
  /** Internal service routing metadata, scoped before any conversation/history is read. */
  serviceTenant(workspaceId, tenantId, options) {
    const tenant = this.serviceReadModel.tenant(workspaceId, tenantId, options);
    if (!tenant) fail(404, 'Empresa não encontrada.');
    return tenant;
  }
  list(session) {
    return this.db.prepare(this.conversationJournal
      ? `SELECT t.id,${effectiveTenantDataSql(this.db)} AS data FROM tenants t WHERE t.reseller_id=?`
      : 'SELECT id,data FROM tenants WHERE reseller_id=?').all(session.resellerId)
      .filter(row => session.role !== 'operator' || (session.tenantIds || [session.tenantId]).includes(row.id))
      .map(row => { const state = JSON.parse(row.data); const visible=session.role!=='operator'||(session.tenantIds||[session.tenantId]).includes(state.parentTenantId);return { id: row.id, name: state.name, segment: state.segment, parentTenantId:visible?state.parentTenantId||null:null,identityVersion:state.identityVersion||1,plan: state.plan, brand: state.brand, demo: Boolean(state.demo), channels: state.channels.length, conversations: state.conversations.filter(c => c.status === 'open').length }; });
  }
  admin(session) { if (session.role !== 'reseller') fail(403, 'Acesso reservado à revenda.'); }
  /** action is the audit label, or a function of the result when the transaction itself decides what happened. */
  mutate(session, id, action, fn) {
    // this.events (a bus of events.js) receives pointer events of committed changes only.
    const bus = this.events && !this.events.closed ? this.events : null;
    let snapshot = null, state, result;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.conversationJournal) materializeTenant(this.db, id, { workspaceId: session.resellerId });
      state = this.tenant(session, id);
      if (bus) try { snapshot = snapshotTenant(state); } catch (failure) { snapshot = null; this.reportEventFailure(failure); }
      const demo = Boolean(state.demo);
      result = fn(state);
      // Every transport start or restore needs a concrete channel.transport, so a demo company can never hold one.
      if (Boolean(state.demo) !== demo) fail(409, 'A marcação de demonstração da empresa não muda.');
      if (demo && (state.channels || []).some(concreteTransport)) throw demoRefusal(DEMO_CHANNEL_REFUSAL);
      const { id: ignored, resellerId: ignored2, ...data } = state;
      this.db.prepare('UPDATE tenants SET data=? WHERE id=? AND reseller_id=?').run(JSON.stringify(data), id, session.resellerId);
      this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?)').run(randomUUID(), id, typeof action === 'function' ? String(action(result)) : action, now(), session.name);
      this.queuePostgres?.(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    // After COMMIT and outside the rollback path: a failed diff or publication is reported, never undoes the change.
    if (snapshot) publishTenantChanges(bus, snapshot, state, { tenantId: id, onError: failure => this.reportEventFailure(failure) });
    return result;
  }
  /** Mutate only the selected conversation. Canonical JSON, audit and callback DB effects commit or roll back together. */
  mutateConversation(session, id, conversationId, action, fn) {
    const bus = this.events && !this.events.closed ? this.events : null;
    let snapshot = null, state, result;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const scope = { resellerId: session.resellerId, role: session.role };
      const record = this.#conversationRecord(session, id, conversationId, true), conversation = record.conversation;
      const metadata = readonly(record.metadata);
      state = { id, departments: metadata.departments, conversations: [conversation] };
      if (bus) try { snapshot = snapshotTenant(state); } catch (failure) { snapshot = null; this.reportEventFailure(failure); }
      result = fn(conversation, metadata);
      if (typeof result?.then === 'function') { Promise.resolve(result).catch(() => {}); throw new TypeError('A alteração da conversa precisa ser síncrona.'); }
      if (session.resellerId !== scope.resellerId || session.role !== scope.role || session.role === 'operator' && !(session.tenantIds || [session.tenantId]).includes(id)) fail(403, 'O acesso à empresa mudou durante a alteração.');
      if (conversation.id !== conversationId) fail(409, 'A identidade do atendimento não pode mudar.');
      const encoded = JSON.stringify(conversation);
      // The private indexes follow every canonical write in the same transaction.
      // CAS remains scoped against tenants and rejects a moved/replaced/version-changed target or header.
      const current = `id=? AND reseller_id=? AND EXISTS (
          SELECT 1 FROM service_tenant_private p JOIN service_conversation_private c ON c.tenant_id=p.tenant_id
          JOIN service_read_model_meta version ON version.id='routing' AND version.version=9
          WHERE p.tenant_id=tenants.id AND p.reseller_id=tenants.reseller_id AND p.valid=1 AND p.source_type='object'
            AND p.data=? AND p.header_token=? AND c.id=? AND c.position=? AND c.data=?)`;
      const expected = [id, scope.resellerId, record.header, record.headerToken, conversationId, record.key, record.value];
      if (encoded === record.value) {
        // The callback, its DB effects, audit and bridge still run. Only a byte-identical
        // conversation with the same live CAS can avoid a redundant canonical UPDATE.
        if (!this.db.prepare(`SELECT 1 FROM tenants WHERE ${current}`).get(...expected)) fail(409, 'O atendimento ou o contexto da empresa mudou durante a alteração.');
      } else if (this.conversationJournal && this.serviceReadModel.canJournalConversation(id, scope.resellerId, encoded)) {
        const updated = this.serviceReadModel.withJournalWrite({ tenantId: id, workspaceId: scope.resellerId, position: record.key, conversationId, oldData: record.value, data: encoded }, () =>
          this.db.prepare(`INSERT INTO conversation_journal (tenant_id,reseller_id,position,conversation_id,data)
            SELECT tenants.id,tenants.reseller_id,?,?,? FROM tenants WHERE ${current}
            ON CONFLICT(tenant_id,position) DO UPDATE SET data=excluded.data`).run(record.key, conversationId, encoded, ...expected));
        if (updated.changes !== 1) fail(409, 'O atendimento ou o contexto da empresa mudou durante a alteração.');
      } else {
        if (this.conversationJournal) materializeTenant(this.db, id, { workspaceId: scope.resellerId });
        const updated = this.serviceReadModel.withConversationWrite({ tenantId: id, workspaceId: scope.resellerId, position: record.key, conversationId, data: encoded, strict: true }, ({ expectedSql, replacementSql }) => {
          try { return this.db.prepare(`UPDATE tenants SET data=${replacementSql} WHERE ${current}`).run(...expected); }
          catch (error) {
            if (error?.code !== 'ERR_SQLITE_ERROR' || error?.errcode !== 1811 || error?.message !== SCOPED_REPLACEMENT_PROOF_ERROR) throw error;
            // ABORT rolled back only the rejected statement. The guard and prior
            // callback DB effects remain in this savepoint; retry only canonical SQL.
            return this.db.prepare(`UPDATE tenants SET data=${expectedSql} WHERE ${current}`).run(...expected);
          }
        });
        if (updated.changes !== 1) fail(409, 'O atendimento ou o contexto da empresa mudou durante a alteração.');
      }
      this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?)').run(randomUUID(), id, typeof action === 'function' ? String(action(result)) : action, now(), session.name);
      // The configured PostgreSQL bridge may still read/serialize the full canonical tenant, exactly as Store.mutate.
      this.queuePostgres?.(id);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    if (snapshot) publishTenantChanges(bus, snapshot, state, { tenantId: id, onError: failure => this.reportEventFailure(failure) });
    return result;
  }
  reportEventFailure(failure) { try { this.onEventError?.(failure); } catch { /* Reporting never reaches the committed caller. */ } }
  createTenant(session, input) {
    this.admin(session);
    if (this.list(session).filter(tenant => !tenant.demo).length >= 1000) fail(400, 'Limite de empresas e unidades desta conta atingido.');
    const name = text(input.name, 48), segment = text(input.segment, 80), id = 'tenant_'+randomUUID();
    const parentTenantId=this.validateUnitParent(session,id,input.parentTenantId);
    const data = { name, segment,parentTenantId,identityVersion:1, plan: 'Pilot', brand: { name: `${name} Chat`, initials: name.slice(0, 2).toUpperCase(), accent: '#3157d5', domain: '' }, channels: [], agents: [], conversations: [] };
    this.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(id, session.resellerId, JSON.stringify(data));
    this.queuePostgres?.(id);
    return this.tenant(session, id);
  }
  /** One per workspace. Not queued to the PostgreSQL mirror: the bridge never carries a demo company. */
  createDemoTenant(session) {
    this.admin(session);
    const id = 'tenant_' + randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare("SELECT 1 FROM tenants WHERE reseller_id=? AND json_extract(data,'$.demo') IS NOT NULL").get(session.resellerId)) fail(409, 'Esta conta já tem uma empresa de demonstração.');
      this.db.prepare('INSERT INTO tenants VALUES (?,?,?)').run(id, session.resellerId, JSON.stringify(demoCompany(session, now())));
      this.db.prepare('INSERT INTO audit VALUES (?,?,?,?,?)').run(randomUUID(), id, 'Empresa de demonstração criada', now(), session.name);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.tenant(session, id);
  }
  /**
   * Deletes the demo company and every row keyed by it in one transaction. Foreign keys are checked at COMMIT, so a
   * reference this code does not know about rolls everything back. Access granted to people is never edited here.
   */
  removeDemoTenant(session, id) {
    this.admin(session);
    const table = name => Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const columns = name => new Set(this.db.prepare(`PRAGMA table_info("${name}")`).all().map(column => column.name));
    const holds = column => `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${column}) AND json_type(${column})='array' THEN ${column} ELSE '[]' END) WHERE value=?)`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare("SELECT json_extract(data,'$.demo') IS NOT NULL AS demo FROM tenants WHERE id=? AND reseller_id=?").get(id, session.resellerId);
      if (!row) fail(404, 'Empresa não encontrada.');
      if (row.demo !== 1) fail(409, 'Somente a empresa de demonstração pode ser removida.');
      const at = Date.now(), holders = [
        ...(table('auth_users') ? this.db.prepare(`SELECT name FROM auth_users WHERE reseller_id=? AND ${holds('tenant_ids')} ORDER BY name`).all(session.resellerId, id).map(user => user.name) : []),
        ...(table('auth_invitations') ? this.db.prepare(`SELECT coalesce(email,name,'convite') AS name FROM auth_invitations WHERE reseller_id=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>? AND ${holds('tenant_ids')}`).all(session.resellerId, at, id).map(invite => `convite ${invite.name}`) : []),
        ...(table('support_grants') ? this.db.prepare(`SELECT 1 FROM support_grants WHERE workspace_id=? AND revoked_at IS NULL AND expires_at>? AND ${holds('tenant_ids')}`).all(session.resellerId, at, id).map(() => 'suporte delegado') : [])];
      if (holders.length) fail(409, `Antes de remover, retire a empresa de demonstração do acesso de: ${holders.slice(0, 3).join(', ')}${holders.length > 3 ? ` e mais ${holders.length - 3}` : ''}.`);
      if (table('billing_contracts') && this.db.prepare('SELECT 1 FROM billing_contracts WHERE tenant_id=?').get(id)) fail(409, 'A empresa de demonstração tem contrato de cobrança e não pode ser removida.');
      this.db.exec('PRAGMA defer_foreign_keys=ON');
      const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(item => item.name);
      if (table('service_principals')) for (const name of tables) {
        const fields = columns(name);
        if (fields.has('principal_id') && !fields.has('tenant_id')) this.db.prepare(`DELETE FROM "${name}" WHERE principal_id IN (SELECT id FROM service_principals WHERE tenant_id=?)`).run(id);
      }
      // Read-model tables follow the tenant row through ON DELETE CASCADE and the service_read_delete trigger.
      const cascades = name => this.db.prepare(`PRAGMA foreign_key_list("${name}")`).all().some(key => key.table === 'tenants' && key.from === 'tenant_id' && key.on_delete === 'CASCADE');
      for (const name of tables) if (name !== 'tenants' && !name.startsWith('billing_') && columns(name).has('tenant_id') && !cascades(name)) this.db.prepare(`DELETE FROM "${name}" WHERE tenant_id=?`).run(id);
      this.db.prepare('DELETE FROM tenants WHERE id=? AND reseller_id=?').run(id, session.resellerId);
      this.db.exec('COMMIT');
    } catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
    this.readonlyHeaderCache.invalidate(session.resellerId, id);
    return { id, removed: true };
  }
  /** Cheap marker read for the few routes a demo company refuses; it never parses the conversations in JavaScript. */
  isDemoTenant(workspaceId, id) { return this.db.prepare("SELECT json_extract(data,'$.demo') IS NOT NULL AS demo FROM tenants WHERE id=? AND reseller_id=?").get(id, workspaceId)?.demo === 1; }
  validateUnitParent(session,id,parentTenantId) {
    if(parentTenantId===undefined||parentTenantId===null||parentTenantId==='')return null;
    if(typeof parentTenantId!=='string'||parentTenantId===id)fail(400,'Escolha uma matriz válida para esta filial.');
    const parent=this.tenant(session,parentTenantId);
    if(parent.demo)fail(400,'A empresa de demonstração não recebe filiais.');
    if(parent.parentTenantId)fail(400,'Uma filial deve pertencer diretamente à matriz.');
    if(this.db.prepare("SELECT 1 FROM tenants WHERE reseller_id=? AND json_extract(data,'$.parentTenantId')=?").get(session.resellerId,id))fail(409,'Esta matriz possui filiais e não pode virar filial.');
    return parentTenantId;
  }
  updateTenantIdentity(session,id,input) {
    this.admin(session);
    if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['name','segment','parentTenantId','version'].includes(key)))fail(400,'Informe somente a identidade e estrutura da unidade.');
    return this.mutate(session,id,'Identidade e estrutura da unidade atualizadas',tenant=>{
      if(!Number.isInteger(input.version)||input.version!==(tenant.identityVersion||1))fail(409,'A unidade mudou. Atualize antes de salvar.');
      const parentTenantId=this.validateUnitParent(session,id,input.parentTenantId);
      if(tenant.demo&&parentTenantId)fail(400,'A empresa de demonstração não vira filial.');
      tenant.name=text(input.name,48);tenant.segment=text(input.segment,80);tenant.parentTenantId=parentTenantId;tenant.identityVersion=(tenant.identityVersion||1)+1;
      return {id,name:tenant.name,segment:tenant.segment,parentTenantId,identityVersion:tenant.identityVersion};
    });
  }
  getConversation(state, id, version) {
    const conversation = state.conversations.find(c => c.id === id);
    if (!conversation) fail(404, 'Conversa não encontrada nesta empresa.');
    if (version !== undefined && conversation.version !== version) fail(409, 'A conversa mudou. Atualize antes de continuar.');
    return conversation;
  }
  audit(session, id) {
    // Same 403/404 as tenant(), without parsing the conversation histories it never returns.
    if (session.role === 'operator' && !(session.tenantIds || [session.tenantId]).includes(id)) fail(403, 'Esta empresa não está no seu acesso.');
    if (!this.db.prepare('SELECT 1 FROM tenants WHERE id=? AND reseller_id=?').get(id, session.resellerId)) fail(404, 'Empresa não encontrada.');
    return this.db.prepare('SELECT action,created_at AS createdAt,actor FROM audit WHERE tenant_id=? ORDER BY created_at DESC LIMIT 12').all(id); }
}
