# syntax=docker/dockerfile:1@sha256:4edf897a3ffa55b89f906fc8cc78afdb3f1834cc9c7083565e611a8a7d5fe99e
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS dependencies
ARG NODE_OPTIONS=--max-old-space-size=6144
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS runtime
# The host nginx reaches the port published on host loopback through Docker, so the container sees the network
# gateway, never loopback. Only that exact address may forward the client IP (X-Real-IP); other containers on the
# network stay untrusted. Publish the port on 127.0.0.1 only: a public publish would let clients set that header.
ENV NODE_ENV=production \
    MEPCHAT_BIND_ADDRESS=0.0.0.0 \
    MEPCHAT_PORT=4318 \
    MEPCHAT_DATABASE_TRANSPORT=direct \
    MEPCHAT_TRUSTED_PROXIES=gateway \
    LOCALAPPDATA=/run/elozi-secrets-parent

WORKDIR /app
COPY --chown=node:node --from=dependencies /app/node_modules ./node_modules
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
COPY --chown=node:node package.json package-lock.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
RUN mkdir -p /app/data /run/elozi-secrets-parent
RUN chown node:node /app/data /run/elozi-secrets-parent

# Optional AI agent gateway: set MEPCHAT_AGENT_PROFILE_ORIGINS at run time (for example
# -e MEPCHAT_AGENT_PROFILE_ORIGINS=http://my-agent-gateway:8671). Empty by default.

# Keep provenance after immutable dependencies so source-only releases reuse
# the existing Node/FFmpeg layers instead of reinstalling native packages.
ARG SOURCE_SHA=unrecorded
ENV MEPCHAT_SOURCE_REVISION=${SOURCE_SHA}
LABEL org.opencontainers.image.title="Elozi" \
      org.opencontainers.image.source="https://github.com/JE4NVRG/elozi" \
      org.opencontainers.image.revision="${SOURCE_SHA}" \
      org.opencontainers.image.licenses="MIT" \
      io.je4ndev.owner="elozi" \
      io.je4ndev.conversation-journal-version="1" \
      owner="elozi"

USER node
EXPOSE 4318
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD node --input-type=module -e "const response = await fetch('http://127.0.0.1:4318/api/health/ready', { signal: AbortSignal.timeout(4000) }); if (!response.ok) process.exit(1); const health = await response.json(); if (health.status !== 'ok' || health.level === 'down') process.exit(1);"
CMD ["node", "src/server.js"]
