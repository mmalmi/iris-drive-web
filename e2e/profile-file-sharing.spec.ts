import { expect, test, type Page } from './fixtures';
import {
  clearAllStorage,
  configureBlossomServers,
  ensureLoggedIn,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

async function prepareFreshSession(page: Page, relayUrl: string): Promise<void> {
  setupPageErrorHandler(page);
  await page.addInitScript(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await clearAllStorage(page);
  await page.evaluate(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await presetLocalRelayInDB(page, relayUrl);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60_000);
  await useLocalRelay(page, relayUrl);
  await configureBlossomServers(page);
  await waitForRelayConnected(page, 30_000);
}

async function createDriveProfile(page: Page): Promise<{ profileId: string; npub: string }> {
  await expect(page.getByTestId('drive-setup')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('generate-new-account').click();
  await expect(page.getByTestId('identity-create-name')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('identity-create-name').fill('Share Test');
  await page.getByTestId('create-new-after-recovery-miss').click();

  const identity = await page.waitForFunction(() => {
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    const npub = (window as unknown as {
      __nostrStore?: { getState?: () => { npub?: string } };
    }).__nostrStore?.getState?.().npub;
    return stored?.status === 'active' && stored.profileId && npub
      ? { profileId: stored.profileId as string, npub }
      : null;
  }, undefined, { timeout: 30_000 });
  return await identity.jsonValue() as { profileId: string; npub: string };
}

test.describe('profile file sharing', () => {
  test.setTimeout(180_000);

  test('opens an added file permalink in a fresh browser session', async ({ browser, page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    const owner = await createDriveProfile(page);
    await expect(page).toHaveURL(new RegExp(`#/${owner.profileId}/main`), { timeout: 30_000 });

    const fileName = 'shared-profile-file.txt';
    const fileContent = 'Loaded from an immutable profile-drive share.';
    await page.locator('label[title="Add files"]:visible input[type="file"]')
      .setInputFiles({
        name: fileName,
        mimeType: 'text/plain',
        buffer: Buffer.from(fileContent),
      });

    await expect(page.getByRole('heading', { name: fileName })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(fileContent)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('viewer-permalink')).toHaveAttribute('href', /^#\/nhash1/);

    const shareButton = page.getByTestId('viewer-share');
    await expect(shareButton).toBeEnabled();
    await shareButton.click();
    await expect(page.getByTestId('share-modal')).toBeVisible();
    await expect(page.getByTestId('share-link-variant-latest')).toHaveCount(0);
    await page.getByTestId('share-copy-url').click();
    await expect.poll(
      async () => page.evaluate(() => navigator.clipboard.readText()),
      { timeout: 10_000 },
    ).toMatch(/^https:\/\/drive\.iris\.to\/#\/nhash1/);
    const sharedUrl = await page.evaluate(() => navigator.clipboard.readText());
    expect(sharedUrl).toContain(`/${fileName}`);
    expect(sharedUrl).not.toContain(owner.profileId);

    await page.keyboard.press('Escape');

    const guestContext = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const guestPage = await guestContext.newPage();
    try {
      await prepareFreshSession(guestPage, relayUrl);
      await ensureLoggedIn(guestPage, 30_000);
      const guestNpub = await guestPage.evaluate(() => (
        (window as unknown as {
          __nostrStore?: { getState?: () => { npub?: string } };
        }).__nostrStore?.getState?.().npub ?? ''
      ));
      expect(guestNpub).toMatch(/^npub1/);

      const sharedHash = new URL(sharedUrl).hash;
      await guestPage.evaluate((hash) => {
        window.location.hash = hash;
      }, sharedHash);
      await guestPage.waitForURL(/#\/nhash1/, { timeout: 30_000 });
      await expect(guestPage.getByText(fileContent)).toBeVisible({ timeout: 60_000 });
    } finally {
      await guestContext.close();
    }
  });
});
