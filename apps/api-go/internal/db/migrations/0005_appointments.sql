-- 0005: the Appointments bounded context (Go-T12). Conflict prevention is a
-- DATABASE guarantee (ADR-0019): an exclusion constraint over the provider
-- and the booked slot range makes overlapping slot-holding appointments
-- impossible to commit — the slot-holding status set mirrors the shared
-- lifecycle rule (freed = CANCELLED, NO_SHOW). The table is org-scoped with
-- row-level security like patients (ADR-0018).
--
-- The slot range is a plain column kept by the write trigger: a generated
-- column cannot compute timestamptz + interval (the operator is stable, not
-- immutable), but ordinary INSERT/UPDATE expressions carry no such rule.

-- The exclusion constraint compares the provider id for equality under
-- gist, which core Postgres only offers through btree_gist's opclasses.
CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE appointment (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    UUID NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  patient_id         UUID NOT NULL REFERENCES patient(id) ON DELETE CASCADE,
  provider_member_id UUID NOT NULL REFERENCES organization_member(id) ON DELETE RESTRICT,
  starts_at          TIMESTAMPTZ NOT NULL,
  duration_minutes   INT NOT NULL CHECK (duration_minutes BETWEEN 15 AND 480),
  status             TEXT NOT NULL DEFAULT 'SCHEDULED'
                       CHECK (status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW')),
  notes              TEXT,
  slot               tstzrange NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Compute the booked range [starts_at, starts_at + duration) on every write,
-- so the column can never drift from the columns it derives from.
CREATE FUNCTION appointment_slot_calc_fn() RETURNS trigger AS $$
BEGIN
  NEW.slot := tstzrange(NEW.starts_at, NEW.starts_at + NEW.duration_minutes * interval '1 minute', '[)');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointment_slot_calc
  BEFORE INSERT OR UPDATE OF starts_at, duration_minutes ON appointment
  FOR EACH ROW EXECUTE FUNCTION appointment_slot_calc_fn();

-- Conflict prevention (ADR-0019): one provider cannot hold overlapping
-- slots while the appointment holds one. Freed states are excluded from the
-- constraint, mirroring the shared lifecycle rule the reference's conflict
-- predicate encodes.
ALTER TABLE appointment ADD CONSTRAINT appointment_no_slot_overlap
  EXCLUDE USING gist (
    provider_member_id gist_uuid_ops WITH =,
    slot WITH &&
  ) WHERE (status IN ('SCHEDULED','CONFIRMED','CHECKED_IN','IN_PROGRESS'));

CREATE INDEX idx_appointment_org_cursor ON appointment (organization_id, id DESC);
CREATE INDEX idx_appointment_org_start ON appointment (organization_id, starts_at);
CREATE INDEX idx_appointment_org_provider_start ON appointment (organization_id, provider_member_id, starts_at);
CREATE INDEX idx_appointment_org_status ON appointment (organization_id, status);

ALTER TABLE appointment ENABLE ROW LEVEL SECURITY;
CREATE POLICY appointment_org_isolation ON appointment
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

-- Reschedule semantics: moving the slot columns is only legal while the
-- appointment holds SCHEDULED or CONFIRMED. The handler returns the
-- reference's 409; this trigger is the structural statement of the rule.
CREATE FUNCTION appointment_reschedule_guard_fn() RETURNS trigger AS $$
BEGIN
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
     OR NEW.provider_member_id IS DISTINCT FROM OLD.provider_member_id THEN
    IF OLD.status NOT IN ('SCHEDULED', 'CONFIRMED') THEN
      RAISE EXCEPTION 'appointment in status % cannot be rescheduled', OLD.status
        USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointment_reschedule_guard
  BEFORE UPDATE ON appointment
  FOR EACH ROW EXECUTE FUNCTION appointment_reschedule_guard_fn();
