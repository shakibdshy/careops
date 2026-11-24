-- 0002: the first Organization-scoped domain tables (patients, audit) with
-- row-level security as the second tenancy guard (ADR-0018): every policy
-- keys on the per-request `app.organization_id` setting, so a connection
-- that forgets to scope sees nothing rather than everything. Audit Entries
-- are append-only at the database level: the app role has no UPDATE/DELETE
-- grant (glossary: Audit Entries are never edited or deleted).

CREATE TABLE patient (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  first_name      TEXT NOT NULL CHECK (length(first_name) BETWEEN 1 AND 100),
  last_name       TEXT NOT NULL CHECK (length(last_name) BETWEEN 1 AND 100),
  date_of_birth   DATE NOT NULL CHECK (date_of_birth < CURRENT_DATE),
  phone           TEXT,
  notes           TEXT,
  contact_email   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Keyset-pagination index (ADR-0008's shape, in SQL): list newest-first per org.
CREATE INDEX idx_patient_org_cursor ON patient (organization_id, id DESC);

ALTER TABLE patient ENABLE ROW LEVEL SECURITY;
CREATE POLICY patient_org_isolation ON patient
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

CREATE TABLE audit_entry (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  actor_id        UUID NOT NULL REFERENCES app_user(id),
  actor_email     TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  entity          TEXT NOT NULL,
  entity_id       UUID NOT NULL,
  before          JSONB,
  after           JSONB,
  at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_entry_org_entity ON audit_entry (organization_id, entity, entity_id, at DESC);
CREATE INDEX idx_audit_entry_org_cursor ON audit_entry (organization_id, id DESC);

ALTER TABLE audit_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_entry_org_isolation ON audit_entry
  USING (organization_id = current_setting('app.organization_id', true)::uuid)
  WITH CHECK (organization_id = current_setting('app.organization_id', true)::uuid);

-- Append-only (ADR-0020): the app role can INSERT and SELECT, never mutate.
REVOKE UPDATE, DELETE ON audit_entry FROM careops_app;
