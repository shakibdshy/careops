-- Notification queue + receipt queries (Go-T13).

-- name: EnqueueNotificationJob :exec
INSERT INTO notification_job (kind, payload, run_at)
VALUES ($1, $2, COALESCE(sqlc.narg('run_at'), now()));

-- name: ClaimDueJobs :many
-- State-based claiming with FOR UPDATE SKIP LOCKED: several replicas can
-- poll safely, each due job is claimed by exactly one, and the ROW SURVIVES
-- a crash during processing (at-least-once, ADR-0017) — stuck 'processing'
-- rows are requeued by the worker's janitor.
UPDATE notification_job
SET state = 'processing', attempts = attempts + 1
WHERE id IN (
  SELECT id FROM notification_job
  WHERE state = 'pending' AND run_at <= now()
  ORDER BY run_at
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
RETURNING id, kind, payload, attempts;

-- name: CompleteJob :exec
UPDATE notification_job SET state = 'done' WHERE id = $1;

-- name: RequeueJob :exec
UPDATE notification_job
SET state = 'pending',
    run_at = now() + make_interval(secs => sqlc.narg('backoff_seconds')::float8),
    last_error = $2
WHERE id = $1;

-- name: RequeueStuckJobs :execrows
-- Janitor: jobs claimed by a crashed replica would sit in 'processing'
-- forever; anything older than 5 minutes goes back to pending.
UPDATE notification_job
SET state = 'pending', run_at = now()
WHERE state = 'processing' AND created_at < now() - interval '5 minutes';

-- name: WithdrawReminderJobs :execrows
DELETE FROM notification_job
WHERE kind = 'appointment.reminder'
  AND state = 'pending'
  AND payload->>'appointmentId' = $1;

-- name: InsertReceiptIfNew :one
-- The dedup boundary: the unique (organization, kind, entity) index makes a
-- duplicate event a no-op that still reports whether it inserted.
INSERT INTO notification_receipt (organization_id, kind, entity_id, status, recipient, provider_message_id)
VALUES ($1, $2, $3, $4, sqlc.narg('recipient'), sqlc.narg('provider_message_id'))
ON CONFLICT (organization_id, kind, entity_id) DO NOTHING
RETURNING id;

-- name: PatientContactEmail :one
SELECT contact_email FROM patient WHERE id = $1;

-- name: UpdateReceiptOutcome :exec
UPDATE notification_receipt
SET status = $2, recipient = $3, provider_message_id = $4
WHERE id = $1;

-- name: FailJob :exec
UPDATE notification_job SET state = 'failed', last_error = $2 WHERE id = $1;

-- name: PurgeDeadOrgJobs :execrows
-- Janitor: poison jobs are purged outright — dead-Organization jobs (their
-- receipt could never be written) and anything older than 24 hours (a
-- Notification a day late is not worth delivering; stale boot backlogs
-- must not delay fresh deliveries).
DELETE FROM notification_job
WHERE NOT EXISTS (
  SELECT 1 FROM organization o
  WHERE o.id = (payload->>'organizationId')::uuid
) OR created_at < now() - interval '24 hours';
