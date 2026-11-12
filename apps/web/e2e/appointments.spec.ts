import { expect, test, type Page } from '@playwright/test';

const RUN_ID = Date.now().toString(36);
const password = 'correct-horse-battery-staple';
let seq = 0;

/**
 * W2-T6 /appointments happy paths (ADR-0009): ZodForm booking with Pacer-debounced
 * pickers, a 409 Conflict surfaced on the start field, TanStack Table rows, and
 * DB-driven optimistic transitions that roll back with the server reason on 409.
 * Each test signs up its own owner (fresh organization) so slots never collide
 * across tests.
 */
async function bootstrap(page: Page) {
  seq += 1;
  const email = `pw-appt-${RUN_ID}-${seq}@example.test`;
  const signUp = await page.request.post('/api/auth/sign-up/email', {
    data: { name: `Appt ${RUN_ID}`, email, password },
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

  await page.goto('/appointments');
  await page.waitForLoadState('networkidle');
  return { patientId: patient.id, providerId: provider!.id, patientName: `Ada Lovelace-${RUN_ID}` };
}

async function selectPicker(page: Page, testId: string, optionId: string) {
  await page.getByTestId(testId).click();
  await page.getByTestId(`picker-option-${optionId}`).click();
}

async function book(
  page: Page,
  ids: { patientId: string; providerId: string },
  start: string,
  duration = '30',
) {
  await selectPicker(page, 'booking-patient', ids.patientId);
  await selectPicker(page, 'booking-provider', ids.providerId);
  await page.getByTestId('booking-start').fill(start);
  await page.getByTestId('booking-duration').fill(duration);
  await page.getByTestId('book-appointment').click();
}

async function appointmentIds(page: Page): Promise<string[]> {
  const res = await page.request.get('/api/appointments?limit=100');
  const body = (await res.json()) as { items: Array<{ id: string }> };
  return body.items.map((item) => item.id);
}

test('book → duplicate slot → 409 at the field → adjust → booked, new row in the Table', async ({
  page,
}) => {
  const ids = await bootstrap(page);

  await book(page, ids, '2030-01-01T10:00');
  await expect(page.getByTestId('appointment-row')).toHaveCount(1);
  await expect(page.getByTestId('appointments-list')).toContainText(ids.patientName);

  // Same Provider + overlapping slot: the API rejects with a field-level 409.
  await book(page, ids, '2030-01-01T10:00');
  await expect(page.getByTestId('field-error-start')).toContainText(
    'Conflicts with an appointment',
  );
  await expect(page.getByTestId('zod-form-error')).toContainText('Provider already booked');

  // Adjust the start (form values survive the 409) and book again.
  await page.getByTestId('booking-start').fill('2030-01-01T11:00');
  await page.getByTestId('book-appointment').click();
  await expect(page.getByTestId('appointment-row')).toHaveCount(2);
});

test('status action updates the row instantly, then a forced 409 rolls back with the reason', async ({
  page,
}) => {
  const ids = await bootstrap(page);
  await book(page, ids, '2030-02-01T10:00');
  await expect(page.getByTestId('appointment-row')).toHaveCount(1);
  const [appointmentId] = await appointmentIds(page);
  expect(appointmentId).toBeDefined();

  // Hold the transition POST open; fulfill a 409 only once released.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/appointments/${appointmentId}/status`, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    await gate;
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        statusCode: 409,
        message: 'Illegal transition',
        errors: [{ field: 'status', message: 'Allowed transitions from SCHEDULED: CONFIRMED' }],
      }),
    });
  });

  await page.getByTestId(`transition-${appointmentId}-CONFIRMED`).click();
  // Optimistic window: the badge flips before the (still-gated) API answers.
  await expect(page.getByTestId(`status-${appointmentId}`)).toHaveText('Confirmed');

  release();
  // Rollback: the badge reverts and the server reason is visible on the row.
  await expect(page.getByTestId(`status-${appointmentId}`)).toHaveText('Scheduled');
  await expect(page.getByTestId(`transition-error-${appointmentId}`)).toContainText(
    'Illegal transition',
  );
});

