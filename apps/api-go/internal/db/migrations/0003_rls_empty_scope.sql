-- 0003: treat an EMPTY app.organization_id as unset. After a rolled-back
-- transaction, Postgres leaves a `set_config(..., is_local => true)` variable
-- defined but empty on the session — current_setting(name, true) then returns
-- '' (not NULL), and ''::uuid raises instead of filtering. NULLIF makes the
-- unscoped case (never set, or set-and-rolled-back) see zero rows, which is
-- the guarantee the seam test asserts.

DROP POLICY IF EXISTS patient_org_isolation ON patient;
CREATE POLICY patient_org_isolation ON patient
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);

DROP POLICY IF EXISTS audit_entry_org_isolation ON audit_entry;
CREATE POLICY audit_entry_org_isolation ON audit_entry
  USING (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid)
  WITH CHECK (organization_id = NULLIF(current_setting('app.organization_id', true), '')::uuid);
