import fs from 'node:fs/promises';
import { test, expect } from '@playwright/test';

/**
 * One recorded end-to-end run over the four journeys the Round 3 report claims:
 * sign in as the lead, compose-approve-share, open the share link as the
 * recipient, acknowledge. It also exercises the newer two-way features
 * (download, flag an item, delivery record, audit CSV) against the real UI.
 */

test.describe.configure({ mode: 'serial' });

test('lead prepares and shares a handover that the recipient opens, flags and acknowledges', async ({
  page,
  browser,
  request,
}) => {
  await test.step('seed the demo workspace', async () => {
    const seeded = await request.post('/api/demo/seed');
    expect(seeded.ok()).toBeTruthy();
  });

  await test.step('journey 1: sign in as the lead with one click', async () => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Enter the Atlas workspace as Subham Sahu/i })
      .click();
    const projectCard = page.locator('#main').getByRole('link', {
      name: /Project Atlas - Billing Service Migration/i,
    });
    await expect(projectCard).toBeVisible();
    await projectCard.click();
    await expect(page.getByRole('button', { name: 'New handover' })).toBeVisible();
  });

  let shareLink;
  await test.step('journey 2: compose, approve and share', async () => {
    await page.getByRole('button', { name: 'New handover' }).click();
    const recipient = page.locator('#handover-recipient');
    await expect(recipient).toBeVisible();

    const ananyaValue = await recipient
      .locator('option', { hasText: 'Ananya Rao' })
      .getAttribute('value');
    expect(ananyaValue).toBeTruthy();
    await recipient.selectOption(ananyaValue);

    await page.getByRole('button', { name: 'Compose draft' }).click();
    await expect(page).toHaveURL(/\/handovers\/[a-f0-9]{24}$/i);
    await expect(
      page.getByRole('heading', { name: 'Handover for Ananya Rao' }),
    ).toBeVisible();

    const acceptAll = page.getByRole('button', { name: /Accept all verified/ });
    if ((await acceptAll.count()) > 0) {
      await acceptAll.click();
      await page.getByRole('button', { name: /^Accept \d+ items?$/ }).click();
    }

    await page.getByRole('button', { name: 'Submit for review' }).click();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Approve handover' }).click();

    await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('button', { name: 'Create share link' }).click();

    const linkText = page.locator('p.break-all').first();
    await expect(linkText).toContainText('/shared/');
    shareLink = (await linkText.textContent()).trim();
    await page.getByRole('button', { name: 'Close', exact: true }).last().click();
  });

  const guestContext = await browser.newContext({ acceptDownloads: true });
  const guest = await guestContext.newPage();

  await test.step('journey 3: open the share link as a guest recipient', async () => {
    await guest.goto(shareLink);
    await expect(guest.getByRole('heading', { name: /Project Atlas/ })).toBeVisible();
    await expect(
      guest.getByText(/Demo preview: this link opens without an account/),
    ).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Download Markdown' })).toBeVisible();

    const downloadEvent = guest.waitForEvent('download');
    await guest.getByRole('button', { name: 'Download Markdown' }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(
      /^handover-ananya-rao-\d{4}-\d{2}-\d{2}\.md$/,
    );
    const markdown = await fs.readFile(await download.path(), 'utf8');
    expect(markdown).toContain('# Handover for Ananya Rao');
    expect(markdown).toContain('**View:** recipient copy');
    expect(markdown).not.toContain('vendor-contract-summary.md');

    await guest.getByRole('button', { name: 'Flag this item' }).first().click();
    const feedbackDialog = guest.getByRole('dialog', { name: 'Flag this item' });
    await feedbackDialog
      .getByLabel('Your note')
      .fill('E2E check: please confirm who owns the invoice backfill.');
    await feedbackDialog.getByRole('button', { name: 'Send note' }).click();
    await expect(
      guest.getByText(/Your note was sent to the project team/).first(),
    ).toBeVisible();
  });

  await test.step('journey 4: acknowledge the handover', async () => {
    await guest.getByRole('button', { name: 'Acknowledge receipt' }).first().click();
    await expect(guest.getByText(/You acknowledged this handover/)).toBeVisible();
  });

  await test.step('the lead sees the open, feedback and delivery record', async () => {
    await page.reload();
    await expect(page.getByText(/opened \d+×/)).toBeVisible();
    const feedbackCard = page.getByTestId('handover-feedback');
    await expect(feedbackCard).toContainText('E2E check: please confirm');
    await expect(page.getByTestId('handover-deliveries')).toContainText('skipped');

    await feedbackCard.getByRole('button', { name: 'Mark resolved' }).click();
    await expect(feedbackCard).toContainText('Resolved');
  });

  await test.step('the lead exports the permission-filtered audit log as CSV', async () => {
    await page.getByRole('link', { name: 'Audit log' }).click();
    await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();

    const csvEvent = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Export CSV' }).click();
    const csv = await csvEvent;
    expect(csv.suggestedFilename()).toMatch(/^atlas-audit-\d{4}-\d{2}-\d{2}\.csv$/);
    const contents = await fs.readFile(await csv.path(), 'utf8');
    expect(contents).toContain('handover.feedback_received');
    expect(contents).toContain('handover.acknowledged');
  });

  await guestContext.close();
});

test('the incoming recipient only sees the handover shared with them and the sources they may read', async ({
  page,
}) => {
  let projectId;

  await test.step('signing in lands on the shared handovers, not the outgoing record', async () => {
    await page.goto('/');
    await page
      .getByRole('button', { name: /Enter the Atlas workspace as Ananya Rao/i })
      .click();
    await page
      .locator('#main')
      .getByRole('link', { name: /Project Atlas - Billing Service Migration/i })
      .click();

    await expect(page).toHaveURL(/\/projects\/[a-f0-9]{24}\/handovers$/);
    projectId = new URL(page.url()).pathname.split('/')[2];
    await expect(page.getByText('Incoming recipient').first()).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Handover for Ananya Rao' }),
    ).toBeVisible();
  });

  await test.step('cannot prepare a handover for any recipient', async () => {
    await expect(page.getByRole('button', { name: 'New handover' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Prepare .*handover/i })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Mitigate' })).toHaveCount(0);
  });

  await test.step('the project navigation is limited to sources and handovers', async () => {
    for (const label of ['Sources', 'Handovers']) {
      await expect(page.getByRole('link', { name: label, exact: true }).first()).toBeVisible();
    }
    for (const label of ['Overview', 'Claims', 'Questions', 'People', 'Audit log']) {
      await expect(page.getByRole('link', { name: label, exact: true })).toHaveCount(0);
    }
  });

  await test.step('direct URLs for the outgoing record bounce back', async () => {
    for (const section of ['', '/claims', '/questions', '/people']) {
      await page.goto(`/projects/${projectId}${section}`);
      await expect(page).toHaveURL(/\/projects\/[a-f0-9]{24}\/handovers$/);
    }
  });

  await test.step('sources are readable but not editable', async () => {
    await page.getByRole('link', { name: 'Sources', exact: true }).first().click();
    await expect(page).toHaveURL(/\/sources$/);
    await expect(page.getByRole('button', { name: 'Add source' })).toHaveCount(0);
    await expect(page.getByText('Read-only role').first()).toBeVisible();
    await expect(page.locator('#main h2').first()).toBeVisible();
  });
});
