import { defineConfig } from '@playwright/test';

/**
 * W3-T4 deployed-origin proof. Unlike playwright.config.ts (which boots dev
 * servers), this config expects the ORIGIN to already be up at ORIGIN_URL:
 * the web SSR + API containers behind an ALB-shaped proxy (or, on a real
 * deploy, the CloudFront/ALB domain itself). The proof targets production
 * artifacts — the same images that ship to Fargate.
 *
 *   bun tools/prove-origin.mjs   # boots the harness, then runs this config
 */
const PORT = Number(process.env.ORIGIN_PORT ?? 8080);

export default defineConfig({
  testDir: './e2e',
  testMatch: /origin\.spec\.ts/,
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  reporter: 'list',
});
