import { expect, test } from '@playwright/test';

test('probe redirect', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('response', (r) => {
    if (r.url().includes('/api/workspace/me')) {
      console.log('ME:', r.status());
    }
  });
  await page.goto('http://localhost:3000/patients');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(3000);
  console.log('URL:', page.url());
  await expect(page).toHaveURL(/\/login/, { timeout: 5000 });
  await context.close();
});
