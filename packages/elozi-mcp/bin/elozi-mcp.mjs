#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge, readBridgeConfig, VERSION } from '../src/bridge.mjs';

const HELP = `Elozi MCP bridge ${VERSION}

Connects a local MCP stdio client to the hosted Elozi MCP endpoint.

Environment (set it in your MCP client's private configuration):
  ELOZI_API_TOKEN  required. Agent token from Elozi: Agents > Connected agents.
  ELOZI_BASE_URL   optional. Panel origin, default https://elozi.je4ndev.com.
                   HTTPS required (plain HTTP only for localhost).

Run without arguments for MCP stdio. Options: --help, --version.`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
} else if (process.argv.includes('--version')) {
  console.log(VERSION);
} else if (process.argv.length > 2) {
  console.error('elozi-mcp: no command arguments are accepted. Store the token in ELOZI_API_TOKEN, never on the command line.');
  process.exitCode = 1;
} else {
  let bridge;
  try {
    bridge = await createBridge(readBridgeConfig());
    const stop = async () => { await bridge.close(); process.exitCode = 0; };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    process.stdin.once('end', stop);
    await bridge.server.connect(new StdioServerTransport());
  } catch (error) {
    await bridge?.close();
    // Only our controlled startup messages are printed. Never echo a token or upstream body.
    console.error('elozi-mcp: ' + (error instanceof Error && /^(Set ELOZI_API_TOKEN|ELOZI_BASE_URL|Cannot connect to Elozi)/.test(error.message)
      ? error.message : 'could not start. Check the private client configuration.'));
    process.exitCode = 1;
  }
}
