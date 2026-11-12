import { expect, test } from '@playwright/test';

const RUN_ID = Date.now().toString(36);
const password = 'correct-horse-battery-staple';

/**
 * Proves the TanStack DB optimistic-edit contract (W2-T5 / ADR-0009): the
 * detail header reflects the edit before the API answers, and a forced 4xx
 * rolls the row back while ZodForm surfaces the server's reason on the field.
 * The PATCH is held open behind a gate so the optimistic window is observable.
 */
test('optimistic edit shows instantly, then rolls back with the server reason on 4xx', async ({
  page,
}) => {
  const email = `pw-optimistic-${RUN_ID}@example.test`;
  const signUp = await page.request.post('/api/auth/sign-up/email', {
    data: { name: `Optimistic ${RUN_ID}`, email, password },
  });
  expect(signUp.ok()).toBeTruthy();

  const created = await page.request.post('/api/patients', {
    data: { firstName: 'Opti', lastName: 'Prime', dateOfBirth: '1990-05-05' },
  });
  expect(created.ok()).toBeTruthy();
  const patient = (await created.json()) as { id: string };

  await page.goto(`/patients/${patient.id}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('patient-name')).toHaveText('Opti Prime');

  // Hold the PATCH open; fulfill it with a field-level 400 only once released.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/patients/${patient.id}`, async (route) => {
    if (route.request().method() !== 'PATCH') {
      await route.continue();
      return;
    }
    await gate;
    await route.fulfill({
      status: 400,
      contentType: 'application/json',
      body: JSON.stringify({
        statusCode: 400,
        message: 'Validation failed',
        errors: [{ field: 'firstName', message: 'is locked by policy' }],
      }),
    });
  });

  await page.getByTestId('edit-first-name').fill('Optimus');
  await page.getByTestId('save-patient').click();

  // Optimistic window: the header updates before the (still-gated) API answers.
  await expect(page.getByTestId('patient-name')).toHaveText('Optimus Prime');

  release();

  // Rollback: the row reverts, and the server reason lands on the form + field.
  await expect(page.getByTestId('patient-name')).toHaveText('Opti Prime');
  await expect(page.getByTestId('zod-form-error')).toContainText('Validation failed');
  await expect(page.getByTestId('field-error-firstName')).toContainText('is locked by policy');
  // The typed value survives so the user can correct and retry.
  await expect(page.getByTestId('edit-first-name')).toHaveValue('Optimus');
});
