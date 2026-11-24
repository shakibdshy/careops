-- Reports queries (Go-T13). SQL aggregations over the org-scoped plane,
-- executed inside db.OrgTx (RLS re-checks the scope). Every query filters
-- appointments to the window [now() - days, now()) in UTC — the same
-- window semantics as the reference's aggregations.

-- name: DailyVolume :many
-- Exactly `days` UTC-day buckets ending today (the reference's window is
-- [today midnight - (days-1), tomorrow)), zero-filled by construction — an
-- Organization with no appointments still gets its 30 zero points.
SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
       count(a.id)::int AS count
FROM generate_series(
       current_date - ($2::int - 1),
       current_date,
       interval '1 day'
     ) AS d(day)
LEFT JOIN appointment a
  ON a.organization_id = $1
 AND a.starts_at >= d.day
 AND a.starts_at < d.day + interval '1 day'
GROUP BY d.day
ORDER BY d.day;

-- name: StatusBreakdown :many
SELECT status, count(*)::int AS count
FROM appointment
WHERE organization_id = $1
  AND starts_at >= now() - ($2::int || ' days')::interval
GROUP BY status;

-- name: ProviderUtilization :many
-- Booked minutes per Provider over the window, excluding freed slots
-- (CANCELLED / NO_SHOW carry no booked time — the same rule the reference's
-- aggregation encodes). Names resolved by the join, like the reference's
-- $lookup.
SELECT m.id::text AS member_id,
       u.name AS provider_name,
       COALESCE(sum(a.duration_minutes), 0)::int AS booked_minutes,
       count(a.id)::int AS appointment_count
FROM organization_member m
JOIN app_user u ON u.id = m.user_id
LEFT JOIN appointment a
  ON a.provider_member_id = m.id
 AND a.status NOT IN ('CANCELLED', 'NO_SHOW')
 AND a.starts_at >= now() - ($2::int || ' days')::interval
WHERE m.organization_id = $1
GROUP BY m.id, u.name
ORDER BY booked_minutes DESC, m.id;

-- name: TodaysAppointments :many
-- Plain indexed range query for the UTC calendar day, sorted by start.
SELECT * FROM appointment
WHERE organization_id = $1
  AND starts_at >= $2::timestamptz
  AND starts_at < $2::timestamptz + interval '1 day'
ORDER BY starts_at;

-- name: BumpReportGeneration :one
-- The cache-aside generation counter (ADR-0011): every Appointment write
-- advances the counter post-commit; the new generation means a new key, so
-- the next read recomputes — O(1) invalidation, no key scans.
INSERT INTO report_generation (organization_id, generation)
VALUES ($1, 1)
ON CONFLICT (organization_id) DO UPDATE SET generation = report_generation.generation + 1
RETURNING generation;

-- name: GetReportGeneration :one
SELECT generation FROM report_generation WHERE organization_id = $1;
