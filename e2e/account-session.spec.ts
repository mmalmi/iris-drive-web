import { expect, test, type Page } from './fixtures';
import {
  clearAllStorage,
  configureBlossomServers,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils';

async function openFreshSetup(page: Page, relayUrl: string): Promise<void> {
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
  await expect(page.getByTestId('drive-setup')).toBeVisible({ timeout: 30_000 });
}

async function createProfile(page: Page): Promise<void> {
  await page.getByTestId('generate-new-account').click();
  await page.getByTestId('identity-create-name').fill('Account Test');
  await page.getByTestId('create-new-after-recovery-miss').click();
  await expect(page).toHaveURL(/#\/[0-9a-f-]{36}\/main$/, { timeout: 30_000 });
  await expect(page.getByTestId('header-user-avatar')).toBeVisible();
}

async function uploadTextFile(page: Page, name: string, content: string): Promise<void> {
  await page.getByRole('button', { name: 'New File' }).click();
  const nameInput = page.locator('input[placeholder="File name..."]');
  await expect(nameInput).toBeVisible({ timeout: 10_000 });
  await nameInput.fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  const editor = page.locator('textarea');
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await editor.fill(content);
  const saveButton = page.getByRole('button', { name: /Save|Saved|Saving/ });
  if (await saveButton.isEnabled().catch(() => false)) await saveButton.click();
  // Autosave may start before the explicit click, and the short-lived "Saved"
  // label is not a synchronization contract. Wait until the editor is clean
  // (disabled) and no save is still running before closing it.
  await expect.poll(async () => (
    await saveButton.isDisabled()
    && await saveButton.locator('span.absolute').textContent() !== 'Saving...'
  ), { timeout: 30_000 }).toBe(true);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(editor).not.toBeVisible({ timeout: 30_000 });
  await expect(page).toHaveURL(new RegExp(`/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), {
    timeout: 30_000,
  });
}

async function openAccountMenu(page: Page): Promise<void> {
  await page.getByTestId('header-user-avatar').click();
  await expect(page.getByTestId('account-menu')).toBeVisible();
}

test.describe('account navigation and logout', () => {
  test.setTimeout(180_000);

  test('opens Users from settings and stays logged out after reload', async ({ page, relayUrl }) => {
    await openFreshSetup(page, relayUrl);
    await createProfile(page);
    await uploadTextFile(page, 'private-before-logout.txt', 'must disappear after logout');

    const firstProfile = await page.evaluate(() => {
      const session = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
      return {
        id: session?.profileId as string,
        route: window.location.hash,
      };
    });
    expect(firstProfile.id).toMatch(/^[0-9a-f-]{36}$/);

    await openAccountMenu(page);
    await page.getByTestId('account-menu-settings').click();
    await expect(page).toHaveURL(/#\/settings$/);
    await expect(page.getByTestId('settings-manage-users')).toBeVisible();

    await page.getByTestId('settings-manage-users').click();
    await expect(page).toHaveURL(/#\/users$/);
    await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();

    await openAccountMenu(page);
    await page.getByTestId('account-menu-settings').click();
    await expect(page.getByTestId('settings-logout')).toBeVisible();
    await page.getByTestId('settings-logout').click();
    await expect(page).toHaveURL(/#\/$/);
    await expect(page.getByTestId('drive-setup')).toBeVisible();
    await expect(page.getByTestId('header-user-avatar')).toHaveCount(0);

    const signedOutStorage = await page.evaluate((profileId) => ({
      activeAccount: localStorage.getItem('hashtree:activeAccount'),
      accounts: JSON.parse(localStorage.getItem('hashtree:accounts') ?? '[]'),
      identitySession: localStorage.getItem('iris:identity:session'),
      identitySessions: JSON.parse(localStorage.getItem('iris:identity:sessions') ?? '{}'),
      deviceLabels: JSON.parse(localStorage.getItem('iris:drive:device-labels:v1') ?? '{}')[profileId] ?? null,
      isLoggedIn: (window as unknown as {
        __nostrStore?: { getState?: () => { isLoggedIn?: boolean } };
      }).__nostrStore?.getState?.().isLoggedIn,
    }), firstProfile.id);
    expect(signedOutStorage).toEqual({
      activeAccount: null,
      accounts: [],
      identitySession: null,
      identitySessions: {},
      deviceLabels: null,
      isLoggedIn: false,
    });

    const cachedFirstProfileRoot = await page.evaluate((profileId) => {
      const roots = JSON.parse(localStorage.getItem('hashtree:localRootCache') ?? '{}');
      return roots[`${profileId}/main`] ?? null;
    }, firstProfile.id);
    expect(cachedFirstProfileRoot).toBeNull();

    await page.evaluate((route) => {
      window.location.hash = route;
    }, firstProfile.route);
    await expect(page.locator('code').filter({ hasText: 'must disappear after logout' })).toHaveCount(0);
    expect(await page.evaluate(async (profileId) => {
      const { getTreeRootSync } = await import('/src/stores');
      return getTreeRootSync(profileId, 'main');
    }, firstProfile.id)).toBeNull();

    // The worker stays initialized with an anonymous identity, so a new account
    // can be created immediately without a page reload.
    await page.evaluate(() => {
      window.location.hash = '#/';
    });
    await expect(page.getByTestId('drive-setup')).toBeVisible();
    await createProfile(page);
    await uploadTextFile(page, 'after-same-page-login.txt', 'worker restarted safely');

    await openAccountMenu(page);
    await page.getByTestId('account-menu-logout').click();
    await expect(page.getByTestId('drive-setup')).toBeVisible();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForAppReady(page, 60_000);
    await expect(page.getByTestId('drive-setup')).toBeVisible();
    await expect(page.getByTestId('header-user-avatar')).toHaveCount(0);
    expect(await page.evaluate(() => (
      (window as unknown as {
        __nostrStore?: { getState?: () => { isLoggedIn?: boolean } };
      }).__nostrStore?.getState?.().isLoggedIn
    ))).toBe(false);
  });
});
