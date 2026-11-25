# Go query plans: list + report queries, before and after their indexes

Measured 2026-11-25, local PostgreSQL 17 (docker), demo org at realistic volume:
5,04 Patients, 3,086 Appointments across 3 Providers over ±15 days (parity fixtures + bulk slots);
every query runs org-scoped exactly as the API runs it (SET app.organization_id), EXPLAIN (ANALYZE, BUFFERS).

## Findings

1. **Patients list (keyset created_at DESC, id DESC)** — before: Seq Scan of all 504 org rows + top-N sort (0.28 ms);
   after idx_patient_org_created_cursor (org, created_at DESC, id DESC): Index Scan reading 21 rows (0.036 ms, ~8x).
2. **Appointments list (same keyset)** — before: Seq Scan of all 3,086 org rows + sort (1.12 ms);
   after idx_appointment_org_created_cursor: Index Scan reading 21 rows (0.065 ms, ~17x). This receipt is what motivated
   migration 0010: the (org, id DESC) cursor indexes could not serve the composite keyset introduced with newest-first ordering.
3. **Audit list (at DESC, id DESC)** — same shape, covered by idx_audit_entry_org_at_cursor (migration 0010).
4. **Daily volume** — Index Scan on idx_appointment_org_start per day bucket (0.53 ms for 30 buckets).
5. **Status breakdown** — Seq Scan over the org window: correct at this shape (the 30-day window covers ~all org rows;
   the (org, status) index serves the status-filtered list queries instead). 0.73 ms.
6. **Provider utilization** — join reads the org window (3,002 of 3,086 rows qualify — Seq Scan is the right plan here);
   idx_appointment_org_provider_start serves the per-provider booking-conflict check. 1.50 ms.
7. **Today** — Index Scan on idx_appointment_org_start for the UTC day range, sorted by start.

Full plans follow.

### rows: 3086 appointments, 504 patients in the demo org

================ 1. patients list (keyset: created_at DESC, id DESC) ================
--- BEFORE (idx_patient_org_cursor = (org, id DESC) only) ---
SET
                                                       QUERY PLAN                                                       
------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=35.93..35.98 rows=21 width=138) (actual time=0.256..0.257 rows=21 loops=1)
   Buffers: shared hit=17
   ->  Sort  (cost=35.93..37.19 rows=504 width=138) (actual time=0.255..0.255 rows=21 loops=1)
         Sort Key: created_at DESC, id DESC
         Sort Method: top-N heapsort  Memory: 35kB
         Buffers: shared hit=17
         ->  Seq Scan on patient  (cost=0.00..22.34 rows=504 width=138) (actual time=0.006..0.185 rows=504 loops=1)
               Filter: (organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)
               Buffers: shared hit=11
 Planning:
   Buffers: shared hit=127
 Planning Time: 0.338 ms
 Execution Time: 0.281 ms
(13 rows)

--- drop cursor index (worst case) ---
SET
                                                       QUERY PLAN                                                       
------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=35.93..35.98 rows=21 width=138) (actual time=0.233..0.235 rows=21 loops=1)
   Buffers: shared hit=17
   ->  Sort  (cost=35.93..37.19 rows=504 width=138) (actual time=0.232..0.233 rows=21 loops=1)
         Sort Key: created_at DESC, id DESC
         Sort Method: top-N heapsort  Memory: 35kB
         Buffers: shared hit=17
         ->  Seq Scan on patient  (cost=0.00..22.34 rows=504 width=138) (actual time=0.006..0.172 rows=504 loops=1)
               Filter: (organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)
               Buffers: shared hit=11
 Planning:
   Buffers: shared hit=113
 Planning Time: 0.290 ms
 Execution Time: 0.255 ms
(13 rows)

--- AFTER: new keyset index (org, created_at DESC, id DESC) ---
SET
                                                                     QUERY PLAN                                                                     
----------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.28..2.78 rows=21 width=138) (actual time=0.014..0.017 rows=21 loops=1)
   Buffers: shared hit=2 read=2
   ->  Index Scan using idx_patient_org_created_cursor on patient  (cost=0.28..60.23 rows=504 width=138) (actual time=0.013..0.016 rows=21 loops=1)
         Index Cond: (organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)
         Buffers: shared hit=2 read=2
 Planning:
   Buffers: shared hit=136 read=1
 Planning Time: 0.307 ms
 Execution Time: 0.036 ms
(9 rows)