test('only legal transitions are offered; terminal appointments offer none', async ({ page }) => {
  const ids = await bootstrap(page);
  await book(page, ids, '2030-03-01T10:00');
  await expect(page.getByTestId('appointment-row')).toHaveCount(1);
  const [appointmentId] = await appointmentIds(page);
  expect(appointmentId).toBeDefined();
  const id = appointmentId!;

  // SCHEDULED may move to CONFIRMED, CHECKED_IN, CANCELLED, NO_SHOW — nothing else.
  for (const target of ['CONFIRMED', 'CHECKED_IN', 'CANCELLED', 'NO_SHOW']) {
    await expect(page.getByTestId(`transition-${id}-${target}`)).toBeVisible();
  }
  await expect(page.getByTestId(`transition-${id}-IN_PROGRESS`)).toHaveCount(0);
  await expect(page.getByTestId(`transition-${id}-COMPLETED`)).toHaveCount(0);
  await expect(page.getByTestId(`reschedule-${id}`)).toBeVisible();

  // Cancel → terminal: no transitions and no reschedule are offered.
  await page.getByTestId(`transition-${id}-CANCELLED`).click();
  await expect(page.getByTestId(`status-${id}`)).toHaveText('Cancelled');
  await expect(page.getByTestId(`transition-${id}-CONFIRMED`)).toHaveCount(0);
  await expect(page.getByTestId(`reschedule-${id}`)).toHaveCount(0);
  await expect(page.getByText('Terminal')).toBeVisible();
});

test('reschedule changes start and duration via ZodForm and persists', async ({ page }) => {
  const ids = await bootstrap(page);
  await book(page, ids, '2030-04-01T10:00', '30');
  await expect(page.getByTestId('appointment-row')).toHaveCount(1);
  const [appointmentId] = await appointmentIds(page);
  expect(appointmentId).toBeDefined();
  const id = appointmentId!;

  await page.getByTestId(`reschedule-${id}`).click();
  await expect(page.getByTestId('reschedule-dialog')).toBeVisible();
  await page.getByTestId('reschedule-start').fill('2030-04-01T12:00');
  await page.getByTestId('reschedule-duration').fill('45');
  await page.getByTestId('save-reschedule').click();
  await expect(page.getByTestId('reschedule-dialog')).toHaveCount(0);

  // Server truth: the reschedule persisted.
  const res = await page.request.get(`/api/appointments/${id}`);
  const appointment = (await res.json()) as { start: string; durationMinutes: number };
  expect(appointment.start).toBe('2030-04-01T12:00:00.000Z');
  expect(appointment.durationMinutes).toBe(45);
});

test('reschedule into an overlapping slot surfaces a 409 and keeps the original booking', async ({
  page,
}) => {
  const ids = await bootstrap(page);
  await book(page, ids, '2030-05-01T10:00', '30');
  await expect(page.getByTestId('appointment-row')).toHaveCount(1);
  await book(page, ids, '2030-05-01T11:00', '30');
  await expect(page.getByTestId('appointment-row')).toHaveCount(2);

  const all = await appointmentIds(page);
  // Newest first: [second (11:00), first (10:00)].
  const firstId = all[1]!;

  await page.getByTestId(`reschedule-${firstId}`).click();
  await expect(page.getByTestId('reschedule-dialog')).toBeVisible();
  await page.getByTestId('reschedule-start').fill('2030-05-01T11:00');
  await page.getByTestId('save-reschedule').click();

  // The Conflict check rejects the overlap; the dialog stays open with the reason.
  await expect(page.getByTestId('field-error-start')).toContainText(
    'Conflicts with an appointment',
  );
  await expect(page.getByTestId('reschedule-dialog')).toBeVisible();

  const res = await page.request.get(`/api/appointments/${firstId}`);
  const appointment = (await res.json()) as { start: string };
  expect(appointment.start).toBe('2030-05-01T10:00:00.000Z');
});
