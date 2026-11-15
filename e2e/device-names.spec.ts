// Two browsers of one kind linked to one Drive are told apart in Settings >
// User: the second is numbered, the same way on both.
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';

// Chrome on a Mac, as in the tour where both browsers were "Chrome on macOS".
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
test.use({ userAgent: MAC_CHROME });

async function deviceNames(page: Page): Promise<string[]> {
  await page.goto(`${new URL(page.url()).origin}/#/settings/user`);
  const rows = page.getByTestId('user-key-row');
  await expect(rows).toHaveCount(2, { timeout: 60_000 });
  return rows.locator('strong').allTextContents();
}

async function requestLink(page: Page): Promise<string> {
  await page.goto(`${new URL(page.url()).origin}/#/users`);
  await page.getByTestId('add-existing-profile').click();
  await expect(page.getByTestId('device-approval-qr')).toBeVisible({ timeout: 30_000 });
  return page.evaluate(() => {
    const stored = JSON.parse(localStorage.getItem('iris:drive:pending-device-approval') ?? 'null') as { url?: string } | null;
    return stored?.url ?? '';
  });
}

test('a second browser of the same kind is numbered on both devices', async ({ page, browser, relayUrl }, testInfo) => {
  test.setTimeout(240_000);
  await prepareFreshSession(page, relayUrl);
  const { profileId } = await createDriveProfile(page, 'Two Browsers');

  const secondContext = await browser.newContext({ userAgent: MAC_CHROME });
  try {
    const second = await secondContext.newPage();
    await prepareFreshSession(second, relayUrl);
    const approvalUrl = await requestLink(second);
    expect(approvalUrl).toMatch(/approve-device/);

    const origin = new URL(page.url()).origin;
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    const pasteRequest = async () => {
      await page.bringToFront();
      await page.getByRole('textbox', { name: 'Search Drive' }).click();
      await page.evaluate((url) => navigator.clipboard.writeText(url), approvalUrl);
      await page.keyboard.press('ControlOrMeta+v');
    };
    await pasteRequest();
    const review = page.getByTestId('device-approval-route');
    await expect(review).toContainText('Chrome on macOS');
    await expect(review.getByRole('button', { name: 'Add device' })).toBeEnabled();
    await expect(page.getByRole('textbox', { name: 'Search Drive' })).toHaveValue('');
    await page.screenshot({ path: testInfo.outputPath('device-confirmation.png') });
    await review.getByRole('button', { name: 'Cancel' }).click();
    await page.goto(origin + '/#/settings/user');
    await expect(page.getByTestId('user-key-row')).toHaveCount(1);

    // Opening the native HTTPS path directly requires the same explicit choice.
    await page.goto(origin + new URL(approvalUrl).pathname);
    await expect(review).toContainText('Chrome on macOS');
    await review.getByRole('button', { name: 'Add device' }).click();
    await expect(page.getByTestId('user-key-row')).toHaveCount(2, { timeout: 60_000 });

    const first = await deviceNames(page);
    expect([...first].sort()).toEqual(['Chrome on macOS', 'Chrome on macOS (2)']);
    await page.screenshot({ path: testInfo.outputPath('first-device.png') });

    await expect.poll(() => second.evaluate(() => JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null')?.profileId ?? null), { timeout: 60_000 })
      .toBe(profileId);
    const onSecond = await deviceNames(second);
    expect([...onSecond].sort()).toEqual([...first].sort());
    await second.screenshot({ path: testInfo.outputPath('second-device.png') });
  } finally {
    await secondContext.close();
  }
});
