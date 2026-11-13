// ALB-shaped reverse proxy for local origin proofs (W3-T4): /* -> web, /api/* -> API.
// Deliberately spawned as a separate NODE process (not imported into bun
// harnesses): bun's node:http shim handles request piping differently and
// hangs proxied POSTs — this must behave like the ALB, not like a runtime
// experiment. See tools/prove-origin.mjs.
//
//   node tools/alb-sim.mjs   # env: ORIGIN_PORT (8080), API_PORT (3001), WEB_PORT (3000)

import { createServer, request as httpRequest } from 'node:http';

const ORIGIN_PORT = Number(process.env.ORIGIN_PORT ?? 8080);
const API_PORT = Number(process.env.API_PORT ?? 3001);
const WEB_PORT = Number(process.env.WEB_PORT ?? 3000);

const server = createServer((req, res) => {
  const port = req.url?.startsWith('/api/') ? API_PORT : WEB_PORT;
  const upstream = httpRequest(
    { host: '127.0.0.1', port, path: req.url, method: req.method, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on('error', (error) => {
    if (!res.headersSent) {
      res.writeHead(502);
      res.end(String(error));
    } else {
      res.end();
    }
  });
  if (req.method === 'GET' || req.method === 'HEAD') upstream.end();
  else req.pipe(upstream);
});

server.listen(ORIGIN_PORT, () => {
  console.log(`alb-sim on :${ORIGIN_PORT} (/* -> web :${WEB_PORT}, /api/* -> api :${API_PORT})`);
});
