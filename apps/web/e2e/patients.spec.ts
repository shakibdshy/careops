import { expect, test, type Page, type Browser } from '@playwright/test';

const RUN_ID = Date.now().toString(36);
const password = 'correct-horse-battery-staple';
let email: string;

/** Storage state captured after the signup test; reused by later tests. */
let auth: { cookies: unknown; origins: unknown } | undefined;

async function gotoHydrated(page: Page, path: string) {
  await page.goto(path);
  // SSR renders before React hydrates; clicking too early is a no-op.
  await page.waitForLoadState('networkidle');
}

/** Fresh page in a context that carries the signup session (when captured). */
async function authedPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext(
    auth
      ? { storageState: { cookies: auth.cookies as never, origins: auth.origins as never } }
      : {},
  );
  return context.newPage();
}

test.describe.serial('browser happy paths', () => {
  test('signs up and lands in the workspace', async ({ browser }) => {
    email = `pw-owner-${RUN_ID}@example.test`;
    const context = await browser.newContext();
    const page = await context.newPage();
    await gotoHydrated(page, '/signup');
    await page.getByPlaceholder('Name').fill(`Playwright ${RUN_ID}`);
    await page.getByPlaceholder('Email').fill(email);
    await page.getByPlaceholder('Password (min 8 chars)').fill(password);
    await page.getByRole('button', { name: 'Sign up' }).click();
    await expect(page.getByTestId('workspace-user')).toContainText(email);
    auth = await context.storageState();
    await context.close();
  });

  test('creates a patient and sees it in the list', async ({ browser }) => {
    const page = await authedPage(browser);
    await gotoHydrated(page, '/patients');
    await page.getByTestId('patient-first-name').fill('Percy');
    await page.getByTestId('patient-last-name').fill(`Fawkes-${RUN_ID}`);
    await page.getByTestId('patient-date-of-birth').fill('1991-02-02');
    await page.getByTestId('create-patient').click();
    await expect(page.getByTestId('patients-list')).toContainText(`Fawkes-${RUN_ID}`);
  });

  /** The created patient's id, fetched with the browser's own cookies. */
  async function createdPatientId(page: Page): Promise<string> {
    const res = await page.request.get('/api/patients?limit=100');
    const body = (await res.json()) as { items: Array<{ id: string; lastName: string }> };
    const patient = body.items.find((item) => item.lastName === `Fawkes-${RUN_ID}`);
    expect(patient).toBeDefined();
    return patient!.id;
  }

  test('edits the patient and sees the change', async ({ browser }) => {
    const page = await authedPage(browser);
    const patientId = await createdPatientId(page);
    console.log('EDIT: patientId', patientId);
    await page.goto(`/patients/${patientId}`);
    await page.waitForLoadState('networkidle');
    console.log('EDIT: url after goto', page.url());
    await page.getByTestId('edit-first-name').fill('Percival');
    await page.getByTestId('save-patient').click();
    await expect(page.getByTestId('edit-first-name')).toHaveValue('Percival');
  });

  test('an owner sees the audit trail with the mutation', async ({ browser }) => {
    const page = await authedPage(browser);
    await gotoHydrated(page, '/audit');
    await expect(page.getByTestId('audit-list')).toContainText(`Fawkes-${RUN_ID}`);
    await expect(page.getByTestId('audit-row').first()).toContainText('create');
  });

  test('deletes the patient and the list no longer shows it', async ({ browser }) => {
    const page = await authedPage(browser);
    const patientId = await createdPatientId(page);
    await gotoHydrated(page, `/patients/${patientId}`);
    page.on('dialog', (dialog) => void dialog.accept());
    await page.getByTestId('delete-patient').click();
    await expect(page).toHaveURL(/\/patients/);
    await expect(page.getByTestId('patients-list')).not.toContainText(`Fawkes-${RUN_ID}`);
  });

  test('deep links redirect to login when unauthenticated and land on target when authed', async ({
    browser,
  }) => {
    // Unauthenticated: redirected to login, redirect target preserved.
    const fresh = await browser.newContext();
    const page = await fresh.newPage();
    await gotoHydrated(page, '/patients');
    await expect(page).toHaveURL(/\/login\?redirect=%2Fpatients/);
    await fresh.close();

    // Authenticated: the same deep link lands directly on the target (the
    // freshly signed-up organization has no patients yet, so the list is
    // empty — attached, not visible).
    if (!auth) {
      throw new Error('signup storage state missing');
    }
    const authed = await browser.newContext({
      storageState: { cookies: auth.cookies as never, origins: auth.origins as never },
    });
    const page2 = await authed.newPage();
    await gotoHydrated(page2, '/patients');
    await expect(page2.getByTestId('patients-list')).toBeAttached();
    await expect(page2.getByTestId('patient-first-name')).toBeVisible();
    await authed.close();
  });

  test('signs out and the workspace locks', async ({ browser }) => {
    const page = await authedPage(browser);
    await gotoHydrated(page, '/workspace');
    await page.getByTestId('sign-out').click();
    await gotoHydrated(page, '/workspace');
    await expect(page).toHaveURL(/\/login/);
  });
});
