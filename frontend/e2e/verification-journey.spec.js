import { test, expect } from '@playwright/test';

/**
 * The journey the Round 3 report promises: a new person registers, follows the
 * confirmation link, lands on the page that consumes the token, and is then
 * added to a project by the lead. The login screen offers seeded profiles only,
 * so registration is exercised through the API and the confirmation page
 * through the browser.
 */
test.describe.configure({ mode: 'serial' });

const EMAIL = `verify-journey-${Date.now()}@example.com`;
const PASSWORD = 'Threadline#2026';

test('register, confirm the link, then join a project', async ({ page, request }) => {
  await test.step('seed the demo workspace', async () => {
    const seeded = await request.post('/api/demo/seed');
    expect(seeded.ok()).toBeTruthy();
  });

  await test.step('register and open the confirmation link', async () => {
    const registered = await request.post('/api/auth/register', {
      data: { name: 'Nadia Confirmed', email: EMAIL, password: PASSWORD },
    });
    expect(registered.ok()).toBeTruthy();
    const { verificationUrl } = await registered.json();
    expect(verificationUrl).toContain('/verify-email?token=');

    await page.goto(verificationUrl);
    await expect(page.getByRole('heading', { name: 'Email confirmed' })).toBeVisible();
  });

  await test.step('continue from the confirmation page', async () => {
    await page.getByRole('button', { name: 'Continue to the workspace' }).click();
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: 'Choose a profile to enter' })).toBeVisible();
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