================ 2. appointments list (keyset) ================
--- BEFORE (idx_appointment_org_cursor = (org, id DESC) only) ---
SET
                                                       QUERY PLAN                                                        
-------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=104.51..104.56 rows=21 width=147) (actual time=1.100..1.101 rows=21 loops=1)
   Buffers: shared hit=70
   ->  Sort  (cost=104.51..106.56 rows=819 width=147) (actual time=1.099..1.100 rows=21 loops=1)
         Sort Key: created_at DESC, id DESC
         Sort Method: top-N heapsort  Memory: 36kB
         Buffers: shared hit=70
         ->  Seq Scan on appointment  (cost=0.00..82.43 rows=819 width=147) (actual time=0.006..0.926 rows=3086 loops=1)
               Filter: (organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)
               Buffers: shared hit=64
 Planning:
   Buffers: shared hit=228
 Planning Time: 0.461 ms
 Execution Time: 1.122 ms
(13 rows)

--- AFTER: new keyset index ---
SET
                                                                          QUERY PLAN                                                                          
--------------------------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.29..2.36 rows=21 width=147) (actual time=0.016..0.044 rows=21 loops=1)
   Buffers: shared hit=21 read=2
   ->  Index Scan using idx_appointment_org_created_cursor on appointment  (cost=0.29..303.98 rows=3086 width=147) (actual time=0.016..0.043 rows=21 loops=1)
         Index Cond: (organization_id = (NULLIF(current_setting('app.organization_id'::text, true), ''::text))::uuid)
         Buffers: shared hit=21 read=2
 Planning:
   Buffers: shared hit=245 read=1
 Planning Time: 0.502 ms
 Execution Time: 0.065 ms
(9 rows)


================ 3. daily volume (org + starts_at range join) ================
SET
                                                                                QUERY PLAN                                                                                 
---------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=13493.10..13493.60 rows=200 width=44) (actual time=0.491..0.492 rows=30 loops=1)
   Sort Key: d.day
   Sort Method: quicksort  Memory: 26kB
   Buffers: shared hit=192
   ->  HashAggregate  (cost=13482.46..13485.46 rows=200 width=44) (actual time=0.470..0.478 rows=30 loops=1)
         Group Key: d.day
         Batches: 1  Memory Usage: 40kB
         Buffers: shared hit=189
         ->  Nested Loop Left Join  (cost=0.30..11768.02 rows=342889 width=24) (actual time=0.016..0.314 rows=2332 loops=1)
               Buffers: shared hit=189
               ->  Function Scan on generate_series d  (cost=0.02..10.02 rows=1000 width=8) (actual time=0.008..0.008 rows=30 loops=1)
               ->  Index Scan using idx_appointment_org_start on appointment a  (cost=0.28..8.33 rows=343 width=24) (actual time=0.001..0.007 rows=77 loops=30)
                     Index Cond: ((organization_id = 'a46d9646-3246-4b86-bde6-88dcbc374211'::uuid) AND (starts_at >= d.day) AND (starts_at < (d.day + '1 day'::interval)))
                     Buffers: shared hit=189
 Planning:
   Buffers: shared hit=223
 Planning Time: 0.470 ms
 Execution Time: 0.533 ms
(18 rows)


================ 4. status breakdown (org + window group) ================
SET
                                                                   QUERY PLAN                                                                   
------------------------------------------------------------------------------------------------------------------------------------------------
 HashAggregate  (cost=156.58..156.67 rows=7 width=14) (actual time=0.689..0.690 rows=7 loops=1)
   Group Key: status
   Batches: 1  Memory Usage: 24kB
   Buffers: shared hit=64
   ->  Seq Scan on appointment  (cost=0.00..141.15 rows=3086 width=10) (actual time=0.009..0.510 rows=3086 loops=1)
         Filter: ((organization_id = 'a46d9646-3246-4b86-bde6-88dcbc374211'::uuid) AND (starts_at >= (now() - ('30 days'::cstring)::interval)))
         Buffers: shared hit=64
 Planning:
   Buffers: shared hit=253
 Planning Time: 0.577 ms
 Execution Time: 0.729 ms
(11 rows)


================ 5. provider utilization (org + provider join) ================
SET
                                                                                            QUERY PLAN                                                                                            
