// Settings as a person new to Drive meets them: Account, Storage and About in
// plain words, with network, keys and developer details closed away under
// Advanced until asked for. The secret key is shown only on purpose.
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { expectFolderEditable } from './test-utils';

const PHONE = { width: 390, height: 844 };

/** Words a person should not meet before opening Advanced. */
const JARGON = [/npub/i, /nsec/i, /nhash/i, /htree/i, /hashtree/i, /relay/i, /blossom/i, /fips/i, /nostr/i, /webrtc/i, /daemon/i, /app key/i, /secret key/i];

async function startSignedIn(page: Page, relayUrl: string): Promise<{ npub: string }> {
  await prepareFreshSession(page, relayUrl);
  const { npub } = await createDriveProfile(page, 'Plain Settings');
  await expectFolderEditable(page);
  return { npub };
}

async function expectNoJargon(page: Page): Promise<void> {
  const settings = page.getByTestId('settings-page');
  for (const word of JARGON) await expect(settings).not.toContainText(word);
}

async function expectAdvancedClosed(page: Page): Promise<void> {
  const toggle = page.getByTestId('settings-advanced-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('settings-advanced-items')).toHaveCount(0);
  for (const id of ['network', 'keys', 'developer']) {
    await expect(page.getByTestId(`settings-nav-${id}`)).toHaveCount(0);
  }
}

test.describe('plain settings', () => {
  test.setTimeout(120_000);

  test('on a computer, everyday settings read plainly and Advanced starts closed', async ({ page, relayUrl }, testInfo) => {
    const { npub } = await startSignedIn(page, relayUrl);

    await page.getByTestId('header-user-avatar').click();
    const accountMenu = page.getByTestId('account-menu');
    await expect(accountMenu.getByRole('menuitem')).toHaveText(['Accounts', 'Settings', 'Log out']);
    await accountMenu.getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page).toHaveURL(/#\/settings$/);

    const nav = page.getByRole('navigation', { name: 'Settings' });
    await expect(nav.getByTestId('settings-nav-account')).toHaveText('Account');
    await expect(nav.getByTestId('settings-nav-storage')).toHaveText('Storage');
    await expect(nav.getByTestId('settings-nav-about')).toHaveText('About');
    await expectAdvancedClosed(page);

    // Account: name and picture, this device, and switching or leaving.
    const account = page.getByTestId('account-settings');
    await expect(account.getByRole('heading', { name: 'Name and picture' })).toBeVisible();
    await expect(account.getByLabel('Your name')).toHaveValue('Plain Settings');
    await expect(account.getByRole('heading', { name: 'Devices' })).toBeVisible();
    await expect(page.getByTestId('user-key-row')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('device-approval-section').getByRole('heading', { name: 'Add a device' })).toBeVisible();
    // The only device keeps the right to manage the account.
    await expect(page.getByTestId('user-revoke-admin')).toHaveCount(0);
    await expect(page.getByTestId('settings-manage-users')).toHaveText('Switch account');
    await expect(page.getByTestId('settings-logout')).toHaveText('Log out');
    await expectNoJargon(page);

    await nav.getByTestId('settings-nav-storage').click();
    await expect(page.getByTestId('storage-settings').getByRole('heading', { name: 'On this device' })).toBeVisible();
    await expectNoJargon(page);
    await expect(page.getByTestId('backup-settings').getByRole('button', { name: 'Manage file servers' })).toBeVisible();

    await nav.getByTestId('settings-nav-about').click();
    const about = page.getByTestId('about-settings');
    await expect(about).toContainText('Iris Drive');
    const appLink = about.getByRole('link', { name: 'Get the Iris Drive app' });
    await expect(appLink).toBeVisible();
    await expect(appLink).toHaveAttribute('href', 'https://getdrive.iris.to/');
    await expect(about).toContainText('Updated');
    await expect(about.getByRole('button', { name: 'Refresh app' })).toBeVisible();
    await about.screenshot({ path: testInfo.outputPath('about.png') });
    await expectNoJargon(page);
    await expectAdvancedClosed(page);

    // Advanced opens on request.
    await page.getByTestId('settings-advanced-toggle').click();
    await expect(page.getByTestId('settings-advanced-toggle')).toHaveAttribute('aria-expanded', 'true');
    await expect(nav.getByTestId('settings-nav-network')).toHaveText('Network');
    await expect(nav.getByTestId('settings-nav-keys')).toHaveText('Keys');
    await expect(nav.getByTestId('settings-nav-developer')).toHaveText('Developer');

    // Keys: the public key is there to copy; the secret key only on purpose.
    await nav.getByTestId('settings-nav-keys').click();
    await expect(page).toHaveURL(/#\/settings\/keys$/);
    const keys = page.getByTestId('keys-settings');
    await expect(keys.getByRole('heading', { name: 'Your public key' })).toBeVisible();
    await expect(page.getByTestId('settings-public-key')).toContainText(npub.slice(0, 12));
    await expect(page.getByTestId('secret-key-warning')).toContainText('Anyone with your secret key controls your account');
    await expect(page.getByTestId('secret-key-value')).toHaveCount(0);
    await expect(page.getByTestId('copy-secret-key')).toHaveCount(0);
    await expect(keys).not.toContainText(/nsec1/);
    await page.getByTestId('reveal-secret-key').click();
    await expect(page.getByTestId('secret-key-value')).toHaveText(/^\s*nsec1[02-9ac-hj-np-z]+\s*$/);
    await expect(page.getByTestId('copy-secret-key')).toHaveText('Copy secret key');
    await page.getByTestId('hide-secret-key').click();
    await expect(page.getByTestId('secret-key-value')).toHaveCount(0);
    // Leaving the page hides it again.
    await page.getByTestId('reveal-secret-key').click();
    await expect(page.getByTestId('secret-key-value')).toBeVisible();
    await nav.getByTestId('settings-nav-developer').click();
    await expect(page.getByTestId('developer-settings')).toContainText('Built on');
    await nav.getByTestId('settings-nav-keys').click();
    await expect(page.getByTestId('reveal-secret-key')).toBeVisible();
    await expect(page.getByTestId('secret-key-value')).toHaveCount(0);

    // Network keeps relays and direct connections together.
    await nav.getByTestId('settings-nav-network').click();
    await expect(page.getByTestId('settings-network-traffic')).toHaveText('Usage');
    await expect(page.getByTestId('settings-network-servers')).toHaveText('Relays');
    await page.getByTestId('settings-network-servers').click();
    await expect(page.getByRole('heading', { name: /^Relays$/ })).toBeVisible();
    await expect(page.getByText(/^File servers \(/)).toHaveCount(0);
    await page.getByTestId('settings-network-p2p').click();
    await expect(page.getByTestId('settings-fips-peers')).toContainText('Direct connections');

    // Opening Settings afresh, Advanced is closed again.
    await page.goto(`${new URL(page.url()).origin}/#/settings`);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-nav-account')).toBeVisible({ timeout: 30_000 });
    await expectAdvancedClosed(page);
  });

  test('on a phone, the settings list leads to plain pages and Advanced starts closed', async ({ page, relayUrl }) => {
    await page.setViewportSize(PHONE);
    await startSignedIn(page, relayUrl);
    await page.goto(`${new URL(page.url()).origin}/#/settings`);

    const nav = page.getByRole('navigation', { name: 'Settings' });
    await expect(nav).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('account-settings')).toBeHidden();
    await expectAdvancedClosed(page);
    await expectNoJargon(page);

    await nav.getByTestId('settings-nav-account').click();
    await expect(page).toHaveURL(/#\/settings\/account$/);
    await expect(nav).toBeHidden();
    const account = page.getByTestId('account-settings');
    await expect(account.getByLabel('Your name')).toBeVisible();
    await expect(account.getByRole('heading', { name: 'Devices' })).toBeVisible();
    await expect(page.getByTestId('user-key-row')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('user-revoke-admin')).toHaveCount(0);
    await expectNoJargon(page);
    const pageBox = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, view: window.innerWidth }));
    expect(pageBox.scroll).toBeLessThanOrEqual(pageBox.view);

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(nav).toBeVisible();
    await expectAdvancedClosed(page);

    await page.getByTestId('settings-advanced-toggle').click();
    await nav.getByTestId('settings-nav-keys').click();
    await expect(page.getByTestId('secret-key-warning')).toBeVisible();
    await expect(page.getByTestId('secret-key-value')).toHaveCount(0);
    await expect(page.getByTestId('reveal-secret-key')).toBeVisible();

    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByTestId('settings-advanced-toggle')).toHaveAttribute('aria-expanded', 'true');
    await page.getByTestId('settings-advanced-toggle').click();
    await expectAdvancedClosed(page);
  });
});
