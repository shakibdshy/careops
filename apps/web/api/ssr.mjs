// Vercel adapter for the TanStack Start web app: ONE catch-all function in
// the ALB's place (ADR-0016's origin shape, serverless edition).
//
//   /api/*          proxied to the backend at API_PROXY_TARGET (the Render
//                   Go service) — same-origin for the browser, so BetterAuth's
//                   cookies stay first-party and no CORS exists
//   everything else the SSR handler (dist/server/server.js, a Web-fetch
//                   handler with zero runtime dependencies — the same bundle
//                   server.mjs mounts on node:http for the AWS tier)
//
// Static /assets/* never reaches this function: vercel.json serves it from
// the build output with immutable caching, and rewrites apply only after the
// filesystem misses — the same split server.mjs models.
//
//   API_PROXY_TARGET=https://<go-service>.onrender.com
//
// This file must stay import-clean: the local verification harness
// (tools/prove-vercel-adapter.mjs) imports it and drives the same two paths
// against the real stack before any deploy.

import handler from '../dist/server/server.js';

const API_PROXY_TARGET = process.env.API_PROXY_TARGET?.replace(/\/+$/, '') ?? '';

export default async function ssr(request) {
  const url = new URL(request.url);

  if (API_PROXY_TARGET && url.pathname.startsWith('/api/')) {
    // Hop-by-hop and framing headers must not cross the proxy: undici (this
    // fetch) and the backend each compute their own.
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('connection');
    headers.delete('content-length');
    headers.delete('transfer-encoding');
    headers.delete('keep-alive');
    headers.delete('accept-encoding');
    return fetch(`${API_PROXY_TARGET}${url.pathname}${url.search}`, {
      method: request.method,
      headers,
      redirect: 'manual',
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
      duplex: 'half',
    });
  }

  const response = await handler.fetch(request);

  // SSR/dynamic must never be cacheable — by the CDN, a proxy, or anyone
  // (the smoke check asserts this on the deployed origin). Rebuilt so the
  // cookie multiplicity (Set-Cookie as separate headers) survives: append
  // each cookie explicitly instead of comma-joining them.
  if ((response.headers.get('content-type') ?? '').includes('text/html')) {
    const headers = new Headers(response.headers);
    headers.delete('set-cookie');
    headers.set('cache-control', 'no-store');
    for (const cookie of response.headers.getSetCookie()) {
      headers.append('set-cookie', cookie);
    }
    return new Response(response.body, { status: response.status, headers });
  }
  return response;
}
