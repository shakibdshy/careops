-- 0004: auth sessions and invitations (Go-T09). Sessions store a SHA-256
-- hash of the bearer token — never the token itself — with an expiry; the
-- active organization is a session attribute, resolved with the same
-- first-membership fallback the reference implements. Invitations are
-- Organization-scoped rows with a pending/accepted lifecycle.

CREATE TABLE session (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  token_hash            TEXT NOT NULL UNIQUE,
  active_organization_id UUID REFERENCES organization(id) ON DELETE SET NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_session_user ON session(user_id);

-- The reference names each signup organization `org-<userId>` (BetterAuth's
-- organization plugin carries a slug; the shared org surface exposes it).
ALTER TABLE organization ADD COLUMN slug TEXT UNIQUE;

CREATE TABLE organization_invitation (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email           TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'canceled')),
  inviter_id      UUID NOT NULL REFERENCES app_user(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organization_id, email, status)
);
CREATE INDEX idx_organization_invitation_email ON organization_invitation(email);
