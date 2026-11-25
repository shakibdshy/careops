-- 0008: per-Organization report cache generation counters (ADR-0011 in
-- PostgreSQL form): every Appointment write bumps the counter after its
-- transaction commits; cache keys embed the generation, so a write makes
-- the next read recompute with O(1) invalidation.

CREATE TABLE report_generation (
  organization_id UUID PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  generation      BIGINT NOT NULL DEFAULT 1
);
