# Host-based routing: one web image, two backends

The deployed topology serves **two hostnames from the same CloudFront/ALB
stack**: requests to the API path on the reference host route to the NestJS
service, on the Go host they route to the Go service, and everything else
goes to the single web service. One web image, one deployment, two live
links; each origin keeps the same-origin property that makes the auth
cookies and CSRF story work unchanged (ADR-0007, ADR-0012).

Routing is **host-based rather than path-based** (`/api/*` on one host vs the
other) because the web client is unchanged: it fetches same-origin `/api/*`
relative URLs (ADR-0009). A path split (`/api` vs `/go-api`) would need
client changes or a rewriting proxy for no benefit. The web app shows which
backend served it via a badge read from the health response's `implementation`
field, so a reviewer never has to guess.

## Considered Options

- **Path-based routing on one host** (`/api/*` → NestJS, `/gapi/*` → Go) —
  one hostname, but the web client would have to know which prefix to use,
  or a reverse proxy would rewrite — either way the "web app unchanged" claim
  dies. Also muddles the same-origin story with two API identities on one
  origin. Rejected.
- **Two separate deployments (separate stacks/origins)** — doubles the AWS
  footprint, the pipeline, and the drift surface for something one listener
  rule solves. Rejected.
- **Client-side backend switcher in the web app** — turns a deployment
  property into a UI feature, breaks the "unchanged client" claim, and
  invites cross-origin cookies. Rejected; the badge is the only UI addition.

## Consequences

- Both hostnames must be covered by the ACM certificate; without cert +
  domain, same-origin sign-in is rejected at the edge (already true for the
  single-host deploy — ADR-0012's prerequisite carries over).
- The ALB listener gains ordered rules: API-path-on-Go-host → Go target
  group; API-path (any other host) → NestJS target group; default → web.
- Health, smoke checks and rollback run per host — a deploy is only green
  when both backends are.
