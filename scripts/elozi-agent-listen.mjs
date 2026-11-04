#!/usr/bin/env node
import { AgentEventListener, AgentEventListenerError, loadAgentEventConfig } from '../src/agent-event-listener.js';

// Deliberately only a private config path and an optional finite cycle bound: never credentials/URLs/commands in argv.
const help = 'Uso: node scripts/elozi-agent-listen.mjs --config CAMINHO_ABSOLUTO.json [--max-cycles 1..10000]\n' +
  'Ou ELOZI_AGENT_LISTENER_CONFIG_PATH. Processo local opt-in; Ctrl+C encerra.\n' +
  'Exige conversation.read e events.read; servidores antigos precisam de company.read ou atualização. Retomada usa todas as páginas; servidor legado com 50 itens sem cursor bloqueia cobertura.\n' +
  'Config: endpoint (/api/service/v1), tokenEnv, checkpointPath, activation {url, secretEnv, timeoutMs?}.\n' +
  'HTTP só com IP loopback literal e allowLoopback:true em cada destino. Credenciais só via ambiente.\n' +
  'Receptor verifica HMAC/frescor, deduplica Idempotency-Key duravelmente e confirma {accepted:true,idempotencyKey}.\n' +
  'Ponteiro não autoriza ações: receptor relê escopo/dono/versão; MCP reconcilia o requestId original.\n';
let listener;
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(help); }
  else {
    let path = process.env.ELOZI_AGENT_LISTENER_CONFIG_PATH, maxCycles = Infinity;
    const seen = new Set();
    for (let index = 0; index < args.length; index += 2) {
      const flag = args[index], value = args[index + 1];
      if (!['--config', '--max-cycles'].includes(flag) || seen.has(flag) || typeof value !== 'string') throw new AgentEventListenerError('ARGUMENT_INVALID');
      seen.add(flag);
      if (flag === '--config') path = value;
      else { if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 10000) throw new AgentEventListenerError('ARGUMENT_INVALID'); maxCycles = Number(value); }
    }
    const config = await loadAgentEventConfig(path);
    listener = new AgentEventListener(config);
    const controller = new AbortController(), stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      const result = await listener.run({ signal: controller.signal, maxCycles });
      process.stdout.write(JSON.stringify({ status: controller.signal.aborted ? 'stopped' : 'bounded_complete', ...result }) + '\n');
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  }
} catch (error) {
  // Never print arbitrary messages/stacks/HTTP bodies, even when a provider deliberately echoes a bearer.
  const code = error instanceof AgentEventListenerError ? error.code : 'LISTENER_FAILED';
  process.stderr.write(JSON.stringify({ status: 'stopped', code }) + '\n'); process.exitCode = 1;
} finally { await listener?.close(); }
