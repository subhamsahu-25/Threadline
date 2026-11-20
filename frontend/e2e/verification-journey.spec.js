import { test, expect } from '@playwright/test';

/**
 * The journey the Round 3 report promises: a new person registers, follows the
 * confirmation link from the mail, lands on the page that consumes the token,
 * and is then added to a project by the lead. With no mail transport the link
 * is returned to the registering caller, which is what the panel shows.
 */
test.describe.configure({ mode: 'serial' });

const EMAIL = `verify-journey-${Date.now()}@example.com`;
const PASSWORD = 'Threadline#2026';

test('register, confirm the link, then join a project', async ({ page, request }) => {
  await test.step('seed the demo workspace', async () => {
    const seeded = await request.post('/api/demo/seed');
    expect(seeded.ok()).toBeTruthy();
  });

  await test.step('register with email and password', async () => {
    await page.goto('/login');
    await page
      .getByText('Sign in or create an account with email instead')
      .click();
    await page.getByRole('tab', { name: 'Create account' }).click();
    await page.locator('#auth-name').fill('Nadia Confirmed');
    await page.locator('#auth-email').fill(EMAIL);
    await page.locator('#auth-password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Create account', exact: true }).click();

    await expect(page.getByText('Confirm your email address')).toBeVisible();
  });

  await test.step('open the confirmation link and land on the page', async () => {
    const link = page.getByTestId('verification-link');
    await expect(link).toBeVisible();
    await link.click();
    await expect(page).toHaveURL(/\/verify-email\?token=/);
    await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  });

  await test.step('sign in as the newly confirmed person, then leave', async () => {
    await page.getByRole('button', { name: 'Continue to the workspace' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await page.getByText('Sign in or create an account with email instead').click();
    await page.locator('#auth-email').fill(EMAIL);
    await page.locator('#auth-password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Nadia Confirmed').first()).toBeVisible();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page).toHaveURL(/\/login$/);
  });

  await test.step('return as the lead', async () => {
    await page
      .getByRole('button', { name: /Enter the Atlas workspace as Subham Sahu/i })
      .click();
    await page
      .locator('#main')
      .getByRole('link', { name: /Project Atlas - Billing Service Migration/i })
      .click();
  });

  await test.step('add the confirmed account to the project', async () => {
    await page.getByRole('link', { name: 'People' }).click();
    await page.getByRole('button', { name: 'Add member' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Email address').fill(EMAIL);
    await expect(dialog.getByText(/has confirmed/)).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole('button', { name: 'Add member' }).click();
    await expect(page.getByText(EMAIL)).toBeVisible();
  });
});
