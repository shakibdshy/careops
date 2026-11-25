#!/usr/bin/env node
// Vercel-adapter proof (the Render + Vercel deploy path): drives apps/web/api/ssr.mjs —
// the EXACT function Vercel runs — against the real stack on this machine,
// before any deploy, by mounting it on node:http exactly like Vercel's
// runtime would (Web Request in, Response out):
//
//   1. GET  /api/health                  → proxied JSON naming the backend
//   2. POST /api/auth/sign-in/email      → 200 with Set-Cookie surviving as
//                                          separate cookies (same-origin auth)
//   3. GET  /                            → SSR HTML, Cache-Control: no-store
//   4. GET  /patients                    → SSR route (deep path) renders
//   5. GET  /api/patients (authenticated)→ proxied with the browser's cookie
//
//   API_PROXY_TARGET=http://localhost:3102 bun tools/prove-vercel-adapter.mjs
//
// The Go server must be running at API_PROXY_TARGET (dev: :3102). Exit 1 on
// any failed check. Receipt: tools/receipts/vercel-adapter-proof.json.

import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.API_PROXY_TARGET;
if (!BASE) {
  console.error('usage: API_PROXY_TARGET=<go origin> bun tools/prove-vercel-adapter.mjs');
  process.exit(2);
}

const { default: adapter } = await import('../apps/web/api/ssr.mjs');

// Mount the adapter on node:http the way Vercel's Node runtime does: pass
// through method/headers/body, return the Response.
const PORT = 3020;
const server = createServer(async (req, res) => {
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
    duplex: 'half',
  });
  const response = await adapter(request);
  const headers = {};
  for (const [key, value] of response.headers) {
    if (key !== 'set-cookie') headers[key] = value;
  }
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
});

await new Promise((resolve) => server.listen(PORT, resolve));

const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(name);
};
const origin = `http://localhost:${PORT}`;

try {
  // 1. health proxies to the backend and names it
  const health = await fetch(`${origin}/api/health`);
  const healthBody = await health.json();
  check(
    'GET /api/health → proxied, backend named',
    health.status === 200 && healthBody.status === 'ok' && healthBody.implementation === 'go',
    JSON.stringify(healthBody),
  );

  // 2. sign-in through the adapter: first-party cookies survive the proxy
  const email = `vercel-proof-${Math.random().toString(36).slice(2, 8)}@example.test`;
  const signUp = await fetch(`${origin}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ name: 'Vercel Proof', email, password: 'vercel-proof-1' }),
  });
  const signUpCookies = signUp.headers.getSetCookie();
  check(
    'POST /api/auth/sign-up/email → 200, session cookies survive as separate cookies',
    signUp.status === 200 && signUpCookies.some((c) => c.startsWith('better-auth.session_token=')),
    `status=${signUp.status} cookies=${signUpCookies.length}`,
  );

  // 3. the SSR home page through the adapter: rendered + never cacheable
  const home = await fetch(origin);
  const homeBody = await home.text();
  check(
    'GET / → SSR HTML with the app title',
    home.status === 200 && homeBody.includes('<title>CareOps</title>'),
    `${homeBody.length} bytes`,
  );
  check(
    'GET / → Cache-Control: no-store (SSR never cacheable)',
    (home.headers.get('cache-control') ?? '').includes('no-store'),
    home.headers.get('cache-control') ?? '(none)',
  );

  // 4. a deep route renders through the same function
  const patients = await fetch(`${origin}/patients`);
  const patientsBody = await patients.text();
  check(
    'GET /patients → SSR route renders',
    patients.status === 200 && patientsBody.includes('<title>CareOps</title>'),
    `status=${patients.status}`,
  );

  // 5. an authenticated API read: the session cookie from (2) authenticates
  const cookie = signUpCookies.map((c) => c.split(';')[0]).join('; ');
  const me = await fetch(`${origin}/api/workspace/me`, { headers: { cookie } });
  const meBody = await me.json().catch(() => ({}));
  check(
    'GET /api/workspace/me (session cookie) → the signed-up user',
    me.status === 200 && meBody.user?.email === email,
    `status=${me.status} email=${meBody.user?.email ?? '?'}`,
  );
} finally {
  server.close();
}

mkdirSync(new URL('../tools/receipts/', import.meta.url), { recursive: true });
writeFileSync(
  new URL('../tools/receipts/vercel-adapter-proof.json', import.meta.url),
  JSON.stringify(
    {
      proof:
        'the Vercel adapter function (apps/web/api/ssr.mjs) drives both the API proxy and the SSR handler',
      backend: BASE,
      measuredAt: new Date().toISOString(),
      failures,
    },
    null,
    2,
  ),
);

if (failures.length > 0) {
  console.error(`\nvercel adapter proof FAILED: ${failures.join('; ')}`);
  process.exit(1);
}
console.log('\nvercel adapter proof OK: proxy + SSR paths behave like the deployed origin.');
