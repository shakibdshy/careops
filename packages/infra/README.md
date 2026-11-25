# CareOps infrastructure (AWS CDK)

In-repo CDK app (TypeScript) that deploys CareOps to AWS and to the [Floci](https://floci.io)
local emulator from the **same stack**. Architecture and trade-offs are recorded in
[ADR-0012](../docs/adr/0012-aws-deployment-architecture.md).

This workspace currently ships the **W3-T4 two-tier stack**: one stateless API Fargate replica
behind an internet-facing ALB (`/api/*` → API, stickiness off, health check `/api/health`),
ElastiCache Redis, an ECR repository, runtime secrets, and CloudWatch logs. Later Week-3
tickets add the SSR web tier behind the same ALB, CloudFront, and target-tracking auto-scaling.

`target` switches **only the data plane** (where Mongo/Redis live), never the topology:

| `target` | Mongo                                          | Redis                                        | Use                      |
| -------- | ---------------------------------------------- | -------------------------------------------- | ------------------------ |
| `floci`  | compose replica set via `host.docker.internal` | compose Redis via `host.docker.internal`     | local proof, no AWS bill |
| `aws`    | MongoDB Atlas (URI secret)                     | ElastiCache (derived from the cache cluster) | real deploy              |

## Layout

```text
infra/
├── bin/app.ts                 # entry: reads context/env, sets env-agnostic vs concrete env
├── lib/careops-stack.ts       # the stack (network, ECR, secrets, Redis, ECS, ALB, outputs)
├── test/careops-stack.test.ts # CDK template assertions (node:test + tsx)
├── scripts/floci-proof.mjs    # Floci operator steps: populate secrets, verify steady + health
├── cdk.json                   # app command + feature flags
└── cdk.context.json           # cached Floci AZ lookup (account 000000000000, us-east-1)
```

## Prerequisites

- [Bun](https://bun.sh) 1.4.3 and Node 24 (the repo toolchain).
- Docker — OrbStack or Docker Desktop. Floci runs ECS tasks and ElastiCache as **real Docker
  containers**, so it needs the Docker socket.
- Repo dependencies installed: `bun install` from the repo root.

All commands below run from `infra/`.

## Commands

| Command                              | What it does                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| `bun run synth`                      | `cdk synth` — emit the CloudFormation template (offline, no credentials)             |
| `bun run test`                       | CDK template assertions (routing, stickiness-off, health path, no plaintext secrets) |
| `bun run lint` / `bun run typecheck` | ESLint / `tsc --noEmit`                                                              |
| `bun run deploy`                     | `cdk deploy` (pass `-c` context, see below)                                          |
| `bun run diff`                       | `cdk diff` against the deployed stack                                                |
| `bun run destroy`                    | `cdk destroy`                                                                        |
| `bun run floci:secrets`              | populate the three runtime secrets in Floci                                          |
| `bun run floci:verify`               | wait for BOTH services (API + web SSR) to reach steady state, probe in-task health   |

### Context flags

`bin/app.ts` reads these from CDK context (`-c key=value`) or the matching `CAREOPS_*` env var:

| Flag              | Env fallback                | Default  | Meaning                                                                       |
| ----------------- | --------------------------- | -------- | ----------------------------------------------------------------------------- |
| `target`          | `CAREOPS_DEPLOY_TARGET`     | `aws`    | `aws` or `floci`                                                              |
| `desiredCount`    | `CAREOPS_DESIRED_COUNT`     | `1`      | API replica count                                                             |
| `minCapacity`     | `CAREOPS_MIN_CAPACITY`      | `1`      | Auto-scaling floor — the k6-ramp stage lever                                  |
| `maxCapacity`     | `CAREOPS_MAX_CAPACITY`      | `4`      | Auto-scaling ceiling for both target-tracking policies                        |
| `imageTag`        | `CAREOPS_IMAGE_TAG`         | `latest` | ECR image tag to deploy (API)                                                 |
| `webImageTag`     | `CAREOPS_WEB_IMAGE_TAG`     | `latest` | ECR image tag for the web SSR image                                           |
| `webDesiredCount` | `CAREOPS_WEB_DESIRED_COUNT` | floor    | Web SSR replica count (defaults to `webMinCapacity`)                          |
| `webMinCapacity`  | `CAREOPS_WEB_MIN_CAPACITY`  | `1`      | Web auto-scaling floor                                                        |
| `webMaxCapacity`  | `CAREOPS_WEB_MAX_CAPACITY`  | `4`      | Web auto-scaling ceiling                                                      |
| `domainName`      | `CAREOPS_DOMAIN_NAME`       | unset    | Custom domain for CloudFront (+ pins the API's same-origin auth config)       |
| `certificateArn`  | `CAREOPS_CERTIFICATE_ARN`   | unset    | ACM cert (us-east-1) for the CloudFront viewer certificate                    |
| `redisUrl`        | `CAREOPS_REDIS_URL`         | derived  | override the Redis URL (defaults: ElastiCache for `aws`, compose for `floci`) |

`synth` and `test` are **env-agnostic**: with no `CDK_DEFAULT_ACCOUNT`/`CDK_DEFAULT_REGION` the
stack uses placeholder AZs and needs no credentials. A concrete env is set only when the CDK
CLI resolves credentials, so `cdk deploy` uses the account's real AZs.

### Auto-scaling and the replica ramp (W3-T3)

The service scales on two target-tracking policies — **CPU at 60%** and
**ALBRequestCountPerTarget at 500 requests/target** — within
`minCapacity`/`maxCapacity` bounds. Stickiness stays off (asserted by the
template tests), so any replica serves any request.

Once auto-scaling is registered, the scalable target owns the service's desired
count. **Raising `minCapacity` pins the floor** for a stage: scale-in stops at
min, so a stage holds exactly N replicas under load. The k6 ramp redeploys per
stage and measures each:

```sh
cdk deploy -c target=aws -c minCapacity=1 && bun tools/k6/ramp.mjs --stage 1
cdk deploy -c target=aws -c minCapacity=2 && bun tools/k6/ramp.mjs --stage 2
cdk deploy -c target=aws -c minCapacity=4 && bun tools/k6/ramp.mjs --stage 4
bun tools/k6/ramp.mjs --report   # validates: throughput rises, zero failures
```

Each `--stage N` run first describes the ECS service and **fails if fewer than
N replicas are RUNNING** — the receipt records "N replicas, measured", never
"N replicas, configured". Point `BASE_URL` at the ALB DNS output. The same
runner works against Floci (`AWS_ENDPOINT_URL=http://localhost:4566`).

### Deployed-origin browser proof (W3-T4)

The web SSR tier ships as `apps/web/Dockerfile` + `apps/web/server.mjs`: the
Vite-built SSR handler plus hashed static assets under one Node process,
non-root, zero runtime dependencies. Locally, the full origin contract is
proven against the PRODUCTION containers behind an ALB-shaped proxy:

```sh
bun tools/prove-origin.mjs   # boots api+web images + alb-sim, runs Playwright
```

It proves same-origin sign-in (cookie first-party, no CORS), booking through
the UI, dashboard in light + dark, and the never-cacheable contract
(`Cache-Control: no-store` on every SSR response; content follows the
session). On a real deploy the same proof runs unchanged against the
CloudFront domain: `ORIGIN_URL=https://<domain> bunx playwright test -c playwright.origin.config.ts`.

## Deploy to Floci (local, no AWS account)

This is the verified local proof. Floci emulates ECS/ELBv2/ECR/ElastiCache/Secrets Manager/
CloudFormation at `http://localhost:4566`; Mongo/Redis/SMTP stay on the existing compose data
plane. ADR-0012 scopes Floci as **operation-level validation, not a fidelity guarantee** — see
the caveats below.

### 1. Start Floci on a user-defined Docker network

Floci must run on a **user-defined network**, not the default bridge. Floci spawns its own ECR
registry container and reaches it by container name (`floci-aws-ecr-registry:5000`); name DNS
only resolves on a user-defined network. On the default bridge the registry is unreachable and
image pushes fail.

```sh
docker network create floci-net
docker run -d --name floci --network floci-net -p 4566:4566 \
  -v /var/run/docker.sock:/var/run/docker.sock -u root floci/floci:latest
```

Floci defaults to in-memory storage, so its state is wiped when the container is **recreated**
(`docker run` again). A `docker start` of a stopped container resumes it **with** its previous
state — if a deploy then says a resource "already exists", destroy the stale stack first
(`bunx cdk destroy CareOpsStack --force`, and delete a leftover ECR repo if the registry
container survived). Re-run the deploy steps either way.

### 2. Start the compose data plane

From the repo root:

```sh
bun run boot:infra   # docker compose up -d: mongo (rs0), redis, mailpit
```

These publish on host loopback (`127.0.0.1:27017/6379/1025`). Floci tasks run on `floci-net`,
not the compose network, so they reach the data plane through the host gateway
`host.docker.internal` (OrbStack/Docker Desktop). The stack bakes this as the `floci` Redis
default, and `floci:secrets` writes the Mongo/SMTP URLs with the same host.

### 3. Build both images

From the repo root (the Dockerfiles build the workspace, so the context is the root):

```sh
docker build -f apps/api/Dockerfile -t careops-api:local .
docker build -f apps/web/Dockerfile -t careops-web:local .
```

### 4. Point the toolchain at Floci

```sh
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1
export CDK_DEFAULT_ACCOUNT=000000000000
export CDK_DEFAULT_REGION=us-east-1
```

### 5. Bootstrap, then deploy the infrastructure at zero replicas

Bootstrap once per account/region (creates the `CDKToolkit` stack). Deploy with `desiredCount=0`
first: this creates the ECR repository and the empty secrets **without** launching tasks that
would fail before the image and secret values exist.

```sh
bunx cdk bootstrap aws://000000000000/us-east-1
bunx cdk deploy CareOpsStack -c target=floci -c desiredCount=0 -c minCapacity=0 -c webDesiredCount=0 -c webMinCapacity=0 -c imageTag=local -c webImageTag=local --require-approval never
```

`-c minCapacity=0` matters: the auto-scaling bounds enforce `min ≤ desired ≤ max`
(the deploy fails otherwise), and parking the floor at 0 keeps target tracking
from launching tasks before the image and secret values exist.

### 6. Push the image to Floci's ECR

Floci's pushable registry endpoint is the `*.localhost:4566` proxy (resolves to `127.0.0.1`),
**not** the `amazonaws.com` URI in the CloudFormation output. Credentials are `AWS` / `floci`.
The endpoint is plain HTTP, so Docker must allow it as an insecure registry — OrbStack permits
`127.0.0.0/8` by default; on Docker Desktop add `000000000000.dkr.ecr.us-east-1.localhost:4566`
to `insecure-registries`.

```sh
docker login -u AWS -p floci 000000000000.dkr.ecr.us-east-1.localhost:4566
for img in careops-api careops-web; do
  docker tag $img:local 000000000000.dkr.ecr.us-east-1.localhost:4566/$img:local
  docker push 000000000000.dkr.ecr.us-east-1.localhost:4566/$img:local
done
```

### 7. Populate the runtime secrets

```sh
bun run floci:secrets
```

Writes `careops/mongodb-uri` (compose Mongo via `host.docker.internal`, `directConnection=true`),
`careops/smtp-url` (compose Mailpit), and a freshly generated `careops/better-auth-secret`. The
script logs only each secret's name, version, and length — never its value.

### 8. Scale to one replica per tier and verify

```sh
bunx cdk deploy CareOpsStack -c target=floci -c desiredCount=1 -c minCapacity=1 -c webDesiredCount=1 -c webMinCapacity=1 -c imageTag=local -c webImageTag=local --require-approval never
bun run floci:verify
```

`floci:verify` waits for the service to reach steady state (`running == desired`, one deployment,
`rolloutState=COMPLETED`) and then probes `/api/health` **inside the task container**. Expected:

```text
steady: desired=1 running=1 rollout=COMPLETED
health: {"status":"ok","service":"careops-api","mongo":"up","redis":"up"}
Floci proof OK: one API replica steady with green /api/health on compose Mongo/Redis.
```

### Floci fidelity caveats

- **The ALB is metadata-only.** Floci's ELBv2 records the load balancer/listener/target-group but
  does not proxy HTTP to tasks, so the ALB DNS output does not serve traffic locally. Routing is
  proven by the template assertions and by a real AWS deploy; local health is probed in-task.
- **CloudFront is metadata-only.** Floci accepts the `AWS::CloudFront::Distribution` resource and
  records its config (behaviors, origin, certificate) but does not serve edge traffic. The
  deployed-origin browser proof runs locally against the PRODUCTION containers behind an ALB-shaped
  proxy (`bun tools/prove-origin.mjs`); the true edge run happens on the real AWS deploy.
- **ECS health is `UNKNOWN`.** Floci does not wire the container `healthCheck` into ECS task
  health, so `floci:verify` probes the API directly rather than reading ECS health status.
- These are emulator limits, not stack defects (ADR-0012). Floci never substitutes for a real
  staging deploy or the k6 scaling measurement.

## Deploy to AWS (credential-gated)

The same stack targets real AWS. **This path requires resources only the operator can provide**
— an AWS account/credentials, a MongoDB Atlas cluster, and (for TLS) an ACM certificate — so it
is documented here, not executed by CI. Mongo is the only service outside AWS; Redis is
ElastiCache, derived automatically.

### 1. Prerequisites

- AWS credentials for the target account (the CDK CLI resolves `CDK_DEFAULT_ACCOUNT`/`REGION`).
- A MongoDB Atlas cluster (replica set, for ADR-0010 transactions) with a database user and a
  network path from the VPC — public endpoint + IP allowlist, or VPC peering/PrivateLink.
- An ACM certificate **in us-east-1** for the app domain + the domain name itself (optional; the
  distribution then serves the CloudFront default domain with TLS either way). Deploy with
  `-c certificateArn=… -c domainName=app.example.com` — this also pins the API's
  `BETTER_AUTH_URL`/`BETTER_AUTH_TRUSTED_ORIGINS` to `https://app.example.com` so same-origin
  cookie auth works on the deployed origin.
  Without `domainName`, the edge serves the default `*.cloudfront.net` domain and NO auth origin
  is pinned (the domain is only knowable after creation) — sign-in through the edge will be
  rejected. Default-domain mode is for tracer-bullet checks; a real app deploy sets cert + domain.
- Docker, to build and push both images (API + web).

### 2. Bootstrap and deploy at zero replicas

```sh
bunx cdk bootstrap aws://<ACCOUNT>/<REGION>
bunx cdk deploy CareOpsStack -c target=aws -c desiredCount=0 -c minCapacity=0 -c webDesiredCount=0 -c webMinCapacity=0 -c imageTag=latest -c webImageTag=latest --require-approval never
```

Note the `AppUrl` (the CloudFront domain — the app entry), `EcrRepositoryUri`, `WebEcrRepositoryUri`, and secret ARNs in the outputs.

### 3. Build and push the image to real ECR

```sh
docker build -f apps/api/Dockerfile -t careops-api:latest .
docker build -f apps/web/Dockerfile -t careops-web:latest .
aws ecr get-login-password --region <REGION> \
  | docker login --username AWS --password-stdin <ACCOUNT>.dkr.ecr.<REGION>.amazonaws.com
docker tag careops-api:latest <EcrRepositoryUri>:latest
docker tag careops-web:latest <WebEcrRepositoryUri>:latest
docker push <EcrRepositoryUri>:latest
docker push <WebEcrRepositoryUri>:latest
```

### 4. Populate the runtime secrets

Secrets are created empty and populated out-of-band — no credential ever lands in the template
or repo. `REDIS_URL` is **not** a secret: the stack derives it from the ElastiCache cluster.

```sh
aws secretsmanager put-secret-value --secret-id careops/mongodb-uri \
  --secret-string 'mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/careops?retryWrites=true&w=majority'
aws secretsmanager put-secret-value --secret-id careops/better-auth-secret \
  --secret-string "$(openssl rand -hex 32)"
aws secretsmanager put-secret-value --secret-id careops/smtp-url \
  --secret-string 'smtp://<user>:<pass>@<smtp-host>:587'
```

### 5. Scale up (with TLS) and verify

```sh
bunx cdk deploy CareOpsStack -c target=aws -c desiredCount=1 -c minCapacity=1 \
  -c webDesiredCount=1 -c webMinCapacity=1 -c imageTag=latest -c webImageTag=latest \
  -c certificateArn=<ACM_ARN> -c domainName=<DOMAIN> --require-approval never
curl <AppUrl>/api/health   # via the edge (AppUrl output)
```

Expected: `{"status":"ok","service":"careops-api","mongo":"up","redis":"up"}` — `mongo: up`
confirms Atlas reachability, `redis: up` confirms ElastiCache. TLS terminates at CloudFront
(the ALB is an HTTP-only origin, ADR-0012).

## OIDC pipeline (W3-T5)

`.github/workflows/deploy.yml` ships by merge: on every push to `main` it runs
the repo gates (the reusable `ci.yml`), builds + pushes **both** images to ECR
tagged with the commit sha, runs `cdk deploy`, and smoke-checks the live origin
with `tools/smoke.mjs`. AWS auth is **GitHub OIDC only** — the workflow assumes
a deploy role with a short-lived token; there are no static AWS keys in the
repo, its secrets, or this documentation. PRs get the gates + an env-agnostic
`cdk synth` and never deploy.

### One-time operator setup

Run the idempotent bootstrap script with ANY valid AWS credential once (aws CLI
login, SSO, or env keys) — it creates the GitHub OIDC identity provider, the
`careops-github-deploy` role scoped to this repo's main branch, and the inline
deploy policy, then prints the role ARN:

```sh
AWS_REGION=us-east-1 node infra/scripts/bootstrap-oidc.mjs --set   # --set writes the GitHub variables via gh
```

Every deploy after this one is **keyless**. What the script does manually,
for reference:

1. **OIDC identity provider** (once per AWS account):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Principal": {
           "Federated": "arn:aws:iam::<ACCOUNT>:oidc-provider/token.actions.githubusercontent.com"
         },
         "Action": "sts:AssumeRoleWithWebIdentity",
         "Condition": {
           "StringEquals": {
             "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
             "token.actions.githubusercontent.com:sub": [
               "repo:shakibdshy/careops:ref:refs/heads/main",
               "repo:shakibdshy/careops:environment:production"
             ]
           }
         }
       }
     ]
   }
   ```

   Attach the permissions the stack needs (ECR push, CloudFormation, ECS/EC2/
   ELBv2/CloudFront/ElastiCache/Secrets Manager/Logs/Application Auto Scaling,
   `iam:PassRole` for the task execution + task roles, S3 + DynamoDB for the
   CDK bootstrap assets). The least-privilege set grows with the stack; scope
   by resource where practical. Optional hardening: give the deploy job a
   GitHub `environment: production` (deployment-protection rules, wait
   timers) and add the matching `repo:…:environment:production` subject here.

2. **Repository variables** (the script's `--set` writes the first two; the
   optional cert/domain pair is operator-provided):

   | Variable              | Example                         | Required | Meaning                                                  |
   | --------------------- | ------------------------------- | -------- | -------------------------------------------------------- |
   | `AWS_REGION`          | `us-east-1`                     | yes      | Deploy region                                            |
   | `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<ACCOUNT>:role/…` | yes      | Role the workflow assumes via OIDC                       |
   | `ACM_CERT_ARN`        | `arn:aws:acm:us-east-1:…`       | no       | Viewer certificate (must be in us-east-1)                |
   | `DOMAIN_NAME`         | `app.example.com`               | no       | Custom domain; with the cert, also pins same-origin auth |

   Without `ACM_CERT_ARN` + `DOMAIN_NAME` the deploy serves the CloudFront
   default domain and same-origin sign-in is rejected (see "Deploy to AWS",
   prerequisite 2). Set both for a real app deploy.

### Rollback

Images are immutable per sha and never pruned by the pipeline. To roll back,
run **Deploy** manually (workflow_dispatch) with `skip_build=true` and
`image_tag=<previous sha>` — the workflow skips build/push, redeploys the old
tag, and the smoke gate must pass. There is no automatic rollback on smoke
failure: the smoke gate fails loudly instead (a failing health check usually
means the data plane, not the image, needs attention).

## Secrets

The task definition references secrets by ARN (`Secrets`/`ValueFrom`), never plaintext
(`Environment`). The three secrets — Mongo URI, BetterAuth secret, SMTP URL — are created as
empty shells and populated after deploy (Floci: `floci:secrets`; AWS: the operator). The
assertion tests fail the build if any credential appears as a plaintext environment variable or
an inline secret value in the template.

## Assertion tests

`bun run test` synthesizes the stack offline and asserts the deploy contract:

- `/api/*` (priority 10) forwards to the API target group; the default action forwards
  everything else (`/*`) to the web SSR target group — same-origin on one listener.
- Target-group stickiness is disabled; health check is `/api/health` on the API port.
- Credentials resolve from Secrets Manager at runtime; no plaintext secret in the task
  definition and no inline secret value in the template.
- `desiredCount` is parameterized; the ALB is internet-facing; HTTP-only by default, HTTPS +
  redirect when a certificate is supplied.
- ECR, ElastiCache Redis, and a CloudWatch log group are provisioned; `aws` derives `REDIS_URL`
  from ElastiCache while `floci` uses compose Redis; tasks run in private subnets with a
  deployment circuit breaker.

## Teardown

```sh
bunx cdk destroy CareOpsStack -c target=floci   # or target=aws
```

The ECR repository (`emptyOnDelete`) and log group are destroyed with the stack. Floci's
in-memory state also clears when the container stops.
