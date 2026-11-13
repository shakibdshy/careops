# syntax=docker/dockerfile:1

# ---- build: install the workspace and build shared + web ----
FROM oven/bun:1.4.3 AS build
WORKDIR /app

# Manifests + lockfile first so the dependency layer caches independently of source.
COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN bun install --frozen-lockfile --ignore-scripts

# Source for the web app and its only workspace dependency (api is not built here).
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN bunx turbo run build --filter='@careops/web...'

# ---- runtime: slim Node, non-root, no node_modules at all ----
# The SSR handler (dist/server) is fully bundled by Vite and the client assets
# are static files, so the runtime needs only Node + the two dist trees + the
# server entry — no dependency install, no workspace.
FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000

COPY --from=build /app/apps/web/dist/client apps/web/dist/client
COPY --from=build /app/apps/web/dist/server apps/web/dist/server
COPY apps/web/server.mjs apps/web/server.mjs

USER node
EXPOSE 3000
CMD ["node", "apps/web/server.mjs"]
