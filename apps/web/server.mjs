// Production SSR server for the TanStack Start web app (W3-T4).
//
// `vite build` emits two bundles: dist/server/server.js (a Web-fetch handler
// with zero runtime dependencies) and dist/client (hashed static assets the
// handler does NOT serve itself — verified empirically). This process mounts
// the handler on node:http and serves the client assets beside it, the same
// split an ALB+CloudFront origin expects:
//
//   /assets/*  static, immutable cache (what CloudFront's cache behavior picks up)
//   /healthz   plain 200 for the ALB target-group health check
//   /*         the SSR handler; HTML responses get Cache-Control: no-store
//              (belt-and-braces with the CloudFront caching-disabled behavior,
//              and the edge-cache proof's assertion target)
//
//   node server.mjs   (PORT env, default 3000)

import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import handler from './dist/server/server.js';

const PORT = Number(process.env.PORT ?? 3000);
// Trailing separator stripped so the traversal guard's CLIENT_DIR + sep check
// works (fileURLToPath of a directory URL keeps the slash).
const CLIENT_DIR = fileURLToPath(new URL('./dist/client/', import.meta.url)).replace(/[\\/]+$/, '');

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const IMMUTABLE = 'public, max-age=31536000, immutable';

function sendFile(res, filePath, cacheControl = IMMUTABLE) {
  const type = MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': statSync(filePath).size,
    // Only /assets/* is content-hashed; anything else (favicon) gets a short cache.
    'Cache-Control': cacheControl,
  });
  createReadStream(filePath).pipe(res);
}

function staticFile(urlPath) {
  // Only the hashed asset namespace is served from disk; everything else is a
  // route for the SSR handler. Resolve-and-prefix-check blocks traversal.
  if (!(urlPath.startsWith('/assets/') || urlPath === '/favicon.ico')) return null;
  const resolved = resolve(CLIENT_DIR, `.${urlPath}`);
  if (!resolved.startsWith(CLIENT_DIR + sep) || !existsSync(resolved)) return null;
  if (!statSync(resolved).isFile()) return null;
  return resolved;
}

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    const urlPath = req.url.split('?')[0];
    const file = req.method === 'GET' || req.method === 'HEAD' ? staticFile(urlPath) : null;
    if (file) {
      sendFile(res, file, urlPath.startsWith('/assets/') ? IMMUTABLE : 'public, max-age=86400');
      return;
    }

    const url = `http://localhost:${PORT}${req.url}`;
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : req,
      duplex: 'half',
    });
    const response = await handler.fetch(request);

    // Multi-value headers matter: Set-Cookie must survive as separate cookies,
    // so single-valued headers are copied one-by-one and Set-Cookie is
    // re-attached as an array (Object.fromEntries would comma-join them).
    const headers = {};
    for (const [key, value] of response.headers) {
      if (key !== 'set-cookie') headers[key] = value;
    }
    // SSR/dynamic must never be cacheable — by the edge, a proxy, or anyone.
    if ((headers['content-type'] ?? '').includes('text/html')) {
      headers['cache-control'] = 'no-store';
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
  } catch (error) {
    const message = `web server error: ${error instanceof Error ? error.message : String(error)}`;
    if (res.headersSent) {
      // Mid-stream failure: the status line is already out; cut the socket so
      // the client sees a truncated response rather than a corrupted 200.
      res.destroy();
      return;
    }
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(message);
  }
});

server.listen(PORT, () => {
  console.log(`web SSR listening on :${PORT} (assets: ${CLIENT_DIR})`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    // Fargate drains: stop accepting, let in-flight requests finish.
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
