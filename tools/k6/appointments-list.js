// k6 scenario (W2-T9): the cursor-paginated appointments list under fixed VU
// load. Each iteration fetches the first page, then follows nextCursor two pages
// deeper. First-page and deep-page latencies are recorded separately: ADR-0008's
// _id range scan should keep deep pages as cheap as the first (O(page), not
// O(depth)), which the {organizationId, _id} index serves.
//
// Run via tools/k6/run.mjs. The list is never cached, so there is no warm/cold
// distinction here — this measures the indexed query path under concurrency.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3011';
const EMAIL = __ENV.EMAIL || 'owner@demo.careops';
const PASSWORD = __ENV.PASSWORD || 'careops-demo-1';
const LIMIT = __ENV.LIMIT || '20';
const PAGES = Number(__ENV.PAGES || 3);
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '30s';
const RECEIPT = __ENV.RECEIPT_PATH;

const firstPage = new Trend('list_first_page', true);
const deepPage = new Trend('list_deep_page', true);
const firstPageN = new Counter('list_first_page_n');
const deepPageN = new Counter('list_deep_page_n');
const failures = new Counter('list_failures');

export const options = {
  scenarios: {
    list: { executor: 'constant-vus', vus: VUS, duration: DURATION },
  },
  thresholds: { list_failures: ['count==0'] },
};

export function setup() {
  const res = http.post(
    `${BASE}/api/auth/sign-in/email`,
    JSON.stringify({ email: EMAIL, password: PASSWORD }),
    { headers: { 'Content-Type': 'application/json' } },
  );
  if (res.status !== 200) {
    throw new Error(`sign-in failed (${res.status}): ${res.body}`);
  }
  const cookieHeader = Object.entries(res.cookies)
    .map(([name, cookies]) => `${name}=${cookies[0].value}`)
    .join('; ');
  return { cookieHeader };
}

export default function (data) {
  const headers = { Cookie: data.cookieHeader };
  let cursor = null;
  for (let page = 0; page < PAGES; page += 1) {
    const qs = cursor ? `?limit=${LIMIT}&cursor=${cursor}` : `?limit=${LIMIT}`;
    const res = http.get(`${BASE}/api/appointments${qs}`, {
      headers,
      tags: { page: page === 0 ? 'first' : 'deep' },
    });
    (page === 0 ? firstPage : deepPage).add(res.timings.duration);
    (page === 0 ? firstPageN : deepPageN).add(1);
    if (res.status !== 200) {
      failures.add(1);
      break;
    }
    check(res, { 'list 200': (r) => r.status === 200 });
    const body = res.json();
    cursor = body.nextCursor;
    if (!cursor || !body.hasMore) break;
  }
  sleep(0.2);
}

function trendStats(data, name) {
  const v = (data.metrics[name] && data.metrics[name].values) || {};
  const n = data.metrics[`${name}_n`];
  const round = (n2) => (typeof n2 === 'number' ? Math.round(n2 * 100) / 100 : null);
  return {
    count: n ? n.values.count : null,
    avg: round(v.avg),
    med: round(v.med),
    p90: round(v['p(90)']),
    p95: round(v['p(95)']),
    max: round(v.max),
  };
}

export function handleSummary(data) {
  const receipt = {
    scenario: 'appointments-list',
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    vus: VUS,
    duration: DURATION,
    limit: Number(LIMIT),
    pagesPerIteration: PAGES,
    iterations: data.metrics.iterations ? data.metrics.iterations.values.count : null,
    failures: data.metrics.list_failures ? data.metrics.list_failures.values.count : 0,
    firstPage: trendStats(data, 'list_first_page'),
    deepPage: trendStats(data, 'list_deep_page'),
  };
  const lines = [
    `appointments-list vus=${VUS} dur=${DURATION} limit=${LIMIT} pages=${PAGES} iters=${receipt.iterations} failures=${receipt.failures}`,
    `  first page  p95=${receipt.firstPage.p95}ms  med=${receipt.firstPage.med}ms  n=${receipt.firstPage.count}`,
    `  deep pages  p95=${receipt.deepPage.p95}ms  med=${receipt.deepPage.med}ms  n=${receipt.deepPage.count}`,
  ];
  const out = { stdout: lines.join('\n') + '\n' };
  if (RECEIPT) out[RECEIPT] = JSON.stringify(receipt, null, 2) + '\n';
  return out;
}
