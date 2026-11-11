# DB-backed cookie sessions over stateless JWT

The scaling checklist expects a "stateless API (JWT + refresh rotation)" story. We
deliberately keep BetterAuth's httpOnly cookie sessions backed by MongoDB instead, and
record why: statelessness that matters for horizontal scaling is the absence of
in-process/sticky state — and DB-backed sessions have none. Any replica behind the load
balancer validates a session with one indexed Mongo lookup, so "add replicas" scales
identically to JWT while retaining server-side revocation (a JWT cannot be un-issued
before expiry without a denylist, which reintroduces shared state anyway). For a
server-rendered web client, JWT + refresh rotation adds complexity and XSS-exposure
(httpOnly cookies are safer than tokens in JS) with no scaling win.

## Considered Options

- **BetterAuth JWT bearer plugin** — recorded as the intended path if a mobile app or
  third-party API-token clients arrive; not adopted for the web app now.
- **Hand-rolled JWT + refresh** — re-implements an audited auth library for no benefit.

## Consequences

The scaling narrative in docs/scaling.md must argue session-store scalability honestly
(sessions are a tiny, indexed, horizontally-shared collection) rather than name-drop JWT.
