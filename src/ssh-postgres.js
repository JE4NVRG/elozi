import { spawn } from 'node:child_process';

// Keep the remote command constant. Credentials and SQL travel only over stdin.
// The SSH host (an ssh_config alias or hostname) and the database container are deployment configuration:
// MEPCHAT_POSTGRES_SSH_HOST is required (no default host, transport disabled when unset) and
// MEPCHAT_POSTGRES_CONTAINER defaults to the self-hosted Supabase container name.
export const POSTGRES_SSH_HOST_ENV = 'MEPCHAT_POSTGRES_SSH_HOST';
export const POSTGRES_CONTAINER_ENV = 'MEPCHAT_POSTGRES_CONTAINER';
export const DEFAULT_POSTGRES_CONTAINER = 'supabase-db';
const SSH_HOST_PATTERN = /^(?:[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}@)?[A-Za-z0-9_][A-Za-z0-9_.-]{0,252}$/;
const CONTAINER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export class PostgresSshConfigError extends Error {
  constructor(message) { super(message); this.name = 'PostgresSshConfigError'; this.code = 'POSTGRES_SSH_NOT_CONFIGURED'; }
}
/** Resolves and validates the SSH target. Values never start with '-', so they cannot become ssh/docker options. */
export function postgresSshTarget(env = process.env) {
  const host = typeof env?.[POSTGRES_SSH_HOST_ENV] === 'string' ? env[POSTGRES_SSH_HOST_ENV].trim() : '';
  if (!host) throw new PostgresSshConfigError(`PostgreSQL over SSH is disabled: set ${POSTGRES_SSH_HOST_ENV} (ssh host alias) to enable it.`);
  if (!SSH_HOST_PATTERN.test(host)) throw new PostgresSshConfigError(`${POSTGRES_SSH_HOST_ENV} is not a valid ssh host.`);
  const rawContainer = typeof env?.[POSTGRES_CONTAINER_ENV] === 'string' ? env[POSTGRES_CONTAINER_ENV].trim() : '';
  const container = rawContainer || DEFAULT_POSTGRES_CONTAINER;
  if (!CONTAINER_PATTERN.test(container)) throw new PostgresSshConfigError(`${POSTGRES_CONTAINER_ENV} is not a valid container name.`);
  return Object.freeze({ host, container });
}
export function sshPostgresArgs(env = process.env) {
  const { host, container } = postgresSshTarget(env);
  return Object.freeze([
    '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host,
    `docker exec -i ${container} sh -c 'IFS= read -r PGPASSWORD; export PGPASSWORD; exec psql -h 127.0.0.1 -X -q -At -v ON_ERROR_STOP=1 -U mepchat_app -d mepchat'`
  ]);
}
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_REVISION = 9223372036854775807n;
const message = 'Sincronização PostgreSQL por SSH indisponível.';
const uuidSuffix = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const resellerIdPattern = new RegExp(`^reseller_${uuidSuffix}$`);
const tenantIdPattern = new RegExp(`^tenant_${uuidSuffix}$`);

function identifier(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('Escopo PostgreSQL inválido.');
  return value;
}
function revisionValue(value) {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('Revisão PostgreSQL inválida.');
    return String(value);
  }
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value)) throw new TypeError('Revisão PostgreSQL inválida.');
  const parsed = BigInt(value);
  if (parsed < 1n || parsed > MAX_REVISION) throw new TypeError('Revisão PostgreSQL inválida.');
  return parsed.toString();
}
function sqlText(value) {
  return `convert_from(decode('${Buffer.from(value, 'utf8').toString('base64')}','base64'),'UTF8')`;
}
function transaction({ tenantId, payload, sourceId, revision }) {
  identifier(tenantId); identifier(sourceId); const normalizedRevision = revisionValue(revision);
  let serialized, snapshot;
  try {
    serialized = typeof payload === 'string' ? payload : JSON.stringify(payload);
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_PAYLOAD_BYTES) throw new Error();
    snapshot = JSON.parse(serialized);
  } catch { throw new TypeError('Snapshot PostgreSQL inválido ou acima de 4 MiB.'); }
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot) || snapshot.id !== tenantId || (snapshot.resellerId !== 'mep-demo' && !resellerIdPattern.test(snapshot.resellerId))) throw new TypeError('Escopo do snapshot PostgreSQL inválido.');
  const resellerSql = snapshot.resellerId === 'mep-demo' ? "'mep-demo'" : sqlText(snapshot.resellerId);
  // The DB verifies the private source capability and rejects pre-existing IDs.
  const provision = resellerIdPattern.test(snapshot.resellerId) && tenantIdPattern.test(tenantId)
    ? ` PERFORM mepchat_private.provision_reseller(${resellerSql},${sqlText(tenantId)},${sqlText(sourceId)});\n` : '';
  return { revision: normalizedRevision, sql: `BEGIN;
DO $mepchat_transport$
BEGIN
 IF current_user IS DISTINCT FROM 'mepchat_app' OR current_database() IS DISTINCT FROM 'mepchat' THEN
  RAISE EXCEPTION 'Database identity denied';
 END IF;
 PERFORM set_config('mepchat.user_id','mepchat-local-bridge',true);
 PERFORM set_config('mepchat.reseller_id',${resellerSql},true);
 PERFORM set_config('mepchat.tenant_id',${sqlText(tenantId)},true);
${provision}END;
$mepchat_transport$;
SELECT jsonb_build_object('state',result->>'state','revision',result->>'revision')
FROM (SELECT mepchat_private.sync_workspace(${sqlText(serialized)}::jsonb,${sqlText(sourceId)},${normalizedRevision}::bigint) AS result) AS synced;
COMMIT;
` };
}
export function deletionTransaction({ tenantId, resellerId, sourceId }) {
  identifier(sourceId);
  if (!tenantIdPattern.test(tenantId) || !resellerIdPattern.test(resellerId)) throw new TypeError('Escopo da exclusão PostgreSQL inválido.');
  return `BEGIN;
DO $mepchat_transport$
BEGIN
 IF current_user IS DISTINCT FROM 'mepchat_app' OR current_database() IS DISTINCT FROM 'mepchat' THEN
  RAISE EXCEPTION 'Database identity denied';
 END IF;
 PERFORM set_config('mepchat.user_id','mepchat-local-bridge',true);
 PERFORM set_config('mepchat.reseller_id',${sqlText(resellerId)},true);
 PERFORM set_config('mepchat.tenant_id',${sqlText(tenantId)},true);
END;
$mepchat_transport$;
SELECT mepchat_private.delete_workspace_tenant(${sqlText(resellerId)},${sqlText(tenantId)},${sqlText(sourceId)});
COMMIT;
`;
}
function metadata(bytes, minimumRevision) {
  const result = JSON.parse(bytes.toString('utf8').trim());
  if (!result || !['synced', 'already_synced'].includes(result.state) || typeof result.revision !== 'string') throw new Error();
  const revision = revisionValue(result.revision);
  if (BigInt(revision) < BigInt(minimumRevision)) throw new Error();
  return { state: result.state, revision };
}

