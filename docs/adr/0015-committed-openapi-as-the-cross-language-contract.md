# The committed OpenAPI documents are the contract across languages

The contract between the NestJS API and the Go replica is **two committed
OpenAPI documents** in `packages/contract/openapi/`: the domain document the
API serves at `/api/docs-json`, and the auth document BetterAuth serves at
`/api/auth/open-api/generate-schema`. They are regenerated from a live boot of
the reference API (`bun run contract:generate` — the same `bootstrapApi` boot
the e2e suites use), and CI regenerates and fails on any uncommitted
difference. Go request/response types and its server interface are generated
from these documents, committed, and drift-checked the same way.

This **extends ADR-0002 rather than replacing it**: the Zod schemas remain the
single source of truth; the committed documents are that truth's _published
form_, and Zod stays the validator for both backends' responses (the
conformance suite asserts bodies against the shared schemas at runtime). What
changes is that the truth now crosses a language boundary through an artifact
instead of through TypeScript imports.

## Considered Options

- **Hand-written Go types** — the zero-tooling option, and the reason it is
  rejected: it silently abandons the single-source-of-truth principle. Every
  contract change would need a manual sync; drift would be found by the
  conformance suite _after_ implementation, not before.
- **gRPC + protobuf as the contract** — a real schema system, but it drags in
  a second transport for one service, rewrites the web's data path
  (ADR-0009's client stack speaks REST over `/api`), and the reference API
  already speaks OpenAPI. The replica's point is the same contract twice.
- **TypeScript "contract package" imported by codegen at build time** —
  regenerating from live boot is deliberately _not_ build-time: the artifact
  is reviewable in a PR diff, and the drift check covers the whole chain
  (API behaviour → committed document → generated Go code) with one
  mechanism.

## Consequences

- The artifact chain is order-sensitive and CI-enforced: API change →
  regenerate documents (one command) → regenerate Go types → all committed
  together. Forgetting any step fails the PR.
- BetterAuth's document bakes the booted origin into its server URL; the
  generator normalizes it to the auth base path so runs are byte-identical.
- The documents describe the auth surface completely (sign-up, sign-in,
  sign-out, session, organization plugin — verified); if a future auth
  addition outgrows the generated document, recorded response fixtures
  become the fallback contract for that area. Not needed today.
