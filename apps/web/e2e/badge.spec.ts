// The serving-backend badge (Go-T10). Runs against whatever origin ORIGIN_URL
// names — the default Playwright run exercises the NestJS stack on :3000;
// the Go origin runs the same spec through the origin config after booting
// the web app with API_PROXY_TARGET=http://localhost:3102 (see the runbook).
import { expect, test } from '@playwright/test';

const IMPLEMENTATION_LABEL: Record<string, string> = {
  nestjs: 'NestJS · MongoDB',
  go: 'Go · PostgreSQL',
};

const EXPECTED = process.env.EXPECT_IMPLEMENTATION ?? 'nestjs';

test('the landing page shows which backend is serving', async ({ page }) => {
  await page.goto('/');
  const badge = page.getByTestId('health-badge');
  await expect(badge).toBeVisible();
  await expect(badge).toContainText(IMPLEMENTATION_LABEL[EXPECTED] ?? EXPECTED);
});
