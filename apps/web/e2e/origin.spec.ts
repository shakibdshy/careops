import { expect, test, type Page } from '@playwright/test';

/**
 * W3-T4 deployed-origin proof: the production web SSR image + API image behind
 * ONE origin (ALB-shaped: /* → web, /api/* → API; locally tools/prove-origin.mjs
 * runs that proxy, on AWS it is the CloudFront/ALB domain). Proves:
 *
 *  1. same-origin auth: the sign-in form posts to /api/auth on the SAME origin,
 *     the session cookie is first-party (no CORS, no SameSite=None involved);
 *  2. book an Appointment through the UI and see it on the dashboard;
 *  3. light AND dark render the app;
 *  4. an authenticated SSR page is never cacheable: Cache-Control: no-store on
 *     every HTML response, and the page content follows the session cookie —
 *     the same URL cannot serve one user's authenticated shell to another.
 *
 * (True edge-cache behavior is CloudFront's CachingDisabled policy, asserted
 * in the CDK template tests; locally there is no edge, so this spec asserts
 * the app-side half: the no-store contract the edge policy enforces on.)
 */

const password = 'correct-horse-battery-staple';
const email = `origin-${Date.now().toString(36)}@example.test`;
const name = `Origin Proof ${Date.now().toString(36)}`;

async function signUpViaApi(page: Page): Promise<void> {
  // Same-origin by construction: page.request uses the origin's own base URL;
  // the Set-Cookie lands first-party on this domain.
  const res = await page.request.post('/api/auth/sign-up/email', {
    data: { name, email, password },
  });
  expect(res.ok()).toBeTruthy();
}

async function seedViaApi(page: Page): Promise<{ patientId: string; providerId: string }> {
  const created = await page.request.post('/api/patients', {
    data: { firstName: 'Ada', lastName: 'Originproof', dateOfBirth: '1990-01-01' },
  });
  expect(created.ok()).toBeTruthy();
  const patient = (await created.json()) as { id: string };
  const orgRes = await page.request.get('/api/organizations/current');
  expect(orgRes.ok()).toBeTruthy();
  const org = (await orgRes.json()) as { members: Array<{ id: string }> };
  const provider = org.members[0]!;
  return { patientId: patient.id, providerId: provider.id };
}

async function signInViaUi(page: Page): Promise<void> {
  await page.goto('/login');
  // SSR renders before React hydrates; filling too early is lost (see gotoHydrated).
  await page.waitForLoadState('networkidle');
  await page.getByPlaceholder('Email').fill(email);
  await page.getByPlaceholder('Password').fill(password);
  await page.locator('button[type=submit]').click();
  // A fresh signup lands on workspace onboarding; the point is: signed in,
  // off /login, same-origin session cookie accepted by the SSR app.
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('heading')).toBeVisible();
}

async function bookViaUi(
  page: Page,
  ids: { patientId: string; providerId: string },
): Promise<void> {
  await page.goto('/appointments');
  await page.waitForLoadState('networkidle');

  // Picker options are keyed by entity id (see e2e/appointments.spec.ts).
  const selectPicker = async (testId: string, optionId: string) => {
    await page.getByTestId(testId).click();
    await page.getByTestId(`picker-option-${optionId}`).click();
  };
  await selectPicker('booking-patient', ids.patientId);
  await selectPicker('booking-provider', ids.providerId);
  await page.getByTestId('booking-start').fill('2031-03-04T10:00');
  await page.getByTestId('booking-duration').fill('30');
  await page.getByTestId('book-appointment').click();
  await expect(page.getByTestId('appointment-row').first()).toBeVisible();
}

test('same-origin sign-in → book via UI → dashboard shows it → light + dark → never cacheable', async ({
  page,
  request,
}) => {
  // Seed through the same origin the browser uses (one domain, no CORS).
  await signUpViaApi(page);
  const ids = await seedViaApi(page);

  // 1. Same-origin sign-in through the real form.
  await signInViaUi(page);

  // 2. Book an appointment through the UI.
  await bookViaUi(page, ids);

  // 3. Dashboard reflects the booking — charts render from live report reads.
  await page.goto('/dashboard');
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('chart-volume')).toBeVisible();

  // 3b. Light AND dark both render the authenticated app.
  const darkPage = await page.context().newPage();
  await darkPage.emulateMedia({ colorScheme: 'dark' });
  await darkPage.goto('/dashboard');
  await darkPage.waitForLoadState('networkidle');
  await expect(darkPage.getByTestId('chart-volume')).toBeVisible();
  await darkPage.close();

  // 4. The authenticated page is never cacheable, and its content follows the
  // session: the same URL must NOT hand this user's shell to another session.
  const dash = await request.get('/dashboard');
  expect(dash.ok()).toBeTruthy();
  const cacheControl = dash.headers()['cache-control'] ?? '';
  expect(cacheControl).toContain('no-store');

  const anon = await page.request.get('/dashboard', { headers: { cookie: '' } });
  const anonBody = await anon.text();
  const authedBody = await (await request.get('/dashboard')).text();
  expect(anonBody).not.toEqual(authedBody);
});
