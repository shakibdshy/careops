# AWS deployment: stateless Fargate API and SSR web behind one ALB, Atlas, ElastiCache

CareOps deploys entirely to AWS as two stateless ECS Fargate tiers behind one Application
Load Balancer — the NestJS API (`/api/*`) and the TanStack Start SSR web app (`/*`) — with
**no sticky sessions** and target-tracking auto-scaling on both, fronted by CloudFront for
TLS and static-asset caching. MongoDB Atlas is the database (the only service outside AWS);
ElastiCache for Redis is the shared cache/queue store. Infrastructure is AWS CDK (TypeScript)
in-repo; GitHub Actions deploys via OIDC; Floci emulates the whole AWS stack locally. This
topology follows from the statelessness established in Week 2 — sessions in Mongo (ADR-0007),
cache and queue in Redis (ADR-0011), Organization re-derived per request (ADR-0006) — and
confirmed by the 1→2→4 replica ramp (~526 → 861 → 987 reads/s, zero failures, no stickiness).

## Considered Options

- **API compute — EC2 / Lambda / App Runner vs Fargate.** Fargate: no cluster, AMI, or
  capacity ops (vs EC2); a long-lived NestJS process with a BullMQ worker and warm
  Mongo/Redis pools, no cold starts or execution ceiling (vs Lambda); full ALB,
  auto-scaling, and VPC networking control (vs App Runner).
- **Database — DocumentDB / self-managed Mongo on EC2 vs Atlas.** DocumentDB rejected:
  ADR-0010's booking path needs real multi-document transactions on a replica set with the
  driver's transient-retry semantics; DocumentDB is a Mongo-compatible reimplementation
  with transaction and feature gaps that would diverge from the `mongo:8` dev/e2e topology
  and mongoose 9 / driver 7. Self-managed rejected: replica-set ops, backups, and patching
  are undifferentiated heavy lifting. Atlas is real Mongo, matches dev/e2e, and is managed.
- **Frontend — Vercel / static SPA on S3+CloudFront / Amplify vs a second Fargate service
  behind the shared ALB.** The web app is TanStack Start **SSR** (a Node server bundle plus
  client assets), not a static SPA, so S3+CloudFront alone cannot host it without dropping to
  client-only rendering. Chosen: containerize the SSR server and run it as a second Fargate
  service behind the same ALB, path-routed (`/api/*` → API, `/*` → web), fronted by CloudFront
  — one vendor, one VPC, one CDK stack, one pipeline, and frontend↔API same-origin by
  construction. Vercel rejected: excellent zero-ops SSR hosting with per-PR previews, but a
  second vendor/bill, cross-origin to the AWS API (needing a rewrite or CORS plus cross-site
  cookies), off-AWS egress, and not emulatable in Floci. Amplify/Lambda-edge SSR rejected:
  framework-specific SSR adapters are a poorer fit for a custom TanStack Start Node server
  than a plain container.
- **IaC — Terraform/OpenTofu / SST / raw CloudFormation vs CDK (TypeScript).** CDK: same
  language and toolchain as the apps, type-safe constructs, lives in the monorepo and
  synthesizes to CloudFormation. Terraform/OpenTofu add HCL and a separate state backend;
  SST is higher-level but opinionated and a poorer fit for a custom ALB/ECS/Atlas topology.
- **Local AWS — LocalStack vs Floci.** Floci: free, MIT, no account/keys/feature gates, a
  drop-in LocalStack replacement at `localhost:4566`, and it emulates the exact services
  this stack uses (ECS, ELBv2/ALB, CloudFront, ECR, ElastiCache, Secrets Manager, SSM,
  CloudWatch, IAM/STS, Application Auto Scaling, CloudFormation) with real Docker for
  ECS/ElastiCache — so the whole two-service stack, web tier included, runs locally.

## Consequences

- **No sticky sessions, by construction.** Any replica serves any request; the ALB spreads
  load and auto-scaling adds/removes replicas on CPU or request count. This is safe only
  because both tiers are stateless (ADR-0006/0007/0011) — the web SSR server holds no session
  state, auth is the API's Mongo-backed cookie. A future in-memory session or per-process
  cache would break it.
- **Only Atlas sits outside AWS.** One external vendor/bill and one cross-network hop
  (Fargate → Atlas), reached over a public endpoint with an IP allowlist or via VPC
  peering/PrivateLink. Everything else — compute, load balancer, edge, cache, queue, registry,
  secrets, observability — lives in one AWS account and VPC.
- **Same-origin by construction.** One CloudFront/ALB domain serves both `/*` (web) and
  `/api/*` (API), so BetterAuth cookies and CSRF work unchanged — no rewrite, no CORS, no
  `SameSite=None; Secure` cross-site cookie.
- **You own SSR container ops and the edge cache policy.** The cost of all-AWS instead of
  Vercel: a second container tier to build, scale, and pay for; web scale-out cold starts; and
  CloudFront must cache only hashed static assets while forwarding cookies and never caching
  dynamic/SSR/API responses. Fargate egress to Atlas/ECR needs VPC endpoints and/or NAT.
- **Floci emulates the entire stack except Atlas.** Local runs keep Mongo on the existing
  compose replica set (ADR-0010); Floci validates the CDK stack and all AWS wiring (both
  Fargate services, ALB path routing, CloudFront, auto-scaling, secrets, ECR) without an AWS
  bill. It is operation-level, not a fidelity guarantee, and never substitutes for a real
  staging deploy or the k6 scaling measurement.
- **CDK is AWS-only.** The IaC does not port to another cloud; with only Atlas off-AWS this is
  now a near-single-vendor deployment, so single-cloud IaC lock-in is an accepted trade for
  monorepo fit.
- **Secrets never live in the image or repo.** The Mongo URI, Redis URL, BetterAuth secret,
  and SMTP creds are injected from Secrets Manager/SSM at task runtime; GitHub Actions
  authenticates to AWS via OIDC, with no long-lived keys.
