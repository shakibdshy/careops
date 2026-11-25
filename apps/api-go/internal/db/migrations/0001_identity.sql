-- 0001: identity plane (ADR-0014, ADR-0018). No RLS here BY DESIGN: user
-- lookup by email must be global (the invitation flow resolves users before
-- any Organization context exists). Guarded instead by unique constraints.
--
-- Also provisions the dedicated non-superuser APP role. The migration owner
-- (compose's POSTGRES_USER) bypasses RLS as a superuser; the application
-- connects as careops_app so the row-level security policies (0002) are
-- load-bearing. The local-only password matches docker-compose.yml; real
-- deployments mint it through Secrets Manager instead (ADR-0014).

CREATE TABLE app_user (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organization (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES app_user(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE organization_member (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  UNIQUE (organization_id, user_id)
);

CREATE INDEX idx_organization_member_user ON organization_member(user_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'careops_app') THEN
    CREATE ROLE careops_app LOGIN PASSWORD 'careops-app-local-only';
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO careops_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO careops_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO careops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO careops_app;
