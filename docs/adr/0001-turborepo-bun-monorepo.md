# Turborepo + bun monorepo

The API (NestJS), web app (TanStack Start), and shared contract package need a build
orchestrator and a package manager. We chose Turborepo with bun: Turborepo provides
cached task pipelines (lint → typecheck → test → build) shared identically between
developers and CI, and bun is the fastest package manager/runner available and is
supported by every tool in the stack.

## Considered Options

- **Nx** — more powerful codegen/plugins, but heavier than this repo needs; Turborepo's
  pipeline model covers everything.
- **Plain bun workspaces** — no task graph, no caching, every CI job re-runs everything.
