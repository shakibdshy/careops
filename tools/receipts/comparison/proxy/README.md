# ALB-shaped proxy receipts (ticket #76) — 2026-11-25

The full k6 suite (dashboard warm / cold / cursor list; 10 VUs x 30s) run through
the local ALB-shaped reverse proxy (tools/alb-sim.mjs: /* -> web, /api/* -> API)
in front of each backend — the same request path the deployed origin uses.

| backend (through alb-sim) | list first page p95 | deep pages p95 | failures |
| ------------------------- | ------------------: | -------------: | -------: |
| NestJS · MongoDB  (:8092) | 45.37 ms | 25.25 ms | 0 |
| Go · PostgreSQL   (:8091) | 21.04 ms | 12.01 ms | 0 |

Consistent with the native-API receipts in ../go and ../nestjs (one proxy hop added).
Warm/cold deltas and the per-endpoint breakdowns are in ./go/k6-summary.json and
./nestjs/k6-summary.json.
