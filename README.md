# CareOps

Multi-tenant care operations platform: an organization's staff manage patient
records, with an immutable audit trail on every mutation. Built as a
portfolio-grade, production-shaped week-1 foundation.

[![CI](https://github.com/shakibdshy/careops/actions/workflows/ci.yml/badge.svg)](https://github.com/shakibdshy/careops/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-80%25%20gate%20on%20services-brightgreen)](.github/workflows/ci.yml)

> **Not HIPAA-compliant.** CareOps is HIPAA-_minded_ — audit trail on every
> mutation, validated environment, error taxonomy, no real PHI (all seed data
> is fake) — but it makes no compliance claim. Do not store real patient data.

## Stack

| Layer    | Choice                                                                                        |
| -------- | --------------------------------------------------------------------------------------------- |
| Monorepo | Turborepo + bun                                                                               |
| API      | NestJS 12, REST under `/api`                                                                  |
| Web      | TanStack Start + Tailwind v4 + shadcn/ui conventions                                          |
| Database | MongoDB 8 (Mongoose for domain, BetterAuth's native adapter for auth)                         |
| Auth     | BetterAuth — email + password, httpOnly cookie sessions, organization plugin (tenancy + RBAC) |
| Queue    | Redis + BullMQ (queued side effects with retries + idempotency keys)                          |
| Mail     | nodemailer SMTP → Mailpit (self-contained sink + web UI, zero external keys)                  |
| Contract | Zod-first: schemas in `packages/shared` drive API validation, Swagger, and web typing         |
| Docs     | Swagger UI at **[/api/docs](http://localhost:3001/api/docs)**                                 |

Decisions and their trade-offs live in [docs/adr/](docs/adr) (8 ADRs); domain
language in [GLOSSARY.md](GLOSSARY.md).

## One-command boot

```bash
bun run boot
```

Ensures `apps/api/.env` (from the documented [.env.example](.env.example)),
starts MongoDB + Redis + Mailpit via docker compose (waits for health), seeds a
demo organization with three role accounts and patients, then launches API + web
with hot reload.

- Web: **http://localhost:3000** — Swagger: **http://localhost:3001/api/docs**
- Mailpit (email): **http://localhost:8025** — every notification the stack sends
  (booking confirmations, reminders, patient-created) lands here; SMTP is :1025.
- Demo credentials (password `careops-demo-1`):
  - Owner — `owner@demo.careops`
  - Admin — `admin@demo.careops`
  - Member — `member@demo.careops`

## Architecture

```
apps/
  api/    NestJS — auth (BetterAuth mount), organizations, patients,
          appointments (transactional booking), audit, notifications
          (BullMQ + SMTP/Mailpit), health; org-scoped repository base enforces
          tenant isolation at compile time
  web/    TanStack Start — login/signup, workspace (org + invites),
          patients CRUD, audit browsing
packages/
  shared/ Zod schemas — single source of truth for API validation,
          Swagger, and web typing (both directions)
docs/
  adr/    Architecture decision records
```

- **Multi-tenancy**: discriminator key (`organizationId` on every domain
  document), enforced by an org-scoped repository base — an unscoped query
  is a compile error. Proven by an e2e pair (cross-organization reads and
  mutations are 404s). [ADR-0006](docs/adr/0006-tenant-isolation-discriminator-key.md)
- **RBAC**: owner / admin / member via BetterAuth's organization plugin;
  role guard per route.
- **Audit**: append-only `Audit Entry` (who/what/when/before→after) written
  explicitly at the service layer; atomic before-snapshot on updates.
- **Sessions**: DB-backed httpOnly cookies over JWT —
  [ADR-0007](docs/adr/0007-db-backed-cookie-sessions-over-jwt.md).
- **Pagination**: cursor-based everywhere —
  [ADR-0008](docs/adr/0008-cursor-pagination.md).
- **Notifications**: queued delivery (BullMQ) over SMTP to Mailpit. Each event
  claims a durable receipt with a unique `{organizationId, type, refId}` index —
  storage-side dedup that survives BullMQ's pruned job ids. The recipient is
  resolved from the Patient's Contact Email at consume time; no email → a
  `SKIPPED` receipt, never a silent drop. Reminders are delayed jobs at
  start − 24h that cancel themselves when the Appointment is cancelled or moved
  past the reminder time.

## Testing

Two seams, no internals: the **HTTP boundary** (supertest against the real
Nest app + `mongodb-memory-server`) and the **browser** (Playwright against
the running stack). Service-level unit tests carry the 80% coverage gate.

```bash
bun run test            # unit + e2e with coverage thresholds
bun run test:e2e:ui     # Playwright (starts its own stack)
bun run lint && bun run typecheck && bun run build
```

CI runs the same lanes on every PR (lint → typecheck → test → build) and
publishes the coverage summary to the job. Coverage percentages are also
visible in the API test output (`--coverage`).

## Performance receipts

"Optimized" as evidence, not prose — every number measured with a reproducible
command ([tools/README.md](tools/README.md)), on a throwaway multi-tenant
dataset (80k appointments), never the demo data:

- **Indexes**: the booking Conflict check drops from a COLLSCAN of 80,000 docs
  to an IXSCAN of 479; a cursor list page examines 21 docs at any depth (vs
  60,021 on a bare `_id` walk).
- **N+1**: provider-utilization is **1** query (server-side `$lookup`) vs **87**
  naive per-row fetches — 3.04× faster, identical rows.
- **Cache**: settled report reads ~1.4–2× faster (controlled miss→hit);
  1.38–1.84× under load (k6, drift-normalized).
- **Lighthouse `/dashboard`** (production build): performance **89** mobile /
  **100** desktop, accessibility 98, 0 ms blocking time, near-zero layout shift.

Before/after tables + commands: [docs/performance.md](docs/performance.md).
How it grows — replicas behind a load balancer, Mongo index catalog / cursor
paging / read preference / shard key, cache layers, BullMQ worker scaling, and a
capacity table fed by the k6 numbers: [docs/scaling.md](docs/scaling.md).

## Development

```bash
bun install
bun run dev      # API :3001 + web :3000 (proxied, same-origin cookies)
bun run seed     # (re)seed the demo organization — idempotent
```

Environment variables are validated with Zod at boot and fail fast naming
the offending variable — see [.env.example](.env.example).

## License

Private portfolio project.
