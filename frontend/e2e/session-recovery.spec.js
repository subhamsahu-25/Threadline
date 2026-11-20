import { test, expect } from '@playwright/test';

/**
 * Regression cover for the "Provide an Authorization: Bearer <token> header"
 * card that appeared on Revoke, Audit, Questions and Overview when the browser
 * held a signed-in user but no token reached the API.
 */
test.describe.configure({ mode: 'serial' });

async function enterAsLead(page) {
  await page.goto('/login');
  const resume = page.getByRole('button', { name: 'Continue' });
  if (await resume.isVisible().catch(() => false)) await resume.click();
  await page
    .getByRole('button', { name: /Enter the Atlas workspace as Subham Sahu/i })
    .click();
  await page
    .locator('#main')
    .getByRole('link', { name: /Project Atlas - Billing Service Migration/i })
    .click();
}

test('keeps the session alive when the browser refuses to store the token', async ({ page }) => {
  await test.step('seed the demo workspace', async () => {
    const seeded = await page.request.post('/api/demo/seed');
    expect(seeded.ok()).toBeTruthy();
  });

  await test.step('block token persistence, then sign in', async () => {
    await page.addInitScript(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(key, value) {
        if (key === 'threadline.token') throw new DOMException('blocked', 'SecurityError');
        return original.call(this, key, value);
      };
    });
    await enterAsLead(page);
  });

  await test.step('authenticated pages still load', async () => {
    await page.getByRole('link', { name: 'Audit' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
    await expect(page.getByText(/Provide an Authorization/)).toHaveCount(0);

    await page.getByRole('link', { name: 'Questions' }).click();
    await expect(page.getByText(/Provide an Authorization/)).toHaveCount(0);
  });
});

test('returns to the profile picker when the API rejects the session', async ({ page }) => {
  await test.step('seed and sign in', async () => {
    const seeded = await page.request.post('/api/demo/seed');
    expect(seeded.ok()).toBeTruthy();
    await enterAsLead(page);
  });

  await test.step('revoke the session behind the page', async () => {
    const token = await page.evaluate(() => localStorage.getItem('threadline.token'));
    expect(token).toBeTruthy();
    const revoked = await page.request.post('/api/auth/logout', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(revoked.ok()).toBeTruthy();
  });

  await test.step('the next page returns to the picker instead of the raw error', async () => {
    // A background refresh may already have hit the revoked session; if the
    // link is still there, the click itself must bounce back to the picker.
    await page
      .getByRole('link', { name: 'Audit' })
      .click({ timeout: 5_000 })
      .catch(() => {});
    await expect(page.getByRole('heading', { name: 'Choose a profile to enter' })).toBeVisible();
    await expect(page.getByText(/Provide an Authorization/)).toHaveCount(0);
  });
});
