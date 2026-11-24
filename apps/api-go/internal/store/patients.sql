-- Patient queries (Go-T11 consumes these; the seam tests exercise the
-- database semantics directly). Every Organization-scoped query is scoped by
-- the caller's organization AND runs inside db.OrgTx, where row-level
-- security pins the same id as a second guard (ADR-0018).

-- name: CreatePatient :one
INSERT INTO patient (organization_id, first_name, last_name, date_of_birth, phone, notes, contact_email)
VALUES ($1, $2, $3, $4, sqlc.narg('phone'), sqlc.narg('notes'), sqlc.narg('contact_email'))
RETURNING *;

-- name: GetPatient :one
SELECT * FROM patient
WHERE id = $1 AND organization_id = $2;

-- name: ListPatients :many
-- Keyset pagination (ADR-0008): newest-first per Organization, cursor is the
-- last item's id. NULLIF keeps an unset/empty request scope empty-handed.
SELECT * FROM patient
WHERE organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  AND ($1::uuid IS NULL OR id < $1::uuid)
ORDER BY id DESC
LIMIT $2;

-- name: UpdatePatient :one
UPDATE patient
SET first_name = COALESCE(sqlc.narg('first_name'), first_name),
    last_name = COALESCE(sqlc.narg('last_name'), last_name),
    phone = COALESCE(sqlc.narg('phone'), phone),
    notes = COALESCE(sqlc.narg('notes'), notes),
    contact_email = COALESCE(sqlc.narg('contact_email'), contact_email),
    updated_at = now()
WHERE id = $1 AND organization_id = $2
RETURNING *;

-- name: DeletePatient :exec
DELETE FROM patient
WHERE id = $1 AND organization_id = $2;

-- name: InsertAuditEntry :exec
INSERT INTO audit_entry (organization_id, actor_id, actor_email, action, entity, entity_id, before, after)
VALUES ($1, $2, $3, $4, $5, $6, sqlc.narg('before'), sqlc.narg('after'));

-- name: CountAuditEntriesForEntity :one
SELECT count(*) FROM audit_entry
WHERE organization_id = $1 AND entity = $2 AND entity_id = $3;

-- name: ListAuditEntries :many
-- Newest-first audit browsing with a (at, id) keyset cursor, org-scoped and
-- behind RLS like every domain read. The cursor params are nullable: an
-- absent cursor must not become a zero timestamp that filters everything.
SELECT * FROM audit_entry
WHERE organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  AND ($1::timestamptz IS NULL OR (at, id) < ($1::timestamptz, $2::uuid))
ORDER BY at DESC, id DESC
LIMIT $3;
