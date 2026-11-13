// Deployed-origin proof harness (W3-T4). Boots the PRODUCTION containers (the
// same images that ship to Fargate) behind an ALB-shaped proxy on ONE origin,
// then runs the Playwright origin spec against it:
//
//   bun tools/prove-origin.mjs
//
//   careops-api:local  -> :3001   (env: compose Mongo/Redis/Mailpit via DNS)
//   careops-web:local  -> :3000   (SSR + static, no secrets)
//   alb-sim (host)     -> :8080   /* -> web, /api/* -> API — the ALB's contract
//
// Prerequisites: compose data plane (`docker compose up -d --wait`), images
// built (`docker build -f apps/api/Dockerfile -t careops-api:local .` and the
// web equivalent), Playwright chromium installed in apps/web.
//
// Edge-cache caveat: locally there is no CloudFront. The never-cacheable claim
// is proven app-side (Cache-Control: no-store + content-follows-session) plus
// the CDK template tests (CachingDisabled behaviors); the real edge test is
// part of the live AWS run. This script writes its verdict to
// tools/receipts/deployed-origin-proof.json.

import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ORIGIN_PORT = Number(process.env.ORIGIN_PORT ?? 8080);
const API_PORT = 3001;
const WEB_PORT = 3000;
const NETWORK = process.env.PROOF_NETWORK ?? 'careops_default';
const SECRET = randomBytes(32).toString('hex');
const RECEIPT = fileURLToPath(new URL('./receipts/deployed-origin-proof.json', import.meta.url));

const docker = (args, opts = {}) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', ...opts });
  if (result.status !== 0) {
    throw new Error(
      `docker ${args.join(' ')} failed: ${result.stderr?.trim() || result.stdout?.trim()}`,
    );
  }
  return result.stdout.trim();
};

const waitFor = async (url, label, deadlineMs = 90_000) => {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const res = await fetch(url).catch(() => null);
    if (res?.ok) {
      console.log(`  ready: ${label} at ${url}`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`${label} not reachable at ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

// ALB-shaped proxy: /api/* -> API, everything else -> web. Spawned as a
// separate NODE process (tools/alb-sim.mjs) — bun's node:http shim hangs
// proxied POSTs, and this proxy must behave like the ALB.
function startAlbSim() {
  const child = spawn('node', [fileURLToPath(new URL('./alb-sim.mjs', import.meta.url))], {
    env: {
      ...process.env,
      ORIGIN_PORT: String(ORIGIN_PORT),
      API_PORT: String(API_PORT),
      WEB_PORT: String(WEB_PORT),
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return new Promise((resolveSim, rejectSim) => {
    const deadline = Date.now() + 15_000;
    const probe = setInterval(async () => {
      const res = await fetch(`http://localhost:${ORIGIN_PORT}/healthz`).catch(() => null);
      // Anything at all (even a 502 from a not-yet-up web tier) proves the sim listens.
      if (res !== null) {
        clearInterval(probe);
        console.log(
          `  alb-sim on :${ORIGIN_PORT} (/* -> web :${WEB_PORT}, /api/* -> api :${API_PORT})`,
        );
        resolveSim(child);
      } else if (Date.now() > deadline) {
        clearInterval(probe);
        rejectSim(new Error('alb-sim did not start'));
      }
    }, 300);
  });
}

async function main() {
  if (!existsSync(fileURLToPath(new URL('../apps/web/dist/client', import.meta.url)))) {
    throw new Error('apps/web/dist missing — run `bun run build` first.');
  }
  for (const image of ['careops-api:local', 'careops-web:local']) {
    const check = spawnSync('docker', ['image', 'inspect', image], { encoding: 'utf8' });
    if (check.status !== 0) {
      throw new Error(`image ${image} missing — build it first (see header comment).`);
    }
  }

  console.log('origin proof: compose data plane + production containers + ALB-shaped proxy');
  docker(['rm', '-f', 'careops-proof-api', 'careops-proof-web']);
  docker([
    'run',
    '-d',
    '--name',
    'careops-proof-api',
    '--network',
    NETWORK,
    '-p',
    `127.0.0.1:${API_PORT}:3001`,
    '-e',
    'MONGODB_URI=mongodb://host.docker.internal:27017/careops?directConnection=true',
    '-e',
    'REDIS_URL=redis://host.docker.internal:6379',
    '-e',
    'SMTP_URL=smtp://host.docker.internal:1025',
    '-e',
    'MAIL_FROM=CareOps <no-reply@careops.local>',
    '-e',
    'NOTIFICATIONS_QUEUE_NAME=notifications',
    '-e',
    `BETTER_AUTH_SECRET=${SECRET}`,
    '-e',
    `BETTER_AUTH_URL=http://localhost:${ORIGIN_PORT}`,
    '-e',
    `BETTER_AUTH_TRUSTED_ORIGINS=http://localhost:${ORIGIN_PORT}`,
    'careops-api:local',
  ]);
  docker([
    'run',
    '-d',
    '--name',
    'careops-proof-web',
    '--network',
    NETWORK,
    '-p',
    `127.0.0.1:${WEB_PORT}:3000`,
    'careops-web:local',
  ]);

  const sim = await startAlbSim();
  try {
    await waitFor(`http://localhost:${ORIGIN_PORT}/api/health`, 'API via origin');
    await waitFor(`http://localhost:${ORIGIN_PORT}/healthz`, 'web via origin');

    const run = spawnSync('bunx', ['playwright', 'test', '-c', 'playwright.origin.config.ts'], {
      cwd: `${ROOT}/apps/web`,
      stdio: 'inherit',
      encoding: 'utf8',
    });

    const verdict = run.status === 0 ? 'PASS' : 'FAIL';
    writeFileSync(
      RECEIPT,
      JSON.stringify(
        {
          scenario: 'deployed-origin',
          generatedAt: new Date().toISOString(),
          origin: `http://localhost:${ORIGIN_PORT} (alb-sim: /* -> web, /api/* -> api)`,
          containers: { api: 'careops-api:local', web: 'careops-web:local' },
          specs: ['apps/web/e2e/origin.spec.ts'],
          verdict,
          note: 'Edge-cache policy (CachingDisabled on SSR/API behaviors) is asserted in the CDK template tests; the app-side no-store + content-follows-session contract is proven here.',
        },
        null,
        2,
      ) + '\n',
    );
    console.log(`\norigin proof ${verdict} — receipt -> ${RECEIPT}`);
    process.exitCode = run.status === 0 ? 0 : 1;
  } finally {
    sim.kill();
    spawnSync('docker', ['rm', '-f', 'careops-proof-api', 'careops-proof-web'], {
      stdio: 'ignore',
    });
  }
}

main().catch((error) => {
  console.error(`origin proof FAILED: ${error.message}`);
  spawnSync('docker', ['rm', '-f', 'careops-proof-api', 'careops-proof-web'], { stdio: 'ignore' });
  process.exitCode = 1;
});