/** One SSH/psql child and one transaction per snapshot; no automatic retries. */
export class SshPostgresTransport {
  #password; #spawn; #timeout; #args; #children = new Map(); #closed = false;
  constructor({ password, spawnImpl = spawn, timeoutMs = 30000, env = process.env } = {}) {
    if (typeof password !== 'string' || !password || /[\r\n\u0000]/.test(password) || Buffer.byteLength(password, 'utf8') > 4096) throw new TypeError('Credencial PostgreSQL inválida.');
    if (typeof spawnImpl !== 'function' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) throw new TypeError('Configuração do transporte PostgreSQL inválida.');
    this.#args = sshPostgresArgs(env);
    this.#password = password; this.#spawn = spawnImpl; this.#timeout = timeoutMs;
  }
  get args() { return this.#args; }
  async sync(input) {
    if (this.#closed) throw new Error('Transporte PostgreSQL encerrado.');
    const { sql, revision } = transaction(input);
    return this.#execute(sql, bytes => metadata(bytes, revision));
  }
  /** Account deletion tombstone: one company of a self-registered workspace, same identity checks as sync. */
  async deleteWorkspaceTenant(input) {
    if (this.#closed) throw new Error('Transporte PostgreSQL encerrado.');
    const sql = deletionTransaction(input);
    return this.#execute(sql, bytes => {
      const result = JSON.parse(bytes.toString('utf8').trim());
      if (!result || !['deleted', 'absent'].includes(result.state)) throw new Error();
      return { state: result.state };
    });
  }
  #execute(sql, parse) {
    return new Promise((resolve, reject) => {
      let child;
      try { child = this.#spawn('ssh', [...this.#args], { stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true }); }
      catch { reject(new Error(message)); return; }
      let settled = false, size = 0, timer, inputBytes;
      const output = [];
      const kill = () => { try { child.kill('SIGKILL'); } catch {} };
      const finish = (error, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); inputBytes?.fill(0); output.length = 0;
        if (error) reject(new Error(error)); else resolve(result);
      };
      const abort = error => { kill(); finish(error); };
      this.#children.set(child, () => abort('Transporte PostgreSQL encerrado.'));
      child.on('error', () => abort(message));
      child.stdin.on('error', () => abort(message));
      child.stdout.on('error', () => abort(message));
      child.stderr.on('error', () => {});
      child.stderr.resume(); // psql errors may contain SQL/snapshot data: never retain them.
      child.stdout.on('data', chunk => {
        if (settled) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > MAX_OUTPUT_BYTES) abort('Resposta PostgreSQL excedeu o limite.');
        else output.push(bytes);
      });
      child.on('close', (code, signal) => {
        this.#children.delete(child);
        if (settled) return;
        if (code !== 0 || signal) { finish(message); return; }
        try { finish(null, parse(Buffer.concat(output))); }
        catch { finish(message); }
      });
      timer = setTimeout(() => abort('Tempo limite da sincronização PostgreSQL por SSH.'), this.#timeout);
      inputBytes = Buffer.from(`${this.#password}\n${sql}`, 'utf8');
      try { child.stdin.end(inputBytes, () => inputBytes.fill(0)); }
      catch { abort(message); }
    });
  }
  close() {
    this.#closed = true;
    this.#password = undefined;
    for (const abort of this.#children.values()) abort();
  }
}
