// Lighthouse receipt (W2-T9): captures the /dashboard scores against a booted
// web instance. /dashboard is auth-guarded client-side (useWorkspace redirects
// to /login on a 401), so a fresh browser would measure the login redirect, not
// the dashboard. This script signs in against the API, injects the session
// cookie into every Lighthouse request via --extra-headers, and ASSERTS the
// final displayed URL is still /dashboard — a redirected run fails loudly
// instead of recording a bogus score.
//
//   bun tools/lighthouse.mjs
//
// Prerequisites (see tools/README.md): the isolated API is booted (:3011) and a
// PRODUCTION web build is served (:3010) proxying /api to it:
//   bunx turbo run build --filter=@careops/web
//   API_PROXY_TARGET=http://localhost:3011 bunx vite preview --port 3010 --strictPort
// Dev-mode (vite dev) scores are unrepresentative (unminified ESM + HMR); measure
// the production preview. Chrome must be installed (CHROME_PATH overrides).
//
// Env: WEB_URL, BASE_URL, EMAIL, PASSWORD, CHROME_PATH, RECEIPTS_LIGHTHOUSE_CATEGORIES.

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_URL = (process.env.WEB_URL ?? 'http://localhost:3010').replace(/\/$/, '');
const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:3011').replace(/\/$/, '');
const EMAIL = process.env.EMAIL ?? 'owner@demo.careops';
const PASSWORD = process.env.PASSWORD ?? 'careops-demo-1';
const CHROME_PATH =
  process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CATEGORIES = (
  process.env.RECEIPTS_LIGHTHOUSE_CATEGORIES ?? 'performance,accessibility,best-practices,seo'
).split(',');

const receiptsDir = new URL('./receipts/', import.meta.url);
const lighthouseBin = fileURLToPath(new URL('./node_modules/.bin/lighthouse', import.meta.url));

const METRIC_AUDITS = [
  'first-contentful-paint',
  'largest-contentful-paint',
  'total-blocking-time',
  'cumulative-layout-shift',
  'speed-index',
  'interactive',
];

function runLighthouse(cookie, preset, outPath) {
  const args = [
    `${WEB_URL}/dashboard`,
    '--output=json',
    `--output-path=${outPath}`,
    '--only-categories=' + CATEGORIES.join(','),
    '--extra-headers=' + JSON.stringify({ Cookie: cookie }),
    '--chrome-flags=--headless=new --disable-dev-shm-usage',
    '--max-wait-for-load=45000',
    '--quiet',
  ];
  if (preset) args.push(`--preset=${preset}`);
  return new Promise((resolve, reject) => {
    const child = spawn(lighthouseBin, args, {
      env: { ...process.env, CHROME_PATH },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

function summarize(lhr, label) {
  const finalUrl = lhr.finalDisplayedUrl ?? lhr.finalUrl;
  if (!finalUrl || !finalUrl.includes('/dashboard')) {
    throw new Error(
      `${label}: Lighthouse ended at ${finalUrl} (expected /dashboard) — the session cookie did not authenticate the page.`,
    );
  }
  const scores = {};
  for (const [key, cat] of Object.entries(lhr.categories ?? {})) {
    scores[key] = cat.score === null ? null : Math.round(cat.score * 100);
  }
  const metrics = {};
  for (const id of METRIC_AUDITS) {
    const audit = lhr.audits?.[id];
    if (audit) {
      metrics[id] = {
        score: audit.score === null ? null : Math.round(audit.score * 100),
        numericValue: audit.numericValue ?? null,
        displayValue: audit.displayValue ?? null,
      };
    }
  }
  return {
    label,
    requestedUrl: lhr.requestedUrl,
    finalDisplayedUrl: finalUrl,
    fetchTime: lhr.fetchTime,
    lighthouseVersion: lhr.lighthouseVersion,
    formFactor: lhr.configSettings?.formFactor,
    throttlingMethod: lhr.configSettings?.throttlingMethod,
    throttling: lhr.configSettings?.throttling,
    screenEmulation: lhr.configSettings?.screenEmulation,
    scores,
    metrics,
  };
}

async function main() {
  const webHealth = await fetch(`${WEB_URL}/dashboard`).catch(() => null);
  if (!webHealth || !webHealth.ok) {
    throw new Error(
      `Web not reachable at ${WEB_URL}/dashboard — boot the production preview first.`,
    );
  }
  const apiHealth = await fetch(`${BASE_URL}/api/health`).catch(() => null);
  if (!apiHealth || !apiHealth.ok) {
    throw new Error(`API not reachable at ${BASE_URL}/api/health — boot the isolated API first.`);
  }

  const signin = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (signin.status !== 200) throw new Error(`sign-in failed (${signin.status})`);
  const cookie = signin.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  if (!cookie) throw new Error('sign-in returned no session cookie');

  mkdirSync(receiptsDir, { recursive: true });
  const runs = [
    { label: 'mobile (default)', preset: null, file: 'lighthouse-mobile.tmp.json' },
    { label: 'desktop', preset: 'desktop', file: 'lighthouse-desktop.tmp.json' },
  ];

  const results = [];
  let screenshotSaved = null;
  for (const run of runs) {
    const outPath = join(tmpdir(), `t9-${run.file}`);
    console.log(`\n=== Lighthouse ${run.label} → ${WEB_URL}/dashboard ===`);
    const code = await runLighthouse(cookie, run.preset, outPath);
    if (code !== 0) throw new Error(`Lighthouse ${run.label} failed (exit ${code})`);
    const lhr = JSON.parse(readFileSync(outPath, 'utf8'));
    const summary = summarize(lhr, run.label);
    results.push(summary);
    rmSync(outPath, { force: true });

    const shot = lhr.audits?.['final-screenshot']?.details?.data;
    if (shot && !screenshotSaved) {
      const base64 = shot.replace(/^data:image\/\w+;base64,/, '');
      const shotPath = new URL('./receipts/lighthouse-dashboard.jpg', import.meta.url);
      writeFileSync(shotPath, Buffer.from(base64, 'base64'));
      screenshotSaved = fileURLToPath(shotPath);
    }

    console.log(
      `  ${run.label}: ` +
        Object.entries(summary.scores)
          .map(([k, v]) => `${k}=${v}`)
          .join('  '),
    );
    console.log(`  final URL: ${summary.finalDisplayedUrl}`);
  }

  const receipt = {
    generatedAt: new Date().toISOString(),
    webUrl: WEB_URL,
    apiUrl: BASE_URL,
    target: '/dashboard (authenticated; session cookie injected via --extra-headers)',
    build: 'production (vite build + vite preview)',
    categories: CATEGORIES,
    runs: results,
    screenshot: screenshotSaved ? 'lighthouse-dashboard.jpg' : null,
  };
  const outPath = new URL('./receipts/lighthouse.json', import.meta.url);
  writeFileSync(outPath, JSON.stringify(receipt, null, 2) + '\n');
  console.log('\nWrote', fileURLToPath(outPath));
  if (screenshotSaved) console.log('Screenshot:', screenshotSaved);
}

main()
  .catch((error) => {
    console.error('lighthouse receipt failed:', error.message);
    process.exitCode = 1;
  })
  .then(() => process.exit(process.exitCode ?? 0));
