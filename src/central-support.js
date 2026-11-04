import { SupportAssistant } from './support-assistant.js';
import { fail } from './store.js';
import { allowedFields } from './access.js';
import { webchatOrigin } from './channel-webchat.js';

export const SUPPORT_PRODUCTS = Object.freeze([
  { id: 'elozi', name: 'Elozi' }, { id: 'mepmail', name: 'MepMail' },
  { id: 'fullcommerce360', name: 'FullCommerce360' }, { id: 'urlpivot', name: 'URLPivot' }
].map(Object.freeze));
const ownWorkspace = (store, workspaceId) => {
  const row = store.db.prepare('SELECT data FROM resellers WHERE id=?').get(workspaceId);
  return Boolean(row && (JSON.parse(row.data).accountKind || (workspaceId === 'mep-demo' ? 'platform' : 'reseller')) === 'platform');
};

const registeredProducts = value => {
  if (!Array.isArray(value) || !value.length || value.length > SUPPORT_PRODUCTS.length || new Set(value).size !== value.length
    || Array.from(value).some(id => !SUPPORT_PRODUCTS.some(product => product.id === id))) fail(400, 'Escolha os produtos do catálogo atendidos nesta conexão.');
  return [...value].sort();
};
// Labels identify this channel's products; they never grant another tenant's sources or agents.
const namedProducts = value => {
  if (!Array.isArray(value) || !value.length || value.length > 8 || Array.from(value).some(name => typeof name !== 'string'
    || name !== name.trim() || !name || name.length > 80 || !name.isWellFormed()
    || !/[\p{L}\p{N}]/u.test(name) || /[\p{Cc}\p{Cf}<>]/u.test(name))
    || new Set(value.map(name => name.normalize('NFKC').toLocaleLowerCase('pt-BR'))).size !== value.length) {
    fail(400, 'Informe de 1 a 8 nomes de produtos, sem repetição, com até 80 caracteres cada e sem marcação ou caracteres de controle.');
  }
  return [...value].sort();
};
const productRegistry = input => {
  if (Object.hasOwn(input, 'productIds') === Object.hasOwn(input, 'productNames')) fail(400, 'Informe somente productIds ou productNames para os produtos desta conexão.');
  return Object.hasOwn(input, 'productNames') ? { productNames: namedProducts(input.productNames) } : { productIds: registeredProducts(input.productIds) };
};
const labelsOf = registry => registry.productNames || SUPPORT_PRODUCTS.filter(product => registry.productIds.includes(product.id)).map(product => product.name).sort();
const authorizedOrigins = channel => {
  const origins = channel.webchat?.origins;
  if (channel.kind !== 'webchat' || channel.transport !== 'elozi-webchat' || channel.webchat?.enabled !== true
    || !Array.isArray(origins) || !origins.length || origins.length > 8 || new Set(origins).size !== origins.length) fail(409, 'Ative o webchat e autorize as origens do produto primeiro.');
  return origins.map(webchatOrigin).sort();
};

