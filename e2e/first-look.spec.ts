// What a person new to Drive runs into first: sharing a folder, the Storage
// page, reading the small grey text, hearing what just happened, signing in
// on a second device, and telling files apart by their icons.
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createFolder, expectFolderEditable, fileRow, openRowMenu, uploadIntoFolder } from './test-utils';

const PHONE = { width: 390, height: 844 };

async function startInMyDrive(page: Page, relayUrl: string): Promise<void> {
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'First Look');
  await expectFolderEditable(page);
}

const dialog = (page: Page) => page.getByRole('dialog', { name: /^Share/ });

test.describe('a first look at Drive', () => {
  test.setTimeout(120_000);

  test('sharing a folder starts with inviting people, and the dialog says what it shares', async ({ page, relayUrl }) => {
    await startInMyDrive(page, relayUrl);
    await createFolder(page, 'Team');
    await uploadIntoFolder(page, { name: 'budget.txt', mimeType: 'text/plain', buffer: Buffer.from('100') });

    // From the folder's row menu.
    const menu = await openRowMenu(page, 'Team');
    await menu.getByRole('menuitem', { name: 'Share' }).click();
    await expect(dialog(page)).toBeVisible({ timeout: 30_000 });
    await expect(dialog(page)).toHaveAccessibleName('Share “Team”');
    await expect(page.getByTestId('share-people')).toBeVisible();
    await expect(page.getByTestId('share-tab-people')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('share-qr-code')).toHaveCount(0);
    await expect(dialog(page).getByRole('button', { name: 'Close' })).toBeFocused();
    await dialog(page).getByRole('button', { name: 'Close' }).click();
    await expect(page.getByTestId('share-modal')).toHaveCount(0);

    // From the open folder's own Share button.
    await fileRow(page, 'Team').getByRole('link').dblclick();
    await expect(page.getByTestId('folder-header').getByRole('heading', { name: 'Team' })).toBeVisible();
    await page.getByTestId('folder-header').getByRole('button', { name: 'Share' }).click();
    await expect(dialog(page)).toHaveAccessibleName('Share “Team”');
    await expect(page.getByTestId('share-people')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('share-modal')).toHaveCount(0);

    // A file can only be shared as a copy: the dialog names it and says so.
    await page.goBack();
    const fileMenu = await openRowMenu(page, 'budget.txt');
    await fileMenu.getByRole('menuitem', { name: 'Share' }).click();
    await expect(dialog(page)).toHaveAccessibleName('Share “budget.txt”');
    await expect(page.getByTestId('share-link-note')).toBeVisible();
  });

  test('the Storage page speaks plainly and shows nothing a person cannot act on', async ({ page, relayUrl }) => {
    await startInMyDrive(page, relayUrl);
    await page.getByTestId('drive-sidebar').getByRole('link', { name: 'Storage' }).click();
    const panel = page.getByTestId('storage-settings');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByRole('heading', { name: 'On this device' })).toBeVisible();
    await expect(panel).toContainText('so they open quickly and work offline');
    await expect(page.getByTestId('storage-size')).toBeVisible();
    await expect(page.getByTestId('storage-limit')).toContainText('GB');
    for (const jargon of [/backend/i, /web worker/i, /indexeddb/i, /republish/i, /relays?/i, /prefix/i, /directories/i]) {
      await expect(panel).not.toContainText(jargon);
    }
  });

  test('small grey text is readable in light and in dark', async ({ page, relayUrl }) => {
    await startInMyDrive(page, relayUrl);
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      const ratios = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement);
        const rgb = (name: string) => style.getPropertyValue(name).trim().split(/\s+/).map(Number);
        const luminance = (color: number[]) => {
          const [r, g, b] = color.map((value) => {
            const c = value / 255;
            return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const contrast = (a: number[], b: number[]) => {
          const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
          return (hi + 0.05) / (lo + 0.05);
        };
        const text = rgb('--text-3');
        return ['--surface-0', '--surface-1'].map((surface) => contrast(text, rgb(surface)));
      });
      for (const ratio of ratios) expect(ratio, `${colorScheme}: text-3 on its surfaces`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('what just happened is announced, and on a phone it stays clear of the tabs', async ({ page, relayUrl }) => {
    await page.setViewportSize(PHONE);
    await startInMyDrive(page, relayUrl);
    await uploadIntoFolder(page, { name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('hi') });
    const toast = page.getByRole('status').filter({ hasText: 'Uploaded hello.txt' });
    await expect(toast).toBeVisible({ timeout: 30_000 });
    const toastBox = (await toast.boundingBox())!;
    const tabsBox = (await page.getByTestId('drive-tabs').boundingBox())!;
    expect(toastBox.y + toastBox.height).toBeLessThanOrEqual(tabsBox.y);
  });

  test('signing in on another device says what to do there', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await page.getByTestId('add-existing-profile').click();
    await expect(page.getByTestId('device-approval-qr')).toBeVisible({ timeout: 30_000 });
    const request = page.getByTestId('device-approval-request-section');
    await expect(request.getByRole('heading', { name: 'Use a device you are signed in on' })).toBeVisible();
    await expect(request).toContainText('open Settings and find the device controls. Scan this code or paste the link.');
    await expect(request.getByRole('button', { name: 'Copy link' })).toBeVisible();
  });

  test('files of every common kind have an icon', async ({ page, relayUrl }) => {
    await startInMyDrive(page, relayUrl);
    const names = ['deck.pptx', 'data.json', 'photo.png', 'song.mp3', 'clip.mp4', 'sheet.csv', 'archive.zip', 'script.js'];
    await uploadIntoFolder(page, names.map((name) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(name) })));
    const without: string[] = [];
    for (const name of names) {
      const icon = fileRow(page, name).getByRole('link').locator('span').first();
      if (await icon.evaluate((element) => element.getBoundingClientRect().width) === 0) without.push(name);
    }
    expect(without, 'files shown without an icon').toEqual([]);
  });
});
