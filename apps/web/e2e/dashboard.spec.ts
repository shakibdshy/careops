import { expect, test, type Page } from '@playwright/test';

const RUN_ID = Date.now().toString(36);
const password = 'correct-horse-battery-staple';
let seq = 0;

/**
 * W2-T7 /dashboard: the three TanStack Charts reports (volume line, status
 * breakdown bar, provider utilization bar) plus today's schedule, rendered from
 * React Query reads against the org-scoped report endpoints. Each test signs up
 * its own owner and books a small in-window clinic week through the real API so
 * the aggregates are non-trivial, then checks the charts in light AND dark.
 */
async function bootstrap(page: Page) {
  seq += 1;
  const email = `pw-dash-${RUN_ID}-${seq}@example.test`;
  const name = `Dash ${RUN_ID}-${seq}`;
  const signUp = await page.request.post('/api/auth/sign-up/email', {
    data: { name, email, password },
  });
  expect(signUp.ok()).toBeTruthy();

  const created = await page.request.post('/api/patients', {
    data: { firstName: 'Ada', lastName: `Lovelace-${RUN_ID}`, dateOfBirth: '1990-01-01' },
  });
  expect(created.ok()).toBeTruthy();
  const patient = (await created.json()) as { id: string };

  const orgRes = await page.request.get('/api/organizations/current');
  expect(orgRes.ok()).toBeTruthy();
  const org = (await orgRes.json()) as { members: Array<{ id: string; name: string }> };
  const provider = org.members[0];
  expect(provider).toBeDefined();

  return { patientId: patient.id, providerId: provider!.id, providerName: provider!.name };
}

const CHAINS: Record<string, string[]> = {
  COMPLETED: ['CHECKED_IN', 'COMPLETED'],
  CANCELLED: ['CANCELLED'],
  NO_SHOW: ['NO_SHOW'],
  CHECKED_IN: ['CHECKED_IN'],
  SCHEDULED: [],
};

/** Book a trailing-week fixture set (UTC) and walk each to its target status. */
async function seedWeek(page: Page, ids: { patientId: string; providerId: string }) {
  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const fixtures: Array<[number, number, string]> = [
    [-3, 9, 'COMPLETED'],
    [-2, 9, 'COMPLETED'],
    [-2, 11, 'CANCELLED'],
    [-1, 9, 'COMPLETED'],
    [-1, 14, 'NO_SHOW'],
    [0, 9, 'CHECKED_IN'],
    [0, 14, 'SCHEDULED'],
  ];
  for (const [dayOffset, hour, target] of fixtures) {
    const start = new Date(midnight.getTime() + dayOffset * 86_400_000 + hour * 3_600_000);
    const booked = await page.request.post('/api/appointments', {
      data: {
        patientId: ids.patientId,
        memberId: ids.providerId,
        start: start.toISOString(),
        durationMinutes: 30,
      },
    });
    expect(booked.ok()).toBeTruthy();
    const appointment = (await booked.json()) as { id: string };
    for (const status of CHAINS[target]!) {
      const moved = await page.request.post(`/api/appointments/${appointment.id}/status`, {
        data: { status },
      });
      expect(moved.ok()).toBeTruthy();
    }
  }
}

test('dashboard renders volume, status and utilization charts plus today’s schedule', async ({
  page,
}, testInfo) => {
  const ids = await bootstrap(page);
  await seedWeek(page, ids);

  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Volume trend: a line mark (stroked path) over the temporal axis.
  const volume = page.getByTestId('chart-volume');
  await expect(volume).toBeVisible();
  await expect(volume.locator('svg path[stroke]').first()).toBeVisible();

  // Status breakdown: horizontal bars + the operational rates strip.
  const status = page.getByTestId('chart-status');
  await expect(status).toBeVisible();
  await expect(status.locator('svg rect').first()).toBeVisible();
  await expect(status).toContainText('Completed');
  await expect(status).toContainText('7'); // total bookings in the window
  await expect(status).toContainText('14.3%'); // 1/7 cancelled and no-show

  // Provider utilization: a bar per Provider, name resolved server-side.
  const utilization = page.getByTestId('chart-utilization');
  await expect(utilization).toBeVisible();
  await expect(utilization.locator('svg rect').first()).toBeVisible();
  await expect(utilization).toContainText(ids.providerName);

  // Today's schedule: the two bookings seeded for the current UTC day.
  const today = page.getByTestId('today-schedule');
  await expect(today).toBeVisible();
  await expect(today.getByTestId('today-row')).toHaveCount(2);
  await expect(today).toContainText('Checked in');

  // Charts must adapt to the OS color scheme: the same bars resolve to different
  // paints in light vs dark because fills come from the --chart-N tokens.
  const barFills = (scope: Page) =>
    scope
      .getByTestId('chart-status')
      .locator('svg rect')
      .evaluateAll((els) => els.map((el) => getComputedStyle(el).fill).join('|'));

  const lightFills = await barFills(page);
  await page.screenshot({ path: testInfo.outputPath('dashboard-light.png'), fullPage: true });

  // Emulate dark on a fresh page BEFORE navigation: flipping the scheme mid-life
  // leaves Chromium's cached utility styles stale (light cards on a dark page).
  const darkPage = await page.context().newPage();
  await darkPage.emulateMedia({ colorScheme: 'dark' });
  await darkPage.goto('/dashboard');
  await expect(darkPage.getByTestId('chart-volume')).toBeVisible();
  await expect(darkPage.getByTestId('chart-status').locator('svg rect').first()).toBeVisible();
  const darkFills = await barFills(darkPage);
  await darkPage.screenshot({ path: testInfo.outputPath('dashboard-dark.png'), fullPage: true });
  await darkPage.close();

  expect(lightFills).not.toBe(darkFills);
});

test('dashboard is reachable from the workspace nav and gates unauthenticated visitors', async ({
  page,
}) => {
  // Unauthenticated: the workspace gate redirects to login, never renders charts.
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/login/);

  const ids = await bootstrap(page);
  await seedWeek(page, ids);
  await page.goto('/workspace');
  await page.getByTestId('nav-dashboard').click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByTestId('chart-volume')).toBeVisible();
});
