-- 0010: keyset-ordered list indexes. The list cursors moved from the bare id
-- to the (created_at, id) tuple — Postgres UUIDs are random, so "newest
-- first" must order by time and tie-break by id. The previous cursor indexes
-- ((organization_id, id DESC)) cannot serve that ordering: every page was a
-- Seq Scan over the Organization's rows plus a top-N sort (measured in
-- tools/receipts/comparison/go-plans.md — the appointments list read all
-- 3,086 org rows to return 21). These indexes make each keyset page an
-- Index Scan that stops at LIMIT + 1 rows. The superseded id-cursor indexes
-- have no remaining query shape and are dropped.

DROP INDEX idx_patient_org_cursor;
DROP INDEX idx_appointment_org_cursor;
DROP INDEX idx_audit_entry_org_cursor;

CREATE INDEX idx_patient_org_created_cursor ON patient (organization_id, created_at DESC, id DESC);
CREATE INDEX idx_appointment_org_created_cursor ON appointment (organization_id, created_at DESC, id DESC);
CREATE INDEX idx_audit_entry_org_at_cursor ON audit_entry (organization_id, at DESC, id DESC);