--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=181.63..181.67 rows=16 width=88) (actual time=1.435..1.436 rows=3 loops=1)
   Sort Key: ((COALESCE(sum(a.duration_minutes), '0'::bigint))::integer) DESC, m.id
   Sort Method: quicksort  Memory: 25kB
   Buffers: shared hit=76
   ->  GroupAggregate  (cost=180.79..181.31 rows=16 width=88) (actual time=1.316..1.423 rows=3 loops=1)
         Group Key: m.id, u.name
         Buffers: shared hit=70
         ->  Sort  (cost=180.79..180.83 rows=16 width=68) (actual time=1.263..1.313 rows=3002 loops=1)
               Sort Key: m.id, u.name
               Sort Method: quicksort  Memory: 292kB
               Buffers: shared hit=70
               ->  Hash Join  (cost=162.06..180.47 rows=16 width=68) (actual time=0.887..0.983 rows=3002 loops=1)
                     Hash Cond: (u.id = m.user_id)
                     Buffers: shared hit=67
                     ->  Seq Scan on app_user u  (cost=0.00..15.50 rows=550 width=48) (actual time=0.002..0.002 rows=3 loops=1)
                           Buffers: shared hit=1
                     ->  Hash  (cost=161.86..161.86 rows=16 width=52) (actual time=0.882..0.883 rows=3002 loops=1)
                           Buckets: 4096 (originally 1024)  Batches: 1 (originally 1)  Memory Usage: 279kB
                           Buffers: shared hit=66
                           ->  Hash Right Join  (cost=12.69..161.86 rows=16 width=52) (actual time=0.015..0.728 rows=3002 loops=1)
                                 Hash Cond: (a.provider_member_id = m.id)
                                 Buffers: shared hit=66
                                 ->  Seq Scan on appointment a  (cost=0.00..141.15 rows=3037 width=36) (actual time=0.005..0.546 rows=3002 loops=1)
                                       Filter: ((status <> ALL ('{CANCELLED,NO_SHOW}'::text[])) AND (starts_at >= (now() - ('30 days'::cstring)::interval)))
                                       Rows Removed by Filter: 84
                                       Buffers: shared hit=64
                                 ->  Hash  (cost=12.64..12.64 rows=4 width=32) (actual time=0.007..0.008 rows=3 loops=1)
                                       Buckets: 1024  Batches: 1  Memory Usage: 9kB
                                       Buffers: shared hit=2
                                       ->  Bitmap Heap Scan on organization_member m  (cost=4.18..12.64 rows=4 width=32) (actual time=0.004..0.005 rows=3 loops=1)
                                             Recheck Cond: (organization_id = 'a46d9646-3246-4b86-bde6-88dcbc374211'::uuid)
                                             Heap Blocks: exact=1
                                             Buffers: shared hit=2
                                             ->  Bitmap Index Scan on organization_member_organization_id_user_id_key  (cost=0.00..4.18 rows=4 width=0) (actual time=0.001..0.001 rows=3 loops=1)
                                                   Index Cond: (organization_id = 'a46d9646-3246-4b86-bde6-88dcbc374211'::uuid)
                                                   Buffers: shared hit=1
 Planning:
   Buffers: shared hit=373
 Planning Time: 0.727 ms
 Execution Time: 1.499 ms
(40 rows)


================ 6. today (org + starts_at day range) ================
SET
                                                                                                      QUERY PLAN                                                                                                       
-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
 Sort  (cost=98.46..99.24 rows=311 width=147) (actual time=0.056..0.059 rows=142 loops=1)
   Sort Key: starts_at
   Sort Method: quicksort  Memory: 46kB
   Buffers: shared hit=16
   ->  Bitmap Heap Scan on appointment  (cost=12.26..85.59 rows=311 width=147) (actual time=0.020..0.039 rows=142 loops=1)
         Recheck Cond: ((organization_id = 'a46d9646-3246-4b86-bde6-88dcbc374211'::uuid) AND (starts_at >= date_trunc('day'::text, now())) AND (starts_at < (date_trunc('day'::text, now()) + '1 day'::interval)))
         Heap Blocks: exact=10
         Buffers: shared hit=13
         ->  Bitmap Index Scan on idx_appointment_org_start  (cost=0.00..12.18 rows=311 width=0) (actual time=0.015..0.015 rows=142 loops=1)
               Index Cond: ((organization_id = 'a46d9646-3246-4b86-bde6-88dcbc374211'::uuid) AND (starts_at >= date_trunc('day'::text, now())) AND (starts_at < (date_trunc('day'::text, now()) + '1 day'::interval)))
               Buffers: shared hit=3
 Planning:
   Buffers: shared hit=241
 Planning Time: 0.498 ms
 Execution Time: 0.097 ms
(15 rows)

