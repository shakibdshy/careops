import { defineConfig } from '@playwright/test';

const API_PORT = Number(process.env.API_PORT ?? 3001);
// Overridable so the suite can dodge an already-occupied dev port (a second
// project squatting on :3000 must not be reused by mistake).
const WEB_PORT = Number(process.env.WEB_PORT ?? 3000);
// Point the web proxy at the Go replica for the badge's Go-origin run.
const API_PROXY_TARGET = process.env.API_PROXY_TARGET;
// How the API webServer boots. Dev uses the watch task; CI passes
// API_START_COMMAND to run the already-built dist directly (watch mode is
// too slow for a 90s webServer timeout). The command inherits the runner's
// environment — CI exports the API's MONGODB_URI/secret there.
const API_START_COMMAND = process.env.API_START_COMMAND ?? `bun run dev`;

/**
 * Browser tests run against the real stack: API (webServer) and the web app.
 * Playwright starts both, waits for health, runs the specs, tears down.
 */
export default defineConfig({
  testDir: './e2e',
  // The deployed-origin proof targets production artifacts (SSR no-store +
  // ALB-shaped origin) and runs via tools/prove-origin.mjs against
  // playwright.origin.config.ts — not the dev servers booted here.
  testIgnore: /origin\.spec\.ts/,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `cd ../api && ${API_START_COMMAND}`,
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      command: `bunx vite dev --port ${WEB_PORT} --strictPort`,
      ...(API_PROXY_TARGET ? { env: { API_PROXY_TARGET } } : {}),
      port: WEB_PORT,
      reuseExistingServer: false,
      timeout: 90_000,
    },
  ],
});
