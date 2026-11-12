# Reports cache-aside with an org-scoped generation counter

The two aggregation reports — daily-volume and provider-utilization — are served
cache-aside from Redis; status-breakdown and today are computed live (today is a plain
indexed range query, never an aggregation). Each cache entry key embeds a per-Organization
generation counter, `reports:{org}:{generation}:{report}:{days}`, and every Appointment
write (create, transition, reschedule) advances that counter with a single
`INCR reports:gen:{org}` after the transaction commits. A new generation means a new key,
so the next read recomputes and the booking is reflected immediately — invalidation is
O(1) and instant, with no key scans. The Organization id lives in both the counter key and
the entry key, so tenant isolation is structural (ADR-0006). A TTL (300s) is a backstop,
not the primary invalidator: a missed bump self-heals when the entry expires.

## Considered Options

- **TTL-only** — the simplest cache, but a just-booked appointment stays invisible in the
  reports for up to the whole TTL window. Unacceptable for a live clinic dashboard where
  the schedule should reflect a booking the moment it commits. Rejected as the primary
  mechanism; kept only as the backstop above.
- **Key-scan deletion (`SCAN`/`KEYS` + `DEL` by prefix)** — invalidation cost scales with
  the keyspace on every write, `KEYS` blocks Redis, and a scan can miss entries written
  concurrently by another request. Races and unbounded cost. Rejected.
- **Explicit per-entry `DEL`** — the writer would have to enumerate every cached
  `{report, days}` combination, coupling the appointments context to the reports key
  scheme, and still race with a concurrent recompute repopulating a deleted key. The
  counter sidesteps both: one bump invalidates every current and future key for the org
  without naming them. Rejected.

## Consequences

- The bump is **post-commit and best-effort**: it runs outside the booking transaction and
  is wrapped so a Redis failure only logs a warning. A crash between commit and bump, or a
  Redis outage, leaves a stale entry until the TTL expires — bounded staleness (≤300s),
  never a failed request or a rolled-back booking. Redis is a boundary: every cache read
  and write degrades to a fresh compute on error.
- Old-generation entries are orphaned rather than deleted; they expire by TTL. A busy org
  briefly holds a few stale copies, bounded by TTL × write rate — an accepted trade for
  O(1) invalidation.
- Every write pays one extra `INCR`; every cached read pays a counter `GET` plus an entry
  `GET`. Constant and cheap, independent of how many reports or window sizes are cached.
- Only the aggregations are cached. Today and status-breakdown stay live so the most
  latency-sensitive "what is happening now" view is never stale.
