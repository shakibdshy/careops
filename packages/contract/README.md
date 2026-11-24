# @careops/contract — the committed API contract

The REST contract as **committed artifacts**, not a runtime response: the
domain document the reference (NestJS) API serves at `GET /api/docs-json`, and
the auth document BetterAuth serves at
`GET /api/auth/open-api/generate-schema`.

- `openapi/api.json` — every domain route, typed from the Zod schemas in
  `@careops/shared` (ADR-0002: the schemas remain the single source of truth;
  these files are the _published_ form of that truth).
- `openapi/auth.json` — every auth route (sign-up, sign-in, sign-out, session,
  Organization management) as the reference implements them.

## Regenerate

From the repo root:

```sh
bun run contract:generate   # boots the reference API on an ephemeral DB, rewrites openapi/
bun run contract:check      # regenerate + fail if the committed files differ
```

CI runs `contract:check` on every PR: editing the API without regenerating the
artifacts fails the build. Never edit the JSON by hand.

## Consumers

- **Go service** — request/response types and the server interface are
  generated from these documents (drift-checked the same way).
- **Conformance suite** (Go-T04) — described below.

## The conformance suite

`test/` holds the black-box parity suite every backend must pass. It speaks
**HTTP only** — it is parameterised by `CONTRACT_BASE_URL`, creates its own
Users and Organizations through the API, and validates every response body
against the shared Zod schemas. It never touches a database, a queue, or any
backend-internal seam, so the same cases decide both the NestJS reference and
the Go replica.

```sh
# against a booted stack (bun run boot, or CI's boot step):
cd packages/contract
CONTRACT_TARGET=reference CONTRACT_BASE_URL=http://localhost:3001 bun test
```

CI boots the reference API on an ephemeral replica set and runs the suite
with `CONTRACT_TARGET=reference` on every PR.

### The parity ledger

`LEDGER` in `test/helpers.ts` maps areas to reasons the **Go** service has
not implemented them yet. Against the `go` target, ledgered areas are
skipped; against the `reference` target, **any** entry is a hard failure —
the ledger may only shrink, and it must be empty by Go-T18. Entries are
added only by Go tickets that scope their work.

### Areas

| Area            | Cases | Ported from                                                                                    |
| --------------- | ----- | ---------------------------------------------------------------------------------------------- |
| `auth`          | 7     | auth e2e suite                                                                                 |
| `organizations` | 10    | org + RBAC e2e suite                                                                           |
| `health`        | 1     | health e2e suite (status + service identity only; dependency keys are implementation-specific) |
| `docs`          | 6     | docs e2e suite + served-equals-committed artifact                                              |
