-- 0007: widen the queue/receipt state machines (Go-T13). Claiming is
-- state-based (at-least-once): 'processing' marks a job claimed by a
-- replica; receipts begin 'PENDING' until their outcome is recorded.

ALTER TABLE notification_job DROP CONSTRAINT notification_job_state_check;
ALTER TABLE notification_job ADD CONSTRAINT notification_job_state_check
  CHECK (state IN ('pending', 'processing', 'done', 'failed'));

ALTER TABLE notification_receipt DROP CONSTRAINT notification_receipt_status_check;
ALTER TABLE notification_receipt ADD CONSTRAINT notification_receipt_status_check
  CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'SKIPPED', 'DEDUPED'));
