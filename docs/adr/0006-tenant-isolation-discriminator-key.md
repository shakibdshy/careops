# Tenant isolation via discriminator key

CareOps is multi-tenant: many Organizations share one deployment and one database, and
their data must never cross. We chose the discriminator-key model: every domain document
carries an `organizationId`, every query is scoped by it, and every index leads with it
(`{ organizationId, ...queryShape }`). Scoping is enforced structurally — domain services
go through an org-scoped repository base that injects the organization into every read
and write, so an unscoped query is a type error in application code, not a silent data
leak. Tenant isolation is proven by an e2e test pair asserting Organization A cannot
read or mutate Organization B's patients.

## Considered Options

- **Database-per-tenant** — strongest isolation, but migrations, index builds, and
  connection pools multiply by tenant count; operationally heavy for one deployment.
- **Collection-per-tenant** — index and schema management explodes with tenant count;
  cross-tenant reporting (not needed today) becomes painful.

## Consequences

- A missed `organizationId` would be a cross-tenant leak — hence the repository-base
  enforcement plus the e2e isolation test as a regression gate.
- Per-query compound indexes must lead with `organizationId`; adding a query shape
  means adding an index (recorded per shape in the code).
