# Cursor pagination on all list endpoints

Every list endpoint paginates by cursor (`_id`-based, `{ items, nextCursor, hasMore }`
envelope in the shared contract) rather than skip/offset. In MongoDB, `skip(n)` walks
and discards n documents server-side — latency grows linearly with page depth and it
misses indexes' point of doing real work — while a cursor range scan (`_id > cursor`
with the per-query-shape compound index) is O(pageSize) regardless of depth. Cursor
pagination also can't skip or duplicate rows across pages when documents are inserted
concurrently, which offset pagination does.

## Considered Options

- **Offset/skip pagination** — simpler mental model, fine at toy scale, degrades
  predictably at depth.
- **Bare arrays (no pagination)** — would force a breaking contract change the first
  time a list grows.

## Consequences

Clients can't jump to an arbitrary page number (no "page 7 of 40" UI); the web app
uses infinite scroll / "load more".
