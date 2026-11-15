# AgentOps on DeepSeek Harness — single image for host + Python sidecar.
#
# Build context MUST be the repository root (the pnpm workspace), e.g.
#   docker build -f packages/agentops/deploy/Dockerfile -t agentops-dsh .
#
# The image contains the built DSH runtime plus the Python sidecar. Two
# containers run from it with different commands (see docker-compose.yml).

FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NODE_ENV=production \
    DSH_HOME=/data/dsh \
    AGENTOPS_SIDECAR_HOST=0.0.0.0 \
    AGENTOPS_SIDECAR_PORT=8791

# Python is required only by the sidecar; keep the install minimal.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable

WORKDIR /app

# Dependency layer first: it changes far less often than sources.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages ./packages
# Migrated assets are seeded into the runtime DSH_HOME by bootstrap.mjs.
COPY agentops/agents ./agentops/agents
COPY agentops/workflows ./agentops/workflows
COPY agentops/mappings ./agentops/mappings
COPY agentops/domains ./agentops/domains
COPY agentops/actors ./agentops/actors
RUN pnpm install --frozen-lockfile --prod=false

# Build the host packages the bundle mounts.
RUN pnpm build:lib

# Sidecar is stdlib-only; nothing to install.
ENV AGENTOPS_SIDECAR_DIR=/app

RUN mkdir -p /data/dsh /etc/agentops && chown -R node:node /data /app

USER node

EXPOSE 3080

# dsh web needs a patch that mounts the AgentOps bundle layers.
ENV AGENTOPS_PATCH=/etc/agentops/agentops.patch.yml

CMD ["node", "/app/packages/agentops/deploy/bootstrap.mjs"]
