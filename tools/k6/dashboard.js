// k6 scenario (W2-T9): the reporting dashboard's four read endpoints under a
// fixed VU load against the booted API. Two are cached cache-aside (daily-volume,
// provider-utilization); two are always live (status-breakdown, today) and act
// as a control — their p95 should be ~equal across the warm and cold runs.
//
// Run via tools/k6/run.mjs (it signs nothing itself; setup() signs in once and
// replays the session cookie). The runner sets CACHE_MODE and RECEIPT_PATH:
//
//   warm = cache settled (first requests populate, the rest hit Redis)
//   cold = the runner bumps reports:gen:{org} continuously, so every cached
//          read recomputes — the uncached aggregation path (ADR-0011)
//
// No invented SLA: the only threshold is zero failed requests. p95 is recorded,
// not asserted against a made-up target.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3011';
const EMAIL = __ENV.EMAIL || 'owner@demo.careops';
const PASSWORD = __ENV.PASSWORD || 'careops-demo-1';
const DAYS = __ENV.DAYS || '30';
const VUS = Number(__ENV.VUS || 10);
const DURATION = __ENV.DURATION || '30s';
const RECEIPT = __ENV.RECEIPT_PATH;
const CACHE_MODE = __ENV.CACHE_MODE || 'warm';

const volume = new Trend('report_daily_volume', true);
const utilization = new Trend('report_provider_utilization', true);
const breakdown = new Trend('report_status_breakdown', true);
const today = new Trend('report_today', true);
// k6 v2 Trends carry no sample count; a companion Counter records it (observed).
const volumeN = new Counter('report_daily_volume_n');
const utilizationN = new Counter('report_provider_utilization_n');
const breakdownN = new Counter('report_status_breakdown_n');
const todayN = new Counter('report_today_n');
const failures = new Counter('report_failures');

export const options = {
  scenarios: {
    dashboard: { executor: 'constant-vus', vus: VUS, duration: DURATION },
  },
  thresholds: { report_failures: ['count==0'] },
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

const ENDPOINTS = [
  ['daily-volume', volume, volumeN, `?days=${DAYS}`],
  ['provider-utilization', utilization, utilizationN, `?days=${DAYS}`],
  ['status-breakdown', breakdown, breakdownN, `?days=${DAYS}`],
  ['today', today, todayN, ''],
];

export default function (data) {
  const headers = { Cookie: data.cookieHeader };
  for (const [name, trend, counter, qs] of ENDPOINTS) {
    const res = http.get(`${BASE}/api/reports/${name}${qs}`, {
      headers,
      tags: { endpoint: name },
    });
    trend.add(res.timings.duration);
    counter.add(1);
    if (res.status !== 200) failures.add(1);
    check(res, { [`${name} 200`]: (r) => r.status === 200 });
  }
  sleep(0.2);
}

function trendStats(data, name) {
  const v = (data.metrics[name] && data.metrics[name].values) || {};
  const n = data.metrics[`${name}_n`];
  return {
    count: n ? n.values.count : null,
    avg: round(v.avg),
    med: round(v.med),
    p90: round(v['p(90)']),
    p95: round(v['p(95)']),
    max: round(v.max),
  };
}

function round(n) {
  return typeof n === 'number' ? Math.round(n * 100) / 100 : null;
}

export function handleSummary(data) {
  const receipt = {
    scenario: 'dashboard',
    generatedAt: new Date().toISOString(),
    baseUrl: BASE,
    cacheMode: CACHE_MODE,
    vus: VUS,
    duration: DURATION,
    days: Number(DAYS),
    iterations: data.metrics.iterations ? data.metrics.iterations.values.count : null,
    failures: data.metrics.report_failures ? data.metrics.report_failures.values.count : 0,
    httpReqDurationP95: round(
      data.metrics.http_req_duration && data.metrics.http_req_duration.values['p(95)'],
    ),
    endpoints: {
      'daily-volume': trendStats(data, 'report_daily_volume'),
      'provider-utilization': trendStats(data, 'report_provider_utilization'),
      'status-breakdown': trendStats(data, 'report_status_breakdown'),
      today: trendStats(data, 'report_today'),
    },
  };
  const lines = [
    `dashboard [${CACHE_MODE}] vus=${VUS} dur=${DURATION} days=${DAYS} iters=${receipt.iterations} failures=${receipt.failures}`,
  ];
  for (const [name, s] of Object.entries(receipt.endpoints)) {
    lines.push(
      `  ${name.padEnd(22)} p95=${String(s.p95).padStart(8)}ms  med=${String(s.med).padStart(7)}ms  n=${s.count}`,
    );
  }
  const out = { stdout: lines.join('\n') + '\n' };
  if (RECEIPT) out[RECEIPT] = JSON.stringify(receipt, null, 2) + '\n';
  return out;
}
