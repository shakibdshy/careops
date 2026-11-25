-- 0009: make row-level security load-bearing for the TABLE OWNER too
-- (FORCE). On the deployed tier (ADR-0014) the application and the migration
-- runner share the RDS master role — the owner would otherwise bypass the
-- org-scoping policies, reducing them to advice. With FORCE the policies
-- bind every role, including the owner: an unscoped query sees nothing
-- regardless of which role issued it. Local dev keeps the two-role split
-- (careops_app is not the owner and was always bound), so behavior is
-- identical across environments.

ALTER TABLE patient FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_entry FORCE ROW LEVEL SECURITY;
ALTER TABLE appointment FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_receipt FORCE ROW LEVEL SECURITY;
