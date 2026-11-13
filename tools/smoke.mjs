// Post-deploy smoke check (W3-T5). Hits ONE origin — on AWS the CloudFront
// domain (AppUrl output), locally the alb-sim origin — and asserts the same
// contract the deploy promises: API health green through the edge, SSR HTML
// served and never cacheable, hashed assets immutable. Exit 1 on any failure.
//
//   BASE_URL=https://app.example.com bun tools/smoke.mjs
//   BASE_URL=http://localhost:8080 bun tools/smoke.mjs   # local origin proof
//
// This is a liveness gate, not a functional suite — the functional contract
// (sign-in/booking) is the Playwright origin proof (tools/prove-origin.mjs).

const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) {
  console.error('usage: BASE_URL=<origin> bun tools/smoke.mjs');
  process.exit(2);
}

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};

const get = async (path, init) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    redirect: 'manual',
    ...init,
  }).catch(() => null);
  return res;
};

console.log(`smoke: ${BASE_URL}`);

// 1. API health through the edge: the full data plane is green.
const health = await get('/api/health');
let healthBody = '';
try {
  healthBody = await health?.json();
} catch {
  healthBody = {};
}
check(
  'GET /api/health → 200 ok, mongo up, redis up',
  health?.status === 200 &&
    healthBody?.status === 'ok' &&
    healthBody?.mongo === 'up' &&
    healthBody?.redis === 'up',
  JSON.stringify(healthBody),
);

// 2. The web SSR tier serves HTML through the same origin, never cacheable.
const home = await get('/');
const homeBody = await home?.text();
check(
  'GET / → 200 text/html (SSR rendered)',
  home?.status === 200 && (homeBody ?? '').includes('<title>CareOps</title>'),
);
const homeCache = home?.headers.get('cache-control') ?? '';
check('GET / → Cache-Control: no-store', homeCache.includes('no-store'), homeCache);

// 3. A hashed asset referenced by the SSR shell is served with immutable cache.
const assetPath = homeBody?.match(/\/assets\/[^"']+\.js/)?.[0];
if (!assetPath) {
  failures.push('no /assets/*.js reference found in the SSR shell');
  console.log('  ✗ no /assets/*.js reference found in the SSR shell');
} else {
  const asset = await get(assetPath);
  const assetCache = asset?.headers.get('cache-control') ?? '';
  check(
    `GET ${assetPath} → 200 javascript, immutable cache`,
    asset?.status === 200 && (asset?.headers.get('content-type') ?? '').includes('javascript'),
    assetCache,
  );
  check('hashed asset is immutable (edge-cacheable)', assetCache.includes('immutable'), assetCache);
}

// 4. The API namespace stays the API's: /api/* never leaks to the web tier
//    (a web-served /api path would return HTML, not JSON).
const apiLeak = await get('/api/nonexistent-endpoint');
const apiLeakType = apiLeak?.headers.get('content-type') ?? '';
check(
  'GET /api/* stays on the API tier (JSON, not web HTML)',
  apiLeak !== null && (apiLeakType.includes('json') || apiLeakType.includes('text/plain')),
  apiLeakType,
);

// 5. An unauthenticated page request still never produces a cacheable HTML
//    body (the edge must never be able to pin one session's shell).
const dashboard = await get('/dashboard');
const dashBody = dashboard?.text ? await dashboard.text() : '';
const dashCache = dashboard?.headers.get('cache-control') ?? '';
check(
  'GET /dashboard (unauthenticated) → responds without a cacheable HTML body',
  dashboard !== null && (dashCache.includes('no-store') || dashboard.status >= 300),
  `status=${dashboard?.status} cache=${dashCache}`,
);
check(
  'unauthenticated /dashboard does not leak an authed shell (content differs from /)',
  !dashBody || dashBody !== homeBody,
);

if (failures.length > 0) {
  console.error(`\nsmoke FAILED: ${failures.length} check(s): ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nsmoke OK: origin healthy, SSR served, cache contract holds.');
