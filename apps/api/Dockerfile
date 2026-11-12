# syntax=docker/dockerfile:1

# ---- build: install the workspace and compile shared + api ----
FROM oven/bun:1.4.3 AS build
WORKDIR /app

# Manifests + lockfile first so the dependency layer caches independently of source.
COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile --ignore-scripts

# Source for the API and its only workspace dependency (web is not built here).
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN bunx turbo run build --filter='@careops/api...'

# ---- deps: production-only node_modules (root + api + shared prod deps) ----
# Hoisted linker: a flat, prod-only root node_modules that copies cleanly into
# the runtime. Bun's default isolated linker scatters deps across per-workspace
# node_modules symlinks + a .bun store that retains dev deps even under
# --production, so it neither copies as one tree nor stays lean.
FROM oven/bun:1.4.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile --production --ignore-scripts --linker hoisted

# ---- runtime: slim Node, non-root, only prod deps + compiled output ----
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./package.json
COPY apps/api/package.json apps/api/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/packages/shared/dist packages/shared/dist

USER node
EXPOSE 3001
CMD ["node", "apps/api/dist/main.js"]