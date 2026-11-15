# syntax=docker/dockerfile:1
# AiroRecruit backend — Express + TypeScript + BullMQ
# Place this file at the repo root (next to package.json).
# Render: New Web Service → connect this repo → Runtime: Docker.

# ---- build ----
# Debian slim (glibc) rather than Alpine: production depends on
# @huggingface/transformers → onnxruntime-node, which has no musl builds.
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=4000

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system app \
    && useradd --system --gid app --home-dir /app --shell /usr/sbin/nologin app \
    && mkdir -p /app/.cache/models \
    && chown -R app:app /app

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --chown=app:app package.json ./
COPY --chown=app:app seed ./seed

USER app
EXPOSE 4000

# The app already listens on process.env.PORT (default 4000), which Render injects.
# Default command is the API. For a Render Background Worker, override the
# Docker Command to: node dist/worker.js
# Or set RUN_WORKERS_IN_API=true on the web service to run workers in-process.
CMD ["node", "dist/server.js"]
