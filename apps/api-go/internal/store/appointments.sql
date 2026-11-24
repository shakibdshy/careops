-- Appointment queries (Go-T12). Every Organization-scoped read runs inside
-- db.OrgTx; writes additionally run their Conflict rule against the
-- exclusion constraint (ADR-0019) — a violation surfaces as SQLSTATE 23P01.

-- name: CreateAppointment :one
INSERT INTO appointment (organization_id, patient_id, provider_member_id, starts_at, duration_minutes, notes)
VALUES ($1, $2, $3, $4, $5, sqlc.narg('notes'))
RETURNING *;

-- name: GetAppointment :one
SELECT * FROM appointment
WHERE id = $1 AND organization_id = $2;

-- name: PatientExists :one
SELECT EXISTS (SELECT 1 FROM patient WHERE id = $1 AND organization_id = $2) AS present;

-- name: ProviderExists :one
SELECT EXISTS (SELECT 1 FROM organization_member WHERE id = $1 AND organization_id = $2) AS present;

-- name: ListAppointments :many
-- Newest-first keyset (ADR-0008) with the contract's optional filters:
-- status, provider, and a [from, to] start window.
SELECT * FROM appointment
WHERE organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid
  AND (sqlc.narg('cursor')::uuid IS NULL OR id < sqlc.narg('cursor')::uuid)
  AND (sqlc.narg('status')::text IS NULL OR status = sqlc.narg('status')::text)
  AND (sqlc.narg('member')::uuid IS NULL OR provider_member_id = sqlc.narg('member')::uuid)
  AND (sqlc.narg('from_ts')::timestamptz IS NULL OR starts_at >= sqlc.narg('from_ts')::timestamptz)
  AND (sqlc.narg('to_ts')::timestamptz IS NULL OR starts_at <= sqlc.narg('to_ts')::timestamptz)
ORDER BY id DESC
LIMIT sqlc.arg('limit');

-- name: TransitionAppointment :one
UPDATE appointment
SET status = $2, updated_at = now()
WHERE id = $1 AND organization_id = $3
RETURNING *;

-- name: RescheduleAppointment :one
UPDATE appointment
SET starts_at = COALESCE(sqlc.narg('starts_at'), starts_at),
    duration_minutes = COALESCE(sqlc.narg('duration_minutes'), duration_minutes),
    provider_member_id = COALESCE(sqlc.narg('provider_member_id'), provider_member_id),
    notes = COALESCE(sqlc.narg('notes'), notes),
    updated_at = now()
WHERE id = $1 AND organization_id = $2
RETURNING *;

