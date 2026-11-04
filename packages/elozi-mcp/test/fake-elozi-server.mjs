// Local fake of the hosted Elozi MCP endpoint: stateless, POST-only, Bearer-authenticated.
// Test-only; never contacts the network beyond 127.0.0.1.
import { createServer } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

export const INSTRUCTIONS = 'Fake Elozi: the service identity determines company, channels and departments.';
export const TOOLS = [
  { name: 'elozi_me', title: 'My identity', description: 'Fake identity tool.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'elozi_read_conversation', title: 'Read conversation', description: 'Fake read.', inputSchema: { type: 'object', properties: { requestId: { type: 'string' }, conversationId: { type: 'string' } }, required: ['requestId', 'conversationId'], additionalProperties: false } },
];

export async function startFakeElozi({ token, redirectTo } = {}) {
  const requests = [];
  const http = createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, sessionId: req.headers['mcp-session-id'] });
    if (redirectTo) { res.writeHead(307, { Location: redirectTo }); res.end(); return; }
    if (req.url !== '/api/agent/mcp') { res.writeHead(404); res.end(); return; }
    if (req.headers.authorization !== 'Bearer ' + token) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="elozi-service"' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Identidade de serviço inválida.' } }));
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' }); res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32000,"message":"POST only"}}'); return; }
    if (req.headers['mcp-session-id']) { res.writeHead(400); res.end(); return; }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const server = new Server({ name: 'elozi-service-mcp', version: '0.1.0' }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS }));
    server.setRequestHandler(CallToolRequestSchema, (request) => {
      if (request.params.name === 'elozi_me') {
        const result = { principal: { id: 'svc-test', capabilities: ['conversation.read'] } };
        return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
      }
      if (request.params.name === 'elozi_read_conversation') {
        if (request.params.arguments?.conversationId === 'forbidden') {
          const error = { status: 403, message: 'A identidade de serviço não tem esta capacidade.' };
          return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }], structuredContent: { error } };
        }
        throw new McpError(ErrorCode.InvalidParams, 'Argumentos inválidos.');
      }
      throw new McpError(ErrorCode.InvalidParams, 'Ferramenta não implementada neste MCP.');
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try { await server.connect(transport); await transport.handleRequest(req, res, body); }
    finally { await server.close().catch(() => {}); }
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => { http.closeAllConnections?.(); http.close(() => resolve()); }),
  };
}
