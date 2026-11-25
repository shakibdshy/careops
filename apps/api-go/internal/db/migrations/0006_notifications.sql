-- 0006: Notifications and Reminders (Go-T13) on the PostgreSQL-backed job
-- queue (ADR-0017): a job is enqueued in the SAME transaction as the domain
-- change that causes it; processing is at-least-once with retries; receipts
-- are durable and unique per (Organization, type, referenced record), so at
-- most one Notification per event survives redelivery. Receipts are
-- org-scoped under RLS; the job table is worker-internal (no RLS — workers
-- act on behalf of every Organization).

CREATE TABLE notification_job (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('patient.created', 'appointment.booked', 'appointment.reminder')),
  payload      JSONB NOT NULL,
  run_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts     INT NOT NULL DEFAULT 0,
  state        TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'processing', 'done', 'failed')),
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The poller's claim query shape: due jobs in FIFO order.
CREATE INDEX idx_notification_job_due ON notification_job (state, run_at);
-- Reminder withdrawal (a pending reminder is deleted when its appointment
-- is cancelled or moved past the reminder time): find pending reminders by
-- the appointment they reference.
CREATE INDEX idx_notification_job_reminder ON notification_job (kind, (payload->>'appointmentId'));

CREATE TABLE notification_receipt (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  kind               TEXT NOT NULL CHECK (kind IN ('patient.created', 'appointment.booked', 'appointment.reminder')),
  entity_id          UUID NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('SENT', 'FAILED', 'SKIPPED', 'DEDUPED')),
  recipient          TEXT,
  provider_message_id TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- At most one Notification per event per referenced record (the same
  -- durability guarantee the reference's Mongo unique index provides).
  UNIQUE (organization_id, kind, entity_id)
);

CREATE INDEX idx_notification_receipt_org_cursor ON notification_receipt (organization_id, id DESC);

ALTER TABLE notification_receipt ENABLE ROW LEVEL SECURITY;
CREATE POLICY notification_receipt_org_isolation ON notification_receipt
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
