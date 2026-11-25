# Runbook: deploying CareOps — one web, two backends

The deployed stack is three services behind one load balancer (ADR-0012,
extended by ADR-0016): the web app, the reference API (NestJS · MongoDB), and
the Go replica (Go · PostgreSQL). One hostname serves the web + reference API;
a second hostname, when configured, serves the same web in front of the Go
API. `packages/infra/` holds the CDK stack; `.github/workflows/deploy.yml`
ships every merge to main.

## What a deploy does

1. The gates job runs lint, typecheck, unit + e2e tests, builds, and CDK
   synth (the same gates every PR runs).
2. The deploy job builds and pushes **three images** to ECR, each tagged with
   the commit sha: `careops-api`, `careops-web`, `careops-api-go`.
3. `cdk deploy` rolls the ECS services. The Go image runs its PostgreSQL
   migrations **before it starts serving** — schema and code always ship
   together, and a service that cannot migrate cannot take traffic.
4. The post-deploy smoke (`tools/smoke.mjs`) runs against **both hosts**:
   API health through the edge, the server-rendered page not edge-cached,
   and `/api/*` reaching the right backend (the reference's `implementation`
   field names `nestjs`; the Go origin's names `go`).

## Operator prerequisites (only you can provide these)

The live links cannot exist until each of these is done once. They are
tracked in spec #59, not as repository tickets.

1. **An AWS credential, once** — to run the OIDC bootstrap and set the
   deploy role on the repository. Until then every deploy run stops (green
   gates, failed deploy job) at `Configure AWS via OIDC`. That stop is the
   designed wall, not a bug.
2. **A MongoDB Atlas connection string** — stored as the API's database
   secret (Secrets Manager) after the first deploy; the reference API reads
   it at boot.
3. **A domain name and a certificate covering both hostnames** — the web
   origin domain (repository variable `DOMAIN_NAME`) and the Go origin
   domain (`vars.GO_DOMAIN_NAME`). Same-origin sign-in is rejected through
   the edge without them. The certificate is issued for both names in the
   stack when `goDomainName` is set; DNS validation records must be added.

With (1) done, set `DOMAIN_NAME` / `GO_DOMAIN_NAME` as repository **vars**
(`gh variable set`), then run the deploy. The stack creates: RDS PostgreSQL
17 for the Go tier (private subnets, encrypted, credentials generated into
Secrets Manager, 7-day backup retention, snapshot on delete), a third
Fargate service with its own target group, host-based listener rules, and
auto-scaling bounds per tier.

## First real deploy — what to watch

- The Go service's first boot applies migrations 0001–0010 on the empty RDS
  database, then starts serving; the target group's health check must go
  green before the circuit breaker would otherwise roll back.
- **The database seam is proven here**: Floci does not emulate RDS, so the
  first real deploy is the first time the Go service runs against managed
  PostgreSQL. Watch the Go origin's health (`postgres: up`) and book a demo
  appointment on it.
- Run the demo seed against the live Go origin
  (`DATABASE_URL=<secret> go run ./apps/api-go/cmd/seed`) so the Go link
  shows the same demo dataset as the reference (verified by
  `tools/parity-check.mjs` pointed at both live origins).
- Add both live links to the README and sign in by hand on each host: the
  badge must read **NestJS · MongoDB** on one and **Go · PostgreSQL** on the
  other.

## Rollback

Every image tag is the commit sha and stays in ECR, so rolling back is a
re-deploy of an old tag:

```
gh workflow run deploy.yml -f skip_build=true -f image_tag=<previous-sha>
```

The stack rolls all three services forward to that tag's images and the
smoke gates the result. The Go database schema only moves forward
(forward-only migrations); a rollback to a pre-0010 image against a migrated
database still serves correctly because migrations are additive (new columns
and indexes, no dropped columns in use).

## Teardown (including the database)

```
cd infra
npx cdk destroy
```

This removes the load balancer, services, secrets, and **the RDS instance**.
The database's removal policy is `SNAPSHOT`: the destroy takes a final
snapshot before deleting, so the demo data is recoverable by restoring that
snapshot into a new instance. The ECR repositories and the S3/Terraform-state
style artifacts are not destroyed by the stack; delete them from the console
if the account is being cleaned out. MongoDB Atlas is an external service —
pause or delete it in Atlas's own console.

## Quick path: Render + Vercel (the live demo)

The AWS stack above is the production-shaped definition; the live demo links
run on Render (the Go API) and Vercel (the web), which needs no AWS
credential. Everything is in-repo:

- **`render.yaml`** (repo root) — a Render Blueprint: the Go Docker image
  (migrations apply before serving), Render PostgreSQL, and Render Key Value
  for the report cache. Render → New → Blueprint → this repo. Fill the two
  `sync: false` vars with the Vercel origin (both `BETTER_AUTH_URL` and
  `TRUSTED_ORIGINS` = `https://<your-web>.vercel.app` — sign-in on the web
  sends that origin, and the Go auth plane rejects untrusted origins).
  Note: Render's free PostgreSQL is deleted after 30 days; upgrade the plan
  to keep demo data. Single-user database is supported: FORCE RLS
  (migration 0009) keeps the org guard load-bearing on the master role.
- **`apps/web/vercel.json` + `apps/web/api/ssr.mjs`** — the Vercel adapter:
  one catch-all function in the ALB's place. `/api/*` proxies to the Render
  Go service (same-origin, first-party cookies), everything else runs the
  SSR handler; `/assets/*` stays static with immutable caching. Import the
  repo on Vercel with **Root Directory `apps/web`**, framework "Other", and
  one env var: `API_PROXY_TARGET = https://<go-service>.onrender.com`.
- **Proof before deploy**: `bun tools/prove-vercel-adapter.mjs` drives the
  exact function Vercel runs against the local Go stack — health proxy,
  sign-up with surviving cookies, SSR + no-store, deep route, authenticated
  read (receipt: `tools/receipts/vercel-adapter-proof.json`).

Order: deploy Render first (gives the Go URL) → set `API_PROXY_TARGET` on
Vercel and deploy → set Render's `BETTER_AUTH_URL`/`TRUSTED_ORIGINS` to the
Vercel origin (Render redeploys). Then seed the live database
(`DATABASE_URL=<render external url> CONTRACT_OPENAPI_DIR=apps/api-go/../../packages/contract/openapi go run ./apps/api-go/cmd/seed`
from a checkout), and verify: `BASE_URL=https://<web>.vercel.app bun tools/smoke.mjs`,
sign in with the demo credentials, badge reads **Go · PostgreSQL**.

## Where things live

| thing                                                   | where                                          |
| ------------------------------------------------------- | ---------------------------------------------- |
| CDK stack (three tiers, host routing)                   | `packages/infra/lib/careops-stack.ts`          |
| Stack assertions (19/19)                                | `packages/infra/test/careops-stack.test.ts`    |
| Deploy workflow (build → push → deploy → smoke)         | `.github/workflows/deploy.yml`                 |
| Smoke checks (edge health, SSR cache, backend routing)  | `tools/smoke.mjs`                              |
| Go migrations (forward-only, run in-image before serve) | `apps/api-go/internal/db/migrations/`          |
| Demo seeds (identical datasets, proven by parity check) | `apps/api/src/seed.ts`, `apps/api-go/cmd/seed` |
| Post-deploy demo parity                                 | `tools/parity-check.mjs`                       |
