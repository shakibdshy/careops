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
- **Conformance suite** (from Go-T04) — the black-box parity suite lives here
  and validates both backends' responses against the shared schemas.
