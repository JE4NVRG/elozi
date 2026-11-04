import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema,
  ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema, McpError, ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';

export const VERSION = '0.1.0';
export const DEFAULT_BASE_URL = 'https://elozi.je4ndev.com';
export const MCP_PATH = '/api/agent/mcp';
export const TOKEN_PATTERN = /^elozi_svc_[A-Za-z0-9_-]{43}$/;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Reads ELOZI_API_TOKEN (required) and ELOZI_BASE_URL (optional origin, default https://elozi.je4ndev.com).
 * Error messages never contain the token value.
 */
export function readBridgeConfig(env = process.env) {
  const token = typeof env.ELOZI_API_TOKEN === 'string' ? env.ELOZI_API_TOKEN.trim() : '';
  if (!token) throw new Error('Set ELOZI_API_TOKEN to an Elozi agent token (Agents > Connected agents). Do not pass it in command arguments.');
  if (!TOKEN_PATTERN.test(token)) throw new Error('Set ELOZI_API_TOKEN to a valid Elozi agent token (it starts with elozi_svc_). The current value has an unexpected format.');
  let base;
  try { base = new URL(env.ELOZI_BASE_URL || DEFAULT_BASE_URL); }
  catch { throw new Error('ELOZI_BASE_URL must be a valid HTTPS origin, for example https://elozi.je4ndev.com.'); }
  const loopback = LOOPBACK.has(base.hostname);
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new Error('ELOZI_BASE_URL must use HTTPS (plain HTTP is accepted only for localhost).');
  }
  if (base.username || base.password || base.search || base.hash || (base.pathname !== '/' && base.pathname !== '')) {
    throw new Error('ELOZI_BASE_URL must be only an origin, without credentials, path, query string or fragment.');
  }
  return { endpoint: new URL(MCP_PATH, base.origin), token };
}

const SAFE_MESSAGES = {
  [-32001]: 'Elozi rejected the token (401). It may be invalid, paused, expired or revoked. Create or rotate it in Agents > Connected agents.',
  [-32003]: 'Elozi denied this request (403). Check the token capabilities, channels and departments, and that the panel domain matches the token company.',
  [ErrorCode.InvalidParams]: 'Elozi rejected the arguments: use only the fields and limits declared by the tool.',
};

/** Stdio server that forwards advertised MCP features to the hosted Elozi endpoint. No telemetry, persistence or retry. */
export async function createBridge(config, { fetch: fetchOverride } = {}) {
  const remote = new Client({ name: 'elozi-mcp', version: VERSION }, { capabilities: {} });
  const guardedFetch = async (url, init) => {
    const response = await (fetchOverride || fetch)(url, { ...init, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('Endpoint redirects are not permitted.');
    }
    return response;
  };
  const transport = new StreamableHTTPClientTransport(config.endpoint, {
    requestInit: { headers: { Authorization: 'Bearer ' + config.token }, redirect: 'error' },
    fetch: guardedFetch,
  });
  // Never print raw transport failures, response bodies, headers or credentials.
  remote.onerror = () => {};
  try { await remote.connect(transport); }
  catch (error) {
    await remote.close().catch(() => {});
    const status = error instanceof StreamableHTTPError ? error.code : error instanceof UnauthorizedError ? 401 : undefined;
    const reason = status === 401 ? ' The token was rejected (401): check that it is current and not revoked.'
      : status === 403 ? ' Access was denied (403): check the panel domain and token company.'
      : '';
    throw new Error('Cannot connect to Elozi at ' + config.endpoint.origin + '.' + reason + ' No tool has been called.');
  }
  const capabilities = remote.getServerCapabilities() || {};
  const server = new Server({ name: 'elozi-mcp', version: VERSION }, {
    capabilities: {
      ...(capabilities.tools ? { tools: {} } : {}),
      ...(capabilities.resources ? { resources: {} } : {}),
      ...(capabilities.prompts ? { prompts: {} } : {}),
    },
    instructions: remote.getInstructions(),
  });
  const forward = (run) => async (request, extra) => {
    try { return await run(request.params, { signal: extra.signal, timeout: 60_000 }); }
    catch (error) {
      const code = error instanceof McpError ? error.code
        : error instanceof UnauthorizedError ? -32001
        : error instanceof StreamableHTTPError && error.code === 401 ? -32001
        : error instanceof StreamableHTTPError && error.code === 403 ? -32003
        : -32603;
      throw new McpError(code, SAFE_MESSAGES[code] || 'Elozi request failed. A failed or timed-out send is not proof that it was not delivered: check the receipt with elozi_get_receipt and the same requestId before any manual retry.');
    }
  };
  if (capabilities.tools) {
    server.setRequestHandler(ListToolsRequestSchema, forward((params, options) => remote.listTools(params, options)));
    server.setRequestHandler(CallToolRequestSchema, forward((params, options) => remote.callTool(params, undefined, options)));
  }
  if (capabilities.resources) {
    server.setRequestHandler(ListResourcesRequestSchema, forward((params, options) => remote.listResources(params, options)));
    server.setRequestHandler(ReadResourceRequestSchema, forward((params, options) => remote.readResource(params, options)));
  }
  if (capabilities.prompts) {
    server.setRequestHandler(ListPromptsRequestSchema, forward((params, options) => remote.listPrompts(params, options)));
    server.setRequestHandler(GetPromptRequestSchema, forward((params, options) => remote.getPrompt(params, options)));
  }
  return {
    server,
    async close() { await Promise.allSettled([server.close(), remote.close()]); },
  };
}
