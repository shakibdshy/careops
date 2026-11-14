import { defineConfig } from '@playwright/test';

const API_PORT = 3001;
const WEB_PORT = 3000;

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
      command: `cd ../api && bun run dev`,
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      command: 'bun run dev',
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
  ],
});
