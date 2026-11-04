#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createAgentQueryBridge, createAgentQueryMcpServer, loadAgentQueryConfig } from '../src/agent-query-bridge.js';

let bridge, server, closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await server?.close().catch(() => {});
  await bridge?.close().catch(() => {});
}
try {
  bridge = createAgentQueryBridge(await loadAgentQueryConfig());
  server = createAgentQueryMcpServer(bridge);
  server.onclose = () => { void bridge.close(); };
  process.once('SIGINT', () => { void close().finally(() => { process.exitCode = 0; }); });
  process.once('SIGTERM', () => { void close().finally(() => { process.exitCode = 0; }); });
  process.stdin.once('end', () => { void close(); });
  await server.connect(new StdioServerTransport());
} catch {
  process.stderr.write('A consulta Elozi não iniciou. Confira o arquivo privado de configuração e as variáveis de credenciais existentes.\n');
  await close(); process.exitCode = 1;
}