/** Each workspace administrator explicitly enrolls their own channels, products and configured Hermes. */
export class CentralSupport {
  constructor(store, { auth, runtime, knowledge, operations, webchat, publicOrigin = '', onHandoff = null, handoffEnabled = () => false, ownKnowledge = () => false, imageInput = () => false }) {
    this.store = store; this.auth = auth; this.webchat = webchat; this.publicOrigin = publicOrigin;
    this.proofs = new WeakSet();
    // The runtime owns the 50 s inference deadline; support also needs time to send or hand off.
    this.assistant = new SupportAssistant(store, { runtime, knowledge, operations, timeoutMs: 60000,
      actorFactory: (scope, job) => {
        const actor = Object.freeze({ kind: 'service', role: 'operator', resellerId: scope.resellerId, tenantIds: [scope.tenantId], name: 'Assistente virtual Elozi', supportAssistantId: job?.id || null });
        this.proofs.add(actor); return actor;
      },
      authorize: context => this.proofs.has(context.actor) && !context.actor.supportGrantId && context.actor.resellerId === context.scope.resellerId
        && context.tenant.id === context.scope.tenantId && context.tenant.resellerId === context.scope.resellerId
        && this.scopes().some(scope => scope.resellerId === context.scope.resellerId && scope.tenantId === context.scope.tenantId && scope.channelId === context.scope.channelId && JSON.stringify(scope.origins) === JSON.stringify([...context.scope.origins]) && JSON.stringify(scope.products) === JSON.stringify([...context.scope.products])),
      authorizeAdmin: (actor, tenantId) => this.admin(actor, tenantId),
      sendReply: context => webchat.sendAssistant(context), onHandoff, handoffEnabled, ownKnowledge, imageInput
    });
    webchat.authorizeAssistant = context => this.proofs.has(context.actor) && this.assistant.authorizeSend(context);
    webchat.authorizeHandoff = context => this.authorizeHandoff(context);
    this.reload();
  }
  admin(actor, tenantId) {
    if (!actor || actor.supportGrantId || actor.kind === 'service') fail(403, 'Somente o administrador do workspace configura o suporte dos seus produtos.');
    // Check the persisted identity, not a browser-supplied role or platform flag.
    this.auth.admin(actor); this.store.admin(actor); this.store.tenant(actor, tenantId); return true;
  }
  scopes() {
    const result = [];
    for (const row of this.store.db.prepare('SELECT id,reseller_id,data FROM tenants').all()) {
      const tenant = JSON.parse(row.data);
      for (const channel of tenant.channels || []) {
        const registry = channel.centralSupportScope;
        if (!registry) continue;
        try {
          const products = productRegistry(Object.fromEntries(['productIds', 'productNames'].filter(key => Object.hasOwn(registry, key)).map(key => [key, registry[key]])));
          const currentOrigins = authorizedOrigins(channel);
          if (!Array.isArray(registry.origins) || !registry.origins.length || registry.origins.length > 8
            || new Set(registry.origins).size !== registry.origins.length || registry.origins.some(origin => !currentOrigins.includes(webchatOrigin(origin)))) continue;
          result.push({ resellerId: row.reseller_id, tenantId: row.id, channelId: channel.id, origins: [...registry.origins].sort(), products: labelsOf(products) });
        } catch (error) { if (![400, 409].includes(error.status)) throw error; }
      }
    }
    return result;
  }
  reload() { return this.assistant.replaceScopes(this.scopes()); }
  catalog(actor, tenantId) {
    this.admin(actor, tenantId);
    const tenant = this.store.tenant(actor, tenantId), scopes = this.scopes();
    return { products: SUPPORT_PRODUCTS, productInputMode: ownWorkspace(this.store, actor.resellerId) ? 'registry' : 'custom',
      agents: tenant.agents.filter(agent => agent.provider === 'hermes' && agent.configured === true && agent.mode === 'copilot').map(agent => ({ id: agent.id, name: agent.name, knowledgeCount: agent.knowledgeGrants?.length || 0 })),
      channels: tenant.channels.filter(channel => channel.kind === 'webchat').map(channel => ({ id: channel.id, name: channel.name, state: channel.state,
        origins: channel.webchat?.origins || [], configured: channel.transport === 'elozi-webchat' && channel.webchat?.enabled === true,
        productIds: channel.centralSupportScope?.productIds || [], productNames: channel.centralSupportScope?.productNames || [],
        assistant: scopes.some(scope => scope.resellerId === actor.resellerId && scope.tenantId === tenantId && scope.channelId === channel.id)
          && this.assistant.scopes.some(scope => scope.tenantId === tenantId && scope.channelId === channel.id)
          ? this.assistant.status(actor, tenantId, channel.id) : { channelId: channel.id, version: channel.supportAssistant?.version || 0, enabled: false, autoReply: false, agentId: channel.supportAssistant?.agentId || null, handoffMode: channel.supportAssistant?.handoffMode || 'pause', jobs: [] },
        integration: this.publicOrigin ? { source: this.publicOrigin + '/widget.js', tenantId, channelId: channel.id } : null })) };
  }
  configure(actor, tenantId, channelId, input, { reauthorize = () => {} } = {}) {
    allowedFields(input, ['version', 'agentId', 'enabled', 'autoReply', 'productIds', 'productNames', 'handoffMode']);
    const fresh = () => {
      this.admin(actor, tenantId);
      if (typeof reauthorize !== 'function') fail(400, 'Autorização administrativa inválida.');
      const value = reauthorize();
      if (value?.then) { Promise.resolve(value).catch(() => {}); fail(500, 'A autorização administrativa precisa ser síncrona.'); }
      if (value === false) fail(403, 'O acesso administrativo mudou.');
      return true;
    };
    fresh();
    const products = productRegistry(input);
    const tenant = this.store.tenant(actor, tenantId), channel = tenant.channels.find(item => item.id === channelId);
    if (!channel) fail(409, 'Ative o webchat e autorize as origens do produto primeiro.');
    const origins = authorizedOrigins(channel), previous = channel.centralSupportScope;
    // Omission keeps the assistant's legacy pause default; only an explicit save changes records.
    if (!Number.isSafeInteger(input.version) || input.version < 0 || input.version === Number.MAX_SAFE_INTEGER
      || typeof input.enabled !== 'boolean' || typeof input.autoReply !== 'boolean' || input.autoReply && !input.enabled
      || typeof input.agentId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(input.agentId)
      || Object.hasOwn(input, 'handoffMode') && !['pause', 'continue'].includes(input.handoffMode)) fail(400, 'Informe agente, revisão e estados explícitos do suporte.');
    if (input.version !== (channel.supportAssistant?.version || 0)) fail(409, 'A configuração do suporte mudou.');
    if (input.enabled || input.agentId !== channel.supportAssistant?.agentId) this.assistant._agent(tenant, input.agentId);
    if (input.autoReply && !this.assistant.sendReply) fail(503, 'Envio interno de suporte indisponível.');
    if (!this.scopes().some(scope => scope.tenantId === tenantId && scope.channelId === channelId) && this.scopes().length >= 64) fail(409, 'O limite de conexões do assistente de suporte foi atingido.');
    const next = { ...products, origins, configuredBy: actor.userId, configuredAt: new Date().toISOString() };
    this.store.mutate(actor, tenantId, 'Conexão registrada no suporte dos produtos deste workspace', state => {
      fresh();
      const current = state.channels.find(item => item.id === channelId);
      if (!current || (current.supportAssistant?.version || 0) !== input.version || JSON.stringify(current.centralSupportScope) !== JSON.stringify(previous)
        || JSON.stringify(authorizedOrigins(current)) !== JSON.stringify(origins)) fail(409, 'A configuração do suporte mudou.');
      current.centralSupportScope = next;
    });
    const previouslyScoped = this.assistant.scopes.some(scope => scope.resellerId === actor.resellerId && scope.tenantId === tenantId && scope.channelId === channelId);
    try {
      // New channels need a scope to configure. Existing channels retain their cached scope
      // until the assistant's CAS commits, so a rejected edit cannot invalidate saved drafts.
      if (!previouslyScoped) this.reload();
      this.assistant.configure(actor, tenantId, channelId, { version: input.version, agentId: input.agentId, enabled: input.enabled, autoReply: input.autoReply,
        ...(Object.hasOwn(input, 'handoffMode') ? { handoffMode: input.handoffMode } : {}) }, { reauthorize: fresh });
      this.reload();
      return this.assistant.status(actor, tenantId, channelId);
    } catch (error) {
      // The legacy assistant owns its transaction. Undo only our exact registry when its save
      // was rejected; never overwrite a newer config or a registry written by another request.
      this.store.mutate(actor, tenantId, 'Registro de suporte rejeitado restaurado', state => {
        const current = state.channels.find(item => item.id === channelId);
        if (current && (current.supportAssistant?.version || 0) === input.version && JSON.stringify(current.centralSupportScope) === JSON.stringify(next)) {
          if (previous === undefined) delete current.centralSupportScope; else current.centralSupportScope = previous;
        }
      });
      this.reload();
      throw error;
    }
  }
  receive(...args) { return this.assistant.receive(...args); }
  drain() { return this.assistant.drain(); }
  runCurrent(run) { return this.assistant.runCurrent(run); }
  authorizeHandoff(context) { return this.proofs.has(context.actor) && this.assistant.authorizeHandoff(context); }
  publicState(...args) { return this.assistant.publicState(...args); }
  close() { return this.assistant.close(); }
}
