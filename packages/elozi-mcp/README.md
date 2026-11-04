# Elozi MCP

Connect your desktop AI agent (Claude Desktop, Claude Code, Cursor, Codex or any MCP stdio client) to your [Elozi](https://elozi.je4ndev.com) customer-service workspace. With a scoped agent token, the agent can read the conversations you authorized, prepare drafts for human review, and, only if you grant it, reply, hand over to your team, tag and close conversations assigned to it.

The hosted endpoint is `https://elozi.je4ndev.com/api/agent/mcp` (Streamable HTTP, stateless, Bearer token). Clients that support remote HTTP MCP servers can connect to it directly. This package is a small stdio bridge for clients that only run local commands. It forwards to the same hosted service using the official MCP SDK; it does not host data locally.

## What it does

- Forwards `initialize`, `tools/list` and `tools/call` (and resources/prompts, only if the server advertises them) to Elozi.
- Sends the token only in the `Authorization: Bearer` header over HTTPS.
- The tool catalog follows your token: `tools/list` shows only the tools your token's capabilities allow (for example `elozi_me`, `elozi_list_conversations`, `elozi_read_conversation`, `elozi_search_conversations`, `elozi_submit_draft`, `elozi_wait_for_events`, `elozi_send_reply`, `elozi_transfer_to_human`).
- Does not add telemetry, local storage, account switching or automatic retries of tool calls.

## Get an agent token in Elozi

1. Sign in to your Elozi panel and open the right company.
2. In **Agents**, create an agent of type **Agent via MCP** (copilot mode), with a name and role.
3. In **Agents > Connected agents**, create a service identity for that agent. Choose the channels, departments, capabilities, validity and daily quotas. Start small: `conversation.read` plus `reply.submit` (drafts reviewed by a person). Grant `reply.send`, `conversation.manage` or `events.read` only when you want the agent to act on its own.
4. Copy the token (it starts with `elozi_svc_`). Elozi shows it only once and stores only a hash. Put it in your MCP client's private configuration as `ELOZI_API_TOKEN`. Never paste it in a chat, URL, ticket or command argument.

Each token belongs to one company. To use several companies, create one token per company and one MCP server entry per token.

## Configure your client

Requires Node.js 22 or later. Replace the placeholder only in your private configuration file.

### Claude Desktop

`claude_desktop_config.json` (Settings > Developer > Edit config):

```json
{
  "mcpServers": {
    "elozi": {
      "command": "npx",
      "args": ["-y", "elozi-mcp@0.1.1"],
      "env": { "ELOZI_API_TOKEN": "elozi_svc_YOUR_TOKEN" }
    }
  }
}
```

On Windows, if `npx` is not found, use the absolute path of `npx.cmd` (for example `C:\\Program Files\\nodejs\\npx.cmd`).

### Claude Code

Native HTTP (no package needed). Export `ELOZI_API_TOKEN` in your shell profile first:

```bash
claude mcp add --transport http elozi https://elozi.je4ndev.com/api/agent/mcp --header "Authorization: Bearer ${ELOZI_API_TOKEN}"
```

Or through this bridge:

```bash
claude mcp add elozi --env ELOZI_API_TOKEN="$ELOZI_API_TOKEN" -- npx -y elozi-mcp@0.1.1
```

Both commands write the token value into your Claude Code configuration; keep that file private.

### Cursor

`~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project that is not committed):

```json
{
  "mcpServers": {
    "elozi": {
      "command": "npx",
      "args": ["-y", "elozi-mcp@0.1.1"],
      "env": { "ELOZI_API_TOKEN": "elozi_svc_YOUR_TOKEN" }
    }
  }
}
```

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.elozi]
command = "npx"
args = ["-y", "elozi-mcp@0.1.1"]
env = { ELOZI_API_TOKEN = "elozi_svc_YOUR_TOKEN" }
```

### Custom panel domain

If your company uses its own Elozi panel domain, set `ELOZI_BASE_URL` to that origin, for example `https://atendimento.example.com`. The bridge appends `/api/agent/mcp`. HTTPS is required (plain HTTP only for `localhost`). Credentials, paths, query strings and fragments are rejected. A token only works on the panel of its own company.

### First check

Restart the client, then ask: "Call elozi_me and tell me which company, channels and capabilities this token has. Make no changes." Then list the tools. `elozi-mcp --help` and `elozi-mcp --version` work without a token.

## Security notes

- **Scope.** The token carries company, channels, departments, capabilities, validity and quotas chosen in the panel. The bridge cannot widen it. New tools never silently expand an existing token.
- **Revoke or rotate** at any time in **Agents > Connected agents**. The next request with the old token fails with 401.
- **Human review by default.** Drafts and proposals wait for a person. Direct replies exist only with explicit `reply.send`, only in private conversations assigned to the agent, with per-conversation rate limits. Requests for a human, complaints or customer media block the reply and ask for a transfer.
- **No automatic retry.** A failed or timed-out send is not proof that it was not delivered. Read the receipt with `elozi_get_receipt` and the same `requestId` before any manual retry.
- **Errors are sanitized.** The bridge never prints the token, upstream bodies or headers. Startup errors go to stderr.
- **Redirects are rejected.** The bridge never follows a redirect, so the token is never sent to another host.
- **WhatsApp QR channels.** Channels linked by QR code follow the risk notice shown in the Elozi product (risk of restriction or blocking by WhatsApp). Using an agent does not change that risk; keep volumes and automation conservative.

## Troubleshooting

- `Set ELOZI_API_TOKEN ...`: the variable is missing or not in the `elozi_svc_` format.
- `Cannot connect to Elozi ... 401`: token invalid, paused, expired or revoked.
- `403` on a call: capability, channel or department not granted, or the panel domain belongs to another company.
- `409` on a reply: stale conversation version, or the reply was blocked by policy (transfer to a human instead).
- `429`: reply rate limit; wait for `retryAfter`.

## Português (PT-BR)

O `elozi-mcp` conecta seu agente de IA no computador (Claude Desktop, Claude Code, Cursor, Codex ou outro cliente MCP stdio) ao atendimento da sua empresa na Elozi. Ele repassa as chamadas para `https://elozi.je4ndev.com/api/agent/mcp` com uma chave de agente própria, limitada e revogável.

**Como obter a chave:** no painel da Elozi, na empresa correta, abra **Agentes** e crie um **Agente via MCP** (modo copiloto). Em **Agentes > Agentes conectados**, crie a identidade de serviço desse agente: canais, departamentos, capacidades, validade e cotas. Comece com `conversation.read` e `reply.submit` (rascunhos revisados por uma pessoa). Copie a chave (`elozi_svc_...`): ela aparece uma única vez. Guarde-a na configuração privada do cliente como `ELOZI_API_TOKEN`; nunca cole em conversa, URL ou argumento de comando.

**Configuração:** use os exemplos acima (Claude Desktop, Claude Code, Cursor, Codex). Painel com domínio próprio: defina `ELOZI_BASE_URL` com a origem HTTPS do painel.

**Segurança:** a chave só acessa o que foi concedido no painel e pode ser revogada ou rotacionada em **Agentes conectados**. Rascunhos aguardam revisão humana; envio direto exige `reply.send` explícito e vale só para conversas atribuídas ao agente. Sem reenvio automático: em caso de falha ou tempo esgotado, consulte o recibo com `elozi_get_receipt` e a mesma `requestId`. Canais de WhatsApp conectados por QR seguem o aviso de risco do produto (risco de restrição ou bloqueio pelo WhatsApp).

## License

MIT for this bridge only. The hosted Elozi service, its data and terms of use are separate. Help: [elozi.je4ndev.com](https://elozi.je4ndev.com).
