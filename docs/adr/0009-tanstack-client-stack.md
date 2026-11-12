# TanStack client stack with shared-Zod forms

The web app standardizes on the TanStack ecosystem for client data and UI state:
**Query** owns server-cache fetching, **DB** owns live collections and optimistic
mutations, **Table** renders headless lists, **Form** drives schema-validated forms,
**Pacer** supplies debounce/throttle primitives, and **Charts** will render the
reporting screens (W2-T7). shadcn/ui components are the rendering layer underneath.
One ecosystem means one mental model for caching, reactivity, and SSR safety instead
of stitching together unrelated libraries with overlapping responsibilities.

Forms validate with the **shared Zod contract** (ADR-0002) through Standard Schema:
the same schema object that guards the API DTOs is handed to TanStack Form, so client
and server can never drift. The reusable `ZodForm` component wraps this pattern and
merges Zod issues with the API's `errors[]` taxonomy into one error display per field,
so a 4xx surfaces the server's reason on the exact field that caused it.

**TanStack Store is deliberately not adopted.** Query and DB already cover the
reactive state this app needs; a separate client-state store would add a third place
for state to live with no current consumer.

## Considered Options

- **React Hook Form + hand-rolled fetch state** — mature, but validation schemas would
  be duplicated or adapted per form, and optimistic updates would be bespoke per screen.
- **Redux/RTK Query or Zustand + separate table/form libraries** — more moving parts,
  more glue code, and no shared contract story.
- **TanStack DB at stable only** — waiting blocks the optimistic-edit requirement;
  the pre-stable API is accepted instead (see Consequences).

## Consequences

- TanStack DB is pre-stable (`1.0.0-rc`, pinned exactly). Breaking changes are expected
  before 1.0; the pin plus the e2e suite make upgrades deliberate. The documented
  fallback if DB proves unworkable is Table's manual server-side mode: drop the
  collection, feed Table from Query directly, and make edits server-first with a
  refetch — the cursor pager and API contract stay unchanged.
- Collections are SSR-safe descriptors materialized per `DbClient`; live queries only
  subscribe behind a client-side session gate, never during SSR.
- Pacer ships now but has no consumer until the debounced pickers in the booking form
  (W2-T6); Charts arrives with reporting (W2-T7).
