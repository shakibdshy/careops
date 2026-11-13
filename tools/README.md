# Measurement tools (W2-T9 receipts)

Scripts that produce the evidence in [docs/performance.md](../docs/performance.md)
and [docs/scaling.md](../docs/scaling.md). **This directory is not a Turborepo
workspace**: CI never installs, lints, or runs it. The only app-code-adjacent
thing here is `lib/mongo.mjs`, which re-uses the API's own `mongodb` driver so
the benches speak the same driver version as the shipped code.

Everything runs against a **throwaway database and separate ports** so a
measurement never touches the demo `careops` db or your `:3000`/`:3001` dev
stack. Redis keys read/deleted by these scripts are scoped to the receipts
Organization id. **One documented exception** (W3-T3):
`prove-replica-freshness.mjs` needs the SEEDED demo org (users/members/
patients), so it books exactly one appointment into the dev `careops` db —
point `MONGODB_URI` at a throwaway seeded db if that matters. The k6
`ramp.mjs` runner touches no database directly at all.

## Prerequisites

- `bun` (repo toolchain), Docker (for the compose infra).
- [`k6`](https://k6.io) on `PATH` (load scenarios).
- Google Chrome (Lighthouse). Override with `CHROME_PATH` if elsewhere.
- `cd tools && bun install` once (installs `lighthouse` + `puppeteer-core`
  locally; pinned in `tools/package.json` + `tools/bun.lock`).

## Clean measurement boot

Run from the repo root in a dedicated shell. The exported variables point every
script at the throwaway db; they do not affect your dev stack.

```bash
# 1. Infra: MongoDB (single-node replica set rs0) + Redis + Mailpit.
bun run boot:infra

# 2. Build the API and the production web bundle.
bunx turbo run build --filter=@careops/api --filter=@careops/web

# 3. Point this shell at the throwaway receipts database.
export MONGODB_URI='mongodb://localhost:27017/careops_t9_receipts?replicaSet=rs0'
export REDIS_URL='redis://localhost:6379'
export BETTER_AUTH_SECRET='t9-receipts-secret-not-for-real-use-0123456789'
export NOTIFICATIONS_QUEUE_NAME='notifications-t9-receipts'

# 4. Seed the demo org/users/patients into the receipts db, then load the
#    multi-tenant measurement dataset (20k demo + 60k noise appointments).
bun apps/api/src/seed.ts
bun tools/load-dataset.mjs

# 5. Isolated API on :3011 against the receipts db (background).
PORT=3011 node apps/api/dist/main.js &

# 6. Isolated production web on :3010, proxying /api to :3011 (background).
(cd apps/web && API_PROXY_TARGET=http://localhost:3011 bunx vite preview --port 3010 --strictPort) &

# 7. Wait for both, then run the receipts.
curl -s http://localhost:3011/api/health
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3010/dashboard
```

`bun run boot` (the full dev boot) also satisfies step 1 — the scripts
deliberately use their own db/ports on top of the same infra so they never
mutate demo data.

## The scripts

| Command                                 | Receipt                                 | What it measures                                                                |
| --------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| `bun tools/load-dataset.mjs`            | — (seeds db)                            | Deterministic 20k demo + 60k noise appointments, 43 Providers                   |
| `bun tools/explain-index.mjs`           | `receipts/index-explain.json`           | `explain(executionStats)` before (drop index) / after, overlap + cursor list    |
| `bun tools/bench-n-plus-one.mjs`        | `receipts/n-plus-one.json`              | Naive per-row fetches vs shipped `$lookup`; observed query counts + ms          |
| `bun tools/bench-cache.mjs`             | `receipts/cache-miss-hit.json`          | Controlled cache miss→hit per endpoint, with live controls                      |
| `bun tools/k6/run.mjs`                  | `receipts/k6-*.json`                    | 10-VU dashboard warm/cold + cursor-list p95; normalized cache delta             |
| `bun tools/k6/ramp.mjs`                 | `receipts/k6-ramp.json`                 | Per-replica-stage dashboard reads/s + p95 against the ALB (W3-T3 runbook)       |
| `bun tools/prove-replica-freshness.mjs` | `receipts/cross-replica-freshness.json` | Two-replica booking→report freshness via the shared-Redis generation (ADR-0011) |
| `bun tools/lighthouse.mjs`              | `receipts/lighthouse.json` + `.jpg`     | Authenticated `/dashboard` scores, mobile + desktop, production build           |

Run them in the order above (dataset first). Each is idempotent and re-runnable;
`load-dataset.mjs` wipes and regenerates the receipts `appointment` collection
only.

## Environment overrides

| Variable                                                                            | Default                                 | Used by                             |
| ----------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------------- |
| `MONGODB_URI`                                                                       | `…/careops_t9_receipts?replicaSet=rs0`  | all db scripts                      |
| `REDIS_URL`                                                                         | `redis://localhost:6379`                | cache bench, k6 runner              |
| `BASE_URL`                                                                          | `http://localhost:3011`                 | cache bench, k6, Lighthouse (API)   |
| `WEB_URL`                                                                           | `http://localhost:3010`                 | Lighthouse (web)                    |
| `EMAIL` / `PASSWORD`                                                                | `owner@demo.careops` / `careops-demo-1` | sign-in for cache/k6/Lighthouse     |
| `VUS` / `DURATION` / `DAYS`                                                         | `10` / `30s` / `30`                     | k6 runner                           |
| `GEN_BUMP_MS`                                                                       | `20`                                    | k6 cold-phase invalidation interval |
| `RECEIPTS_CACHE_SAMPLES`                                                            | `20`                                    | cache bench samples per endpoint    |
| `CHROME_PATH`                                                                       | system Chrome                           | Lighthouse                          |
| `RECEIPTS_PROVIDERS` / `RECEIPTS_APPOINTMENTS` / `RECEIPTS_NOISE` / `RECEIPTS_SEED` | `40` / `20000` / `60000` / `12345`      | dataset shape                       |

## Cleanup

The scripts leave the receipts org's Redis cache entries deleted. To remove the
measurement state entirely: stop the two background processes, then
`mongosh --eval 'db.getSiblingDB("careops_t9_receipts").dropDatabase()'`.
Your demo `careops` db and dev stack are untouched throughout.
