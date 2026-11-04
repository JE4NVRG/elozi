import { randomBytes } from 'node:crypto';
import { resolveTxt, resolveCname } from 'node:dns/promises';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { fail } from './store.js';
import { validateProfileAvatar } from './profile.js';

export const DOMAIN_STATES = Object.freeze(['pending', 'verified', 'active', 'disabled']);
// A larger backward step is a clock correction: evidence stamped by the wrong clock is not trusted as past.
const MAX_CLOCK_STEP_MS = 60000;
const privateSuffixes = ['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'arpa', 'test', 'invalid', 'example', 'onion', 'alt'];
const validInstant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fields = (input, allowed) => {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) fail(400, 'Informe somente os campos desta operação de domínio.');
  if (!Number.isSafeInteger(input.version) || input.version < 1 || input.version >= Number.MAX_SAFE_INTEGER) fail(400, 'Informe a revisão atual da conta.');
};
const sync = (fn, ...args) => {
  const value = fn(...args);
  if (value && typeof value.then === 'function') { value.catch?.(() => {}); fail(500, 'A persistência do domínio exige operação síncrona.'); }
  return value;
};

export function normalizeWorkspaceHost(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > 253 || /[\s\p{Cc}\\/:@?#*\[\]%]/u.test(value)) fail(400, 'Informe um hostname público sem porta, caminho ou curinga.');
  const host = domainToASCII(value.replace(/\.$/, '')).toLowerCase(), labels = host.split('.');
  if (!host || host.length > 253 || isIP(host) || labels.length < 2 || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(labels.at(-1)) || privateSuffixes.some(suffix => host === suffix || host.endsWith(`.${suffix}`))) fail(400, 'Informe um hostname público válido.');
  return host;
}

function publicBrand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result = {};
  for (const [key, limit] of [['name', 48], ['initials', 3]]) if (typeof value[key] === 'string' && value[key].trim() && value[key].length <= limit && !/\p{Cc}/u.test(value[key])) result[key] = value[key];
  if (typeof value.accent === 'string' && /^#[0-9a-f]{6}$/i.test(value.accent)) result.accent = value.accent;
  if (value.logo !== undefined) { try { result.logo = validateProfileAvatar(value.logo); } catch { /* Invalid legacy images are not exposed publicly. */ } }
  return result;
}

/** DNS ownership is separate from a trusted deployment check; neither grants operational access. */
export class WorkspaceDomains {
  constructor(accounts, { resolver = { resolveTxt, resolveCname }, canonicalHost = 'elozi.je4ndev.com', inspectDeployment = null, dnsTimeoutMs = 5000 } = {}) {
    if (!accounts?.db || !accounts?.store || ['actor', 'platform', 'accountRow', 'visible', 'transaction', 'audit', 'timestamp'].some(name => typeof accounts[name] !== 'function')
      || !resolver || ['resolveTxt', 'resolveCname'].some(name => typeof resolver[name] !== 'function') || inspectDeployment !== null && typeof inspectDeployment !== 'function') throw new Error('Domínios exigem contas comerciais, DNS e autorização válidos.');
    Object.assign(this, { accounts, db: accounts.db, resolver, inspectDeployment, issued: '' });
    this.canonicalHost = normalizeWorkspaceHost(canonicalHost);
    this.dnsTimeoutMs = Number.isSafeInteger(dnsTimeoutMs) && dnsTimeoutMs > 0 && dnsTimeoutMs <= 15000 ? dnsTimeoutMs : 5000;
  }
  // The wall clock can step backward (NTP; Docker Desktop's VM steps it back about a second several times a minute).
  // A proof this process recorded is never "from the future" and a new one is never ordered before the previous one:
  // the instant never falls behind the last timestamp issued here. Later evidence stays refused; expiry is never postponed.
  instant() { const value = this.accounts.timestamp(); return this.issued > value && Date.parse(this.issued) - Date.parse(value) <= MAX_CLOCK_STEP_MS ? this.issued : value; }
  stamp() { return this.issued = this.instant(); }
  metadata(account) {
    const value = account.data.workspaceDomain;
    if (value === undefined || value === null) return null;
    let host;
    try { host = normalizeWorkspaceHost(value.host); } catch { fail(500, 'O registro de domínio está inválido. Preserve os dados e revise a conta.'); }
    if (typeof value !== 'object' || Array.isArray(value) || host !== value.host || host === this.canonicalHost || !DOMAIN_STATES.includes(value.state)
      || !/^[a-f0-9]{64}$/.test(value.challenge) || !validInstant(value.configuredAt) || value.verifiedAt !== null && !validInstant(value.verifiedAt)) fail(500, 'O registro de domínio está inválido. Preserve os dados e revise a conta.');
    return value;
  }
  deploymentValid(binding, instant = this.instant()) {
    const proof = binding.deployment;
    return Boolean(binding.verifiedAt && proof && proof.host === binding.host && proof.httpsOrigin === `https://${binding.host}` && proof.canonicalHost === this.canonicalHost
      && proof.tlsValid === true && proof.proxyVerified === true && validInstant(proof.observedAt) && validInstant(proof.certificateExpiresAt)
      && proof.observedAt >= binding.verifiedAt && proof.observedAt <= instant && proof.certificateExpiresAt > instant);
  }
  response(actor, account) {
    const value = this.metadata(account), active = value?.state === 'active' && this.deploymentValid(value);
    const deployment = value?.deployment;
    return { workspaceId: account.id, version: account.version, canonicalHost: this.canonicalHost,
      binding: value ? { host: value.host, state: value.state, configuredAt: value.configuredAt, verifiedAt: value.verifiedAt, active: Boolean(active), challenge: value.challenge,
        records: [{ type: 'TXT', name: `_elozi-verification.${value.host}`, value: `elozi-verification=${value.challenge}` }, { type: 'CNAME', name: value.host, value: this.canonicalHost }],
        lastCheck: value.lastCheck ? { txtOwnership: value.lastCheck.txtOwnership === true, cnameTarget: value.lastCheck.cnameTarget === true, checkedAt: validInstant(value.lastCheck.checkedAt) ? value.lastCheck.checkedAt : null,...(value.lastCheck.routeVerified===true?{routeVerified:true,verificationMethod:'txt+signed-https'}:{}) } : null,
        deployment: deployment ? { host: deployment.host, httpsOrigin: deployment.httpsOrigin, canonicalHost: deployment.canonicalHost, tlsValid: deployment.tlsValid === true, proxyVerified: deployment.proxyVerified === true,
          observedAt: deployment.observedAt, certificateExpiresAt: deployment.certificateExpiresAt, ...(typeof deployment.sourceRevision === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(deployment.sourceRevision) ? { sourceRevision: deployment.sourceRevision } : {}) } : null } : null,
      deploymentInspectionAvailable: Boolean(this.inspectDeployment), canConfirmDeployment: Boolean(this.inspectDeployment) && actor.resellerId === this.accounts.platformWorkspaceId && this.accounts.platform(actor),
      activationRequirements: ['TXT de propriedade conferido e destino CNAME canônico; com DNS oculto pelo proxy, rota HTTPS assinada pelo servidor.', 'Proxy configurado para este hostname e para a aplicação Elozi.', 'HTTPS com certificado válido para o hostname, verificado por inspeção técnica da plataforma.'] };
  }
  status(inputActor, id = inputActor?.resellerId) {
    const actor = this.accounts.actor(inputActor); return this.response(actor, this.accounts.visible(actor, id));
  }
  first(inputActor, id, version, { platformOnly = false } = {}) {
    const actor = this.accounts.actor(inputActor), account = this.accounts.visible(actor, id);
    if (platformOnly && (actor.resellerId !== this.accounts.platformWorkspaceId || !this.accounts.platform(actor))) fail(403, 'Somente a plataforma confirma a implantação do domínio.');
    if (account.version !== version) fail(409, 'A conta mudou. Atualize antes de alterar o domínio.');
    return { actor, account };
  }
  commit(inputActor, id, version, first, action, change, { platformOnly = false } = {}) {
    return this.accounts.transaction(() => {
      const fresh = this.first(inputActor, id, version, { platformOnly });
      if (fresh.actor.userId !== first.actor.userId || fresh.actor.resellerId !== first.actor.resellerId) fail(403, 'O acesso mudou. Abra a conta novamente.');
      const previous = fresh.account, binding = change(this.metadata(previous), previous);
      if (binding === previous.data.workspaceDomain || binding === null && previous.data.workspaceDomain == null) return this.response(fresh.actor, previous);
      const data = { ...previous.data, version: previous.version + 1 };
      if (binding === null) delete data.workspaceDomain; else data.workspaceDomain = binding;
      const result = this.db.prepare('UPDATE resellers SET data=? WHERE id=? AND data=?').run(JSON.stringify(data), id, previous.rawData);
      if (result.changes !== 1) fail(409, 'A conta mudou. Atualize antes de alterar o domínio.');
      for (const tenant of this.db.prepare('SELECT id FROM tenants WHERE reseller_id=?').all(id)) if (this.accounts.store.queuePostgres) sync(this.accounts.store.queuePostgres.bind(this.accounts.store), tenant.id);
      const account = this.accounts.accountRow(id); this.accounts.audit(fresh.actor, account, action, previous.version);
      return this.response(fresh.actor, account);
    });
  }
  register(inputActor, id, input) {
    fields(input, ['version', 'host']); const host = normalizeWorkspaceHost(input.host);
    if (host === this.canonicalHost) fail(400, 'O domínio canônico da plataforma não pode ser vinculado a outra conta.');
    const first = this.first(inputActor, id, input.version);
    return this.commit(inputActor, id, input.version, first, 'account.domain.registered', binding => {
      if (this.db.prepare("SELECT 1 FROM resellers WHERE id<>? AND json_extract(data,'$.workspaceDomain.host')=?").get(id, host)) fail(409, 'Este domínio já está vinculado a outra conta.');
      if (binding && binding.host !== host) fail(409, 'Remova o vínculo anterior antes de cadastrar outro domínio.');
      if (binding && binding.state !== 'disabled') return binding;
      return { host, state: 'pending', challenge: randomBytes(32).toString('hex'), configuredAt: this.stamp(), verifiedAt: null, lastCheck: null, deployment: null };
    });
  }
  async bounded(operation) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('A consulta externa excedeu o prazo.'), { status: 504 })), this.dnsTimeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  async dnsCheck(binding) {
    const results = await this.bounded(() => Promise.allSettled([Promise.resolve().then(() => this.resolver.resolveTxt(`_elozi-verification.${binding.host}`)), Promise.resolve().then(() => this.resolver.resolveCname(binding.host))]));
    const txt = results[0].status === 'fulfilled' && results[0].value, cname = results[1].status === 'fulfilled' && results[1].value;
    const txtOwnership = Array.isArray(txt) && txt.length <= 64 && txt.some(record => Array.isArray(record) && record.length <= 16 && record.every(chunk => typeof chunk === 'string' && chunk.length <= 255) && record.join('') === `elozi-verification=${binding.challenge}`);
    let cnameTarget = false;
    if (Array.isArray(cname) && cname.length === 1) { try { cnameTarget = normalizeWorkspaceHost(cname[0]) === this.canonicalHost; } catch { /* DNS data is untrusted. */ } }
    const cnameAbsent=results[1].status==='fulfilled'?Array.isArray(cname)&&cname.length===0:['ENODATA','ENOTFOUND'].includes(results[1].reason?.code);
    return { txtOwnership, cnameTarget,cnameAbsent, checkedAt: this.stamp() };
  }
  async verify(inputActor, id, input) {
    fields(input, ['version']); const version = input.version, first = this.first(inputActor, id, version), binding = this.metadata(first.account);
    if (!binding || binding.state === 'disabled') fail(409, 'Cadastre um domínio ativo para conferir o DNS.');
    let checks;
    try { checks = await this.dnsCheck(binding); } catch (error) { this.first(inputActor, id, version); throw error; }
    this.first(inputActor, id, version);
    if(checks.txtOwnership&&!checks.cnameTarget&&checks.cnameAbsent&&this.inspectDeployment){
      let evidence;try{evidence=await this.bounded(()=>this.inspectDeployment(binding.host,{workspaceId:id,canonicalHost:this.canonicalHost,challenge:binding.challenge,version}));}catch{ /* Preserve explicit failed DNS verification; never accept an unsigned or unreachable route. */ }
      this.first(inputActor,id,version);
      checks.routeVerified=Boolean(evidence?.signedRouteVerified===true&&evidence.host===binding.host&&evidence.httpsOrigin===`https://${binding.host}`&&evidence.tlsValid===true&&evidence.proxyVerified===true&&validInstant(evidence.certificateExpiresAt)&&evidence.certificateExpiresAt>this.instant());
    }
    const verified=checks.txtOwnership&&(checks.cnameTarget||checks.routeVerified===true);
    return this.commit(inputActor, id, version, first, verified ? 'account.domain.verified' : 'account.domain.verification-failed', current => {
      if (!current || current.host !== binding.host || current.challenge !== binding.challenge || current.state === 'disabled') fail(409, 'O vínculo de domínio mudou. Atualize a conta.');
      return { ...current, state: verified ? current.state === 'active' ? 'active' : 'verified' : 'pending', verifiedAt: verified ? current.verifiedAt || checks.checkedAt : null,
        lastCheck: checks, deployment: verified ? current.deployment : null };
    });
  }
  disable(inputActor, id, input) {
    fields(input, ['version']); const first = this.first(inputActor, id, input.version);
    return this.commit(inputActor, id, input.version, first, 'account.domain.disabled', current => current && current.state !== 'disabled' ? { ...current, state: 'disabled', verifiedAt: null, deployment: null } : current);
  }
  remove(inputActor, id, input) {
    fields(input, ['version']); const first = this.first(inputActor, id, input.version);
    return this.commit(inputActor, id, input.version, first, 'account.domain.removed', () => null);
  }
  async confirmDeployment(inputActor, id, input) {
    fields(input, ['version']); const version = input.version, first = this.first(inputActor, id, version, { platformOnly: true }), binding = this.metadata(first.account);
    if (!binding?.verifiedAt || !['verified', 'active'].includes(binding.state)) fail(409, 'Confira primeiro a propriedade e o destino do domínio no DNS.');
    if (!this.inspectDeployment) fail(503, 'A inspeção técnica de HTTPS e proxy ainda não está configurada. O domínio permanece verificado, sem ativação.');
    // Only a server-side inspector may provide evidence. It must verify TLS with trusted CAs,
    // reject private/rebound addresses and confirm this Elozi deployment before returning.
    let evidence;
    try { evidence = await this.bounded(() => this.inspectDeployment(binding.host, { workspaceId: id, canonicalHost: this.canonicalHost,challenge:binding.challenge,version })); }
    catch (error) {
      this.first(inputActor, id, version, { platformOnly: true });
      fail(error.status === 504 ? 504 : 502, error.status === 504 ? 'A inspeção técnica excedeu o prazo.' : 'A inspeção técnica de HTTPS e proxy não pôde ser concluída.');
    }
    this.first(inputActor, id, version, { platformOnly: true });
    if (!evidence || evidence.host !== binding.host || evidence.httpsOrigin !== `https://${binding.host}` || evidence.tlsValid !== true || evidence.proxyVerified !== true
      || !validInstant(evidence.certificateExpiresAt) || evidence.certificateExpiresAt <= this.instant()) fail(502, 'HTTPS, certificado ou proxy ainda não comprovados para este domínio.');
    const deployment = { host: binding.host, httpsOrigin: evidence.httpsOrigin, canonicalHost: this.canonicalHost, tlsValid: true, proxyVerified: true,
      observedAt: this.stamp(), certificateExpiresAt: evidence.certificateExpiresAt,
      ...(typeof evidence.sourceRevision === 'string' && /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(evidence.sourceRevision) ? { sourceRevision: evidence.sourceRevision } : {}) };
    return this.commit(inputActor, id, version, first, 'account.domain.activated', current => {
      if (!current?.verifiedAt || current.host !== binding.host || current.challenge !== binding.challenge || !['verified', 'active'].includes(current.state)) fail(409, 'O vínculo de domínio mudou. Atualize a conta.');
      return { ...current, state: 'active', deployment };
    }, { platformOnly: true });
  }
  resolve(value) {
    let host;
    try { host = normalizeWorkspaceHost(value); } catch { return null; }
    const rows = this.db.prepare("SELECT id,json_extract(data,'$.workspaceDomain') AS binding,json_extract(data,'$.brand') AS brand FROM resellers WHERE json_extract(data,'$.workspaceDomain.host')=?").all(host);
    if (rows.length !== 1) return null;
    try {
      const binding = this.metadata({ data: { workspaceDomain: JSON.parse(rows[0].binding) } });
      if (binding.state !== 'active' || !this.deploymentValid(binding)) return null;
      return { workspaceId: rows[0].id, host, brand: publicBrand(rows[0].brand ? JSON.parse(rows[0].brand) : null) };
    } catch { return null; }
  }
}
