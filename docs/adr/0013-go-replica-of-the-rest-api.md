# A second implementation of the REST API, in Go, as a replica

CareOps gains a second backend: a Go service implementing the **same REST
contract** as the NestJS API — same routes, same request/response shapes, same
error taxonomy, same auth flows — backed by its own PostgreSQL (ADR-0014). The
web app runs unchanged against either; which one serves is a deployment-time
choice. This is a **replica**, not a new bounded context: no new domain
behaviour is invented for the Go side, and the NestJS API stays the reference
implementation (TypeScript-first, ADR-0002's source of truth).

The purpose is a portfolio requirement, stated plainly: the resume targets
React + Go full-stack roles, and the artifact must demonstrate Go and
PostgreSQL depth _without_ weakening what exists. A replica is the shape that
does that honestly: the interview question "how do you know the second
implementation is correct?" has a real answer — one black-box conformance
suite runs against both backends in CI, and the web app's browser tests run
against both (spec #59). A bolt-on service with a private contract would not
have that answer.

## Considered Options

- **A new bounded context owned by Go** (e.g. billing) — the classic
  microservice justification: split on domain lines, integrate by events. It
  demonstrates service _composition_, but almost no Go: the Go surface would
  be a small CRUD slice while tenancy, auth, audit, conflict prevention —
  the parts that show depth — stay in TypeScript. Rejected for this goal.
- **Extracting an existing module** (notifications worker or reports) — a
  real scaling story in a team context, but at solo scale it invites
  "why extract this?" with no good answer, and it re-implements semantics
  (dedup receipts, reminder withdrawal) that already shipped. Rejected.
- **Rewriting the NestJS API in Go and replacing it** — weeks of re-porting
  auth, tenancy, audit and booking with no equivalence proof possible (the
  tests would move, not compare). Discards the working system. Rejected.

## Consequences

- **Equivalence is a test property, not a hope.** The conformance suite
  (home: `packages/contract`) is parameterised by base URL and validates
  every response against the shared Zod schemas; CI runs it against both
  backends. A difference is a failing PR, not a surprise.
- **Behavioural parity is pinned per area** (error taxonomy codes and field
  paths, pagination shape and limits, lifecycle transitions, conflict
  semantics) while honest exceptions are allowed and stated: health names
  its dependencies differently (PostgreSQL), message wording may differ,
  identifiers/cursors/timestamps differ by nature.
- **Two backends double the review surface** while both exist. Mitigated by
  the parity ledger: CI runs the suite against the Go service with an
  explicit, committed list of not-yet-implemented behaviours that may only
  shrink; the final state requires it empty.
- The domain glossary is unchanged: "backend", "contract", "ledger" are
  implementation terms, not new domain language.
