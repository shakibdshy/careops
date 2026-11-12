# Performance receipts

"Optimized" as evidence, not prose. Every number below was measured on this
repository's code against a seeded, multi-tenant dataset, and every measurement
has a reproducible command. **These are observed operating points on one dev
machine, not SLAs.** Re-run the commands on your hardware to get your numbers.

Companion narrative: [scaling.md](scaling.md) (how the system grows). Raw
receipts: [`tools/receipts/`](../tools/receipts). Run instructions and the
isolated measurement environment: [`tools/README.md`](../tools/README.md).

## Measurement environment

- One Apple-Silicon dev laptop; MongoDB 8 (single-node replica set) + Redis via
  `docker compose`; **one** API replica; production web build served by
  `vite preview`. No horizontal scaling was applied — these are single-replica
  numbers.
- Throwaway database `careops_t9_receipts` (never the demo `careops` db):
  **20,000** appointments for the demo Organization plus **60,000** for a noise
  tenant = **80,000** total, **43** Providers. The noise tenant exists so
  index/pagination receipts reflect a genuinely multi-tenant collection, not a
  single-tenant toy.
- Load: k6 at a fixed **10 VUs for 30s** per scenario. Latency-sensitive reads
  report median and p95; `explain()` reports `docsExamined` (deterministic) and
  median wall-ms over 7 runs (wall-ms is noisy at sub-ms scale).

Reproduce the whole set (isolated env, see `tools/README.md` for the boot):

```bash
bun tools/load-dataset.mjs        # seed the throwaway multi-tenant dataset
bun tools/explain-index.mjs       # index receipt   -> receipts/index-explain.json
bun tools/bench-n-plus-one.mjs    # N+1 receipt     -> receipts/n-plus-one.json
bun tools/bench-cache.mjs         # cache receipt   -> receipts/cache-miss-hit.json
bun tools/k6/run.mjs              # under-load p95  -> receipts/k6-*.json
bun tools/lighthouse.mjs          # /dashboard      -> receipts/lighthouse.json
```

## 1. Index receipt — `explain("executionStats")` before / after

Command: `bun tools/explain-index.mjs`. The "before" plan is captured by
**dropping the index locally** in the throwaway db and restoring it after;
nothing broken ships on `main`. Receipt:
[`index-explain.json`](../tools/receipts/index-explain.json).

**Conflict / overlap check** (`{organizationId, memberId, status $nin, start <
newEnd, end > newStart}` — the booking Conflict query, ADR-0010):

| Plan                   | Stage            | Index              | docsExamined | keysExamined | median ms |
| ---------------------- | ---------------- | ------------------ | -----------: | -----------: | --------: |
| before (index dropped) | `COLLSCAN`       | —                  |       80,000 |            0 |        11 |
| after                  | `FETCH → IXSCAN` | `org_member_start` |          479 |          479 |         1 |

Dropping `{organizationId, memberId, start}` forces a full collection scan of
all 80,000 documents (both tenants). With the index, the planner examines only
the 479 candidate slots for that Provider in the window — **~167× fewer
documents examined**, 11ms → 1ms.

**Cursor list page** (`{organizationId, _id > cursor}` sort `_id` limit 21,
ADR-0008):

| Plan                             | Stage                    | Index           | docsExamined | keysExamined | median ms |
| -------------------------------- | ------------------------ | --------------- | -----------: | -----------: | --------: |
| before (`org_id_cursor` dropped) | `LIMIT → FETCH → IXSCAN` | `_id_`          |       60,021 |       60,021 |        35 |
| after                            | `LIMIT → FETCH → IXSCAN` | `org_id_cursor` |           21 |           21 |         0 |

Without the org-leading cursor index the planner falls back to the bare `_id`
index and must walk **past every newer `_id` belonging to other tenants** to
reach this Organization's page — 60,021 documents examined for a 21-row page.
With `{organizationId, _id}` the range scan touches exactly the page: **21
documents examined at any depth**, 35ms → sub-ms. This is the multi-tenant
payoff of ADR-0006's "every index leads with `organizationId`."

## 2. N+1 receipt — naive per-row fetches vs the shipped `$lookup`

Command: `bun tools/bench-n-plus-one.mjs`. Measures the provider-utilization
report two ways over the same 30-day window and **asserts the rows are
identical** (`resultsMatch: true`). Query counts are _observed_ via MongoDB
command monitoring (`monitorCommands: true`), not asserted. Receipt:
[`n-plus-one.json`](../tools/receipts/n-plus-one.json).

| Strategy                                                               |             Queries | median wall ms |
| ---------------------------------------------------------------------- | ------------------: | -------------: |
| shipped: one aggregate, two server-side `$lookup`s                     |               **1** |       **5.96** |
| naive: one `$group` + `findOne(member)` + `findOne(user)` per Provider | **87** (`1 + 2×43`) |          18.12 |

**87× fewer queries, 3.04× faster wall time**, identical output. The naive path
is the classic populate-style N+1: one round trip per Provider per joined
collection. The shipped pipeline joins `member` and `user` inside MongoDB, so
the whole report is a single round trip regardless of Provider count. The bench
lives only in `tools/` — it is never shipped in app code.

