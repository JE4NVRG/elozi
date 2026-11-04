# Elozi

**Open-source customer-service inbox for small teams: WhatsApp, Telegram, web chat and e-mail in one place, with AI
agents that draft, propose and act only inside the limits you approve.**

Elozi is a self-hostable Node.js app (built-in `node:sqlite`, no external database required) with a multi-company
panel, team inbox, CRM basics, flows and an MCP endpoint for AI agents. A hosted version is available at
[elozi.je4ndev.com](https://elozi.je4ndev.com).

> Status: early open-source release. APIs and the database schema may still change between versions.

## Features

- **Unified inbox** – conversations from every channel with filters, search, internal notes, assignments,
  departments, tags, open/pending/closed states and per-company SLA targets.
- **Channels** – WhatsApp via QR code (unofficial library, see disclaimer), Telegram bot and Telegram account,
  embeddable web chat widget and e-mail channel. Encrypted media (images, audio, video, documents).
- **Teams and companies** – several companies (and resellers) per installation, roles, team chat, local
  password login (scrypt), optional Google sign-in, invitations.
- **AI agents with guardrails** – Hermes/LLM copilot drafts, tool proposals that need human approval, private
  knowledge base per company, scoped service tokens with daily quotas, audit trail.
- **MCP** – a Streamable HTTP MCP endpoint (`/api/agent/mcp`) and the stdio bridge
  [`elozi-mcp`](https://www.npmjs.com/package/elozi-mcp) (source in `packages/elozi-mcp`) for Claude, Codex,
  Cursor and other MCP clients.
- **Flows and automation** – triggers by channel/entry/command/schedule, versioned publishing and simulation.
- **Operations** – encrypted local backups (AES-GCM) with verified restore, idempotent outbox, health endpoints
  (`/api/health`, `/api/health/ready`), optional Stripe subscriptions, English and Portuguese (PT-BR) UI.

## Quickstart

### Node.js

Requires **Node.js 24+**.

```bash
git clone https://github.com/JE4NVRG/elozi.git
cd elozi
npm ci
npm start
# open http://127.0.0.1:4318
```

Data lives in `data/sandbox.sqlite`; local encryption keys are created under `$LOCALAPPDATA/MEPChat`
(or `~/.local/share/MEPChat` on Linux/macOS). Back them up together; without the keys, encrypted sessions and
media cannot be read.

### Docker

```bash
docker build -t elozi .
docker run -d --name elozi \
  -p 127.0.0.1:4318:4318 \
  -v elozi-data:/app/data \
  -v elozi-secrets:/run/elozi-secrets-parent \
  -e MEPCHAT_PUBLIC_ORIGIN=http://127.0.0.1:4318 \
  elozi
```

Publish the port on loopback and put a TLS reverse proxy (nginx, Caddy) in front of it for public access.

## Configuration

All settings are environment variables (see `.env.example`; `node --env-file=.env src/server.js` loads a file).

| Variable | Default | Purpose |
|---|---|---|
| `MEPCHAT_PORT` | `4318` | HTTP port. |
| `MEPCHAT_BIND_ADDRESS` | `127.0.0.1` (`0.0.0.0` in Docker) | Listen address. |
| `MEPCHAT_PUBLIC_ORIGIN` | `http://127.0.0.1:<port>` | Public URL used in links, cookies and OAuth callbacks. |
| `MEPCHAT_TRUSTED_PROXIES` | – | Reverse proxies allowed to forward the client IP (`gateway` = Docker network gateway). |
| `MEPCHAT_DOMAIN_CANONICAL_HOST` | hosted Elozi host | Canonical host for custom-domain checks; set it to your own host. |
| `MEPCHAT_PUBLIC_TRIAL_ENABLED` | – | Enables the public self-service sign-up/trial. |
| `MEPCHAT_CONVERSATION_JOURNAL` | `false` | `true` enables the durable conversation journal. |
| `MEPCHAT_GOOGLE_CLIENT_ID` | – | Google Identity Services client id for "Sign in with Google". |
| `MEPCHAT_EMAIL_KEY`, `MEPCHAT_EMAIL_FROM` | – | API key and sender for transactional e-mail (confirmation, invites). |
| `MEPCHAT_AGENT_PROFILE_ORIGINS`, `MEPCHAT_AGENT_ORIGINS` | – | Allowed origins of your AI agent gateway(s). |
| `MEPCHAT_MCP_ORIGINS`, `MEPCHAT_MCP_PRIVATE_ORIGINS` | – | Allowed external MCP server origins. |
| `MEPCHAT_PROTECTED_WORKSPACE_IDS` | – | Comma-separated workspace ids that cannot be deleted. |
| `ELOZI_STRIPE_SECRET_KEY`, `ELOZI_STRIPE_WEBHOOK_SECRET` | – | Optional Stripe billing. |
| `MEPCHAT_DATABASE_TRANSPORT` | SSH (`direct` in Docker) | Transport of the optional PostgreSQL mirror. |
| `MEPCHAT_POSTGRES_SSH_HOST` | – (mirror over SSH disabled) | SSH host alias for the PostgreSQL mirror and `npm run backup -- --postgres`. |
| `MEPCHAT_POSTGRES_CONTAINER` | `supabase-db` | Database container name on that SSH host. |

The PostgreSQL mirror (`db/*.sql`, row-level security per company) is optional; without it Elozi runs fully on
SQLite and logs that PostgreSQL is unavailable.

## WhatsApp disclaimer

The WhatsApp QR connector uses [Baileys](https://github.com/WhiskeySockets/Baileys), an **unofficial** library that
emulates WhatsApp Web. It is not affiliated with or endorsed by WhatsApp/Meta, may break when WhatsApp changes, and
automated or bulk use can get a number **banned**. Use a number you can afford to lose and respect WhatsApp's terms.
For production messaging at scale, use the official
[WhatsApp Business Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api). Baileys depends on
libsignal (GPL-3.0); see [NOTICE](NOTICE).

## Development

```bash
npm run check   # syntax check
npm test        # node:test suite
```

See [CONTRIBUTING.md](CONTRIBUTING.md) (commits need a DCO sign-off: `git commit -s`). Security reports:
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE) © 2026 Jean Carlos Vargas da Silva / JE4NDEV. Third-party notices: [NOTICE](NOTICE).
Names and logos: [TRADEMARK.md](TRADEMARK.md).

---

## Português (PT-BR)

**Elozi** é uma central de atendimento open-source para pequenas equipes: WhatsApp, Telegram, chat no site e e-mail
numa caixa só, com agentes de IA que só agem dentro dos limites que você aprova. Roda em Node.js 24 com SQLite
embutido, várias empresas por instalação, equipe, CRM, fluxos e endpoint MCP.

- **Começar:** `npm ci && npm start` e abra `http://127.0.0.1:4318` (ou use o Docker acima).
- **Versão hospedada:** [elozi.je4ndev.com](https://elozi.je4ndev.com).
- **Agentes de IA:** pacote npm [`elozi-mcp`](https://www.npmjs.com/package/elozi-mcp) para Claude, Codex, Cursor etc.
- **WhatsApp:** o conector por QR usa uma biblioteca **não oficial** (Baileys) e pode levar a bloqueio do número; para
  uso profissional em escala, prefira a API oficial WhatsApp Business Cloud.
- **Licença:** MIT. O conector WhatsApp depende do libsignal (GPL-3.0); veja o NOTICE.
- **Contribuir:** issues e PRs em português ou inglês; commits com `git commit -s` (DCO). Vulnerabilidades:
  jean@je4ndev.com, nunca em issue pública.