## 3. Cache receipt — before / after the Redis report cache

Two complementary measurements. The **controlled bench** is the clean
per-request delta (no concurrent load, so no between-run drift); the **k6
scenarios** show the same effect under load.

### 3a. Controlled miss → hit (headline)

Command: `bun tools/bench-cache.mjs`. One session, no load; for each endpoint it
bumps `reports:gen:{org}` (ADR-0011 invalidation), times the recompute (**miss**),
then times an immediate settled read (**hit**). 20 samples each, median + p95.
The two always-live endpoints are the **control**: the generation bump does not
touch them, so their miss/hit must be ~equal — which validates the method.
Receipt: [`cache-miss-hit.json`](../tools/receipts/cache-miss-hit.json).

| Endpoint             | Cached?      | miss median / p95 | hit median / p95 | median speedup |
| -------------------- | ------------ | ----------------: | ---------------: | -------------: |
| daily-volume         | yes          |   8.57 / 11.87 ms |   5.89 / 6.97 ms |      **1.46×** |
| provider-utilization | yes          |  11.08 / 12.21 ms |   5.86 / 6.62 ms |      **1.89×** |
| status-breakdown     | no (control) |   9.22 / 10.83 ms |  9.44 / 10.31 ms |          0.98× |
| today                | no (control) |    8.19 / 9.75 ms |   7.75 / 9.44 ms |          1.06× |

The cached aggregations get ~1.4–2× faster once settled; the live controls do
not move. That is the cache doing exactly what ADR-0011 promises and nothing
more.

### 3b. Under load (k6, 10 VUs / 30s)

Command: `bun tools/k6/run.mjs`. WARM = cache settled; COLD = the runner bumps
the generation every 20ms so every cached read recomputes. Same VUs, duration,
window. Receipt: [`k6-summary.json`](../tools/receipts/k6-summary.json).

| Endpoint                   | WARM p95 | COLD p95 | raw cold/warm | normalized |
| -------------------------- | -------: | -------: | ------------: | ---------: |
| daily-volume               | 15.16 ms | 18.68 ms |         1.23× |  **1.38×** |
| provider-utilization       | 15.22 ms | 24.92 ms |         1.64× |  **1.84×** |
| status-breakdown (control) | 18.43 ms | 16.44 ms |         0.89× |          — |
| today (control)            | 17.36 ms | 15.54 ms |         0.90× |          — |

WARM and COLD are separate k6 invocations, so between-run drift shifts _every_
endpoint. The always-live controls measure that drift (geometric mean **0.89×**
here — they happened to run slightly faster cold); dividing it out of the cached
ratios gives the **normalized** cache signal (1.38× / 1.84×), which agrees with
the controlled bench in direction and magnitude. Both runs: **0 failures**.

**Appointments list under load** (never cached): first page p95 **35.42ms**,
cursor-deep pages p95 **24.56ms** — deep pages are no slower than the first,
the ADR-0008 O(page) property holding under concurrency. 1,140 iterations,
0 failures. Receipt:
[`k6-appointments-list.json`](../tools/receipts/k6-appointments-list.json).

## 4. Lighthouse — `/dashboard`

Command: `bun tools/lighthouse.mjs` against a **production** build
(`vite build` + `vite preview`), not the dev server (dev-mode ESM + HMR scores
are unrepresentative). `/dashboard` is auth-guarded client-side, so the script
signs in and injects the session cookie via `--extra-headers`, then **asserts
the final URL is still `/dashboard`** — a run that redirected to `/login` fails
instead of recording a bogus score. Receipt:
[`lighthouse.json`](../tools/receipts/lighthouse.json); screenshot:
[`lighthouse-dashboard.jpg`](../tools/receipts/lighthouse-dashboard.jpg).

| Category       | Mobile (default) | Desktop |
| -------------- | ---------------: | ------: |
| Performance    |           **89** | **100** |
| Accessibility  |               98 |      98 |
| Best Practices |               96 |      96 |
| SEO            |               90 |      90 |

| Metric                   | Mobile | Desktop |
| ------------------------ | -----: | ------: |
| First Contentful Paint   |  0.8 s |   0.3 s |
| Largest Contentful Paint |  3.8 s |   0.8 s |
| Total Blocking Time      |   0 ms |    0 ms |
| Cumulative Layout Shift  |      0 |   0.013 |
| Speed Index              |  1.5 s |   0.4 s |

Zero blocking time on both form factors and effectively zero layout shift
(0 mobile, 0.013 desktop): the dashboard skeletons reserve chart space (CLS ≈ 0)
and the chart work never blocks the main thread for long (TBT 0). Mobile LCP is
dominated by the simulated 4× CPU / slow-4G throttling, not by the API (the
report reads above are single-digit ms).

## Methodology notes (honesty)

- `docsExamined` / `keysExamined` are deterministic; wall-ms at sub-ms scale is
  noisy, so index and bench receipts report a **median over 7 runs**.
- The cache's clean delta is the **controlled** bench (3a). The k6 warm/cold
  comparison (3b) is between-run and therefore drift-confounded; the controls
  and normalization make its signal defensible rather than raw.
- No number here is a target or an SLA. They are what this code measured on
  this hardware, with the command to reproduce them.
