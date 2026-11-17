import { test, expect } from './fixtures';
import { setupPageErrorHandler, configureBlossomServers, navigateToPublicFolder, disableOthersPool, waitForAppReady, getTestBlossomUrl } from './test-utils.js';

test.describe('Settings page', () => {
  for (const width of [1280, 390]) {
    test(`Help explains Drive and opens keyboard shortcuts at ${width}px`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/#/settings');
      await page.getByRole('button', { name: 'Help', exact: true }).click();
      await expect(page).toHaveURL(/#\/settings\/help$/);
      await expect(page.getByRole('heading', { name: 'Who can open a link I copy?' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'How do I restore a deleted file?' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Which device has a copy of my files?' })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Trash', exact: true })).toHaveAttribute('href', '#/trash');
      await expect(page.getByRole('link', { name: 'Settings → Storage' })).toHaveAttribute('href', '#/settings/storage');
      await page.screenshot({ path: testInfo.outputPath('settings-help.png') });
      const shortcuts = page.getByRole('button', { name: 'Keyboard shortcuts', exact: true });
      await shortcuts.click();
      const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
      await expect(dialog.getByText('Copy link', { exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(shortcuts).toBeFocused();
      await page.reload();
      await expect(shortcuts).toBeVisible();
    });
  }

  test('can navigate to settings page and defaults to the account section', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');

    const settingsLink = page.locator('a[href="#/settings"]');
    await expect(settingsLink).toBeVisible({ timeout: 10000 });
    await settingsLink.click();

    await page.waitForURL(/#\/settings/, { timeout: 5000 });

    await expect(page.getByTestId('settings-nav-account')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('settings-advanced-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('button', { name: 'Network' })).toHaveCount(0);
    await page.getByTestId('settings-nav-about').click();
    await expect(page.getByText('Refresh app')).toBeVisible({ timeout: 5000 });
    await page.getByTestId('settings-advanced-toggle').click();
    await expect(page.getByRole('button', { name: 'Network' })).toBeVisible({ timeout: 5000 });
  });

  test('app settings do not link to the retired Iris Browser', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/#/settings/app');

    await expect(page.getByTestId('settings-nav-account')).toHaveAttribute('aria-current', 'page', { timeout: 10000 });
    await expect(page.getByTestId('settings-iris-browser-link')).toHaveCount(0);
    await expect(page.getByTestId('settings-iris-browser-repo-link')).toHaveCount(0);
    await expect(page.getByText('browser.iris.to')).toHaveCount(0);
    await expect(page.getByText('Iris Browser code')).toHaveCount(0);
  });

  test('can expand discovered relays section', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/#/settings/network/servers');
    await expect(page.getByTestId('settings-network-servers')).toBeVisible({ timeout: 10000 });

    const seededCount = await page.evaluate(() => {
      const store = (window as any).__nostrStore;
      if (!store) return 0;
      const relay = { url: 'wss://relay.discovered.example.com', status: 'connected' as const };
      const apply = () => {
        if (typeof store.setDiscoveredRelays === 'function') {
          store.setDiscoveredRelays([relay]);
        } else if (typeof store.setState === 'function') {
          store.setState({ discoveredRelays: [relay] });
        }
      };
      apply();

      if (typeof store.setDiscoveredRelays === 'function') {
        const originalSetDiscoveredRelays = store.setDiscoveredRelays.bind(store);
        store.setDiscoveredRelays = () => originalSetDiscoveredRelays([relay]);
      }

      return store.getState?.().discoveredRelays?.length ?? 0;
    });
    expect(seededCount).toBe(1);

    const discoveredToggle = page.getByRole('button', { name: /Discovered relays \(1\)/i });
    await expect(discoveredToggle).toBeVisible({ timeout: 5000 });
    await discoveredToggle.click();

    const discoveredSection = page.locator('div').filter({ has: discoveredToggle }).first();
    await expect(discoveredSection.getByText('relay.discovered.example.com')).toBeVisible({ timeout: 5000 });
  });

  test('can add and remove a read-only file server under Backups', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/#/settings/storage');

    const backups = page.getByTestId('backup-settings');
    await backups.getByRole('button', { name: 'Manage file servers' }).click();
    await expect(backups.getByRole('checkbox', { name: 'Save a backup on this server' })).not.toBeChecked();
    await backups.getByRole('textbox', { name: 'File server address' }).fill('https://test-files.example.com');
    await backups.getByRole('button', { name: 'Add file server' }).click();

    const row = backups.getByRole('listitem', { name: 'test-files.example.com' });
    await expect(row).toHaveCount(1);
    await expect(row.getByRole('checkbox', { name: 'Read files' })).toBeChecked();
    await expect(row.getByRole('checkbox', { name: 'Save backups', exact: true })).not.toBeChecked();
    await expect(row.getByTestId('backup-status')).toHaveCount(0);
    await row.getByRole('button', { name: 'Remove' }).click();
    await expect(row).toHaveCount(0);
  });

  test('can edit permissions for a file server that keeps a backup', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/#/settings/storage');
    await waitForAppReady(page);
    await configureBlossomServers(page);

    const backups = page.getByTestId('backup-settings');
    const row = backups.getByRole('listitem', { name: new URL(getTestBlossomUrl()).host });
    await expect(row.getByTestId('backup-status')).toBeVisible();
    await backups.getByRole('button', { name: 'Manage file servers' }).click();
    const read = row.getByRole('checkbox', { name: 'Read files' });
    await read.uncheck();
    await expect(read).not.toBeChecked();
    await read.check();
    await expect(read).toBeChecked();

    const save = row.getByRole('checkbox', { name: 'Save backups', exact: true });
    await expect(row.getByRole('button', { name: 'Remove' })).toBeDisabled();
    await expect(save).toBeChecked();
    await save.uncheck();
    await expect(read).toBeChecked();
    await expect(row.getByTestId('backup-status')).toHaveCount(0);
    await save.check();
    await expect(row.getByTestId('backup-status')).toBeVisible();
  });

  test('settings page does not freeze with rapid interactions', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/#/settings');

    await expect(page.getByTestId('settings-nav-account')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Storage' }).click();

    for (let i = 0; i < 5; i++) {
      const editBtn = page.locator('button', { hasText: /Edit|Done/ }).first();
      await expect(editBtn).toBeVisible({ timeout: 2000 });
      const currentLabel = (await editBtn.textContent()) || '';
      await editBtn.click();
      const expectedLabel = currentLabel.includes('Edit') ? /Done/ : /Edit/;
      await expect(editBtn).toHaveText(expectedLabel, { timeout: 2000 });
    }

    await expect(page.getByRole('button', { name: 'Storage' })).toBeVisible({ timeout: 5000 });
  });

  test('displays storage stats with non-zero size after uploading', async ({ page }) => {
    test.slow();
    setupPageErrorHandler(page);

    await page.goto('/');
    await disableOthersPool(page);

    await navigateToPublicFolder(page);

    const testContent = 'Test file content for storage test - '.repeat(100);
    const fileInput = page.getByTestId('upload-files-input');
    await fileInput.setInputFiles({
      name: 'storage-test.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(testContent),
    });

    const uploadedFileLink = page.locator('[data-testid="file-list"]').getByRole('link', { name: /storage-test\.txt/ }).first();
    await expect(uploadedFileLink).toBeVisible({ timeout: 10000 });

    const settingsLink = page.locator('a[href="#/settings"]');
    await expect(settingsLink).toBeVisible({ timeout: 5000 });
    await settingsLink.click();
    await page.waitForURL(/#\/settings/, { timeout: 5000 });

    await page.getByRole('button', { name: 'Storage' }).click();

    await expect(page.getByRole('heading', { name: 'On this device' })).toBeVisible({ timeout: 5000 });

    const sizeElement = page.getByTestId('storage-size');
    await expect(sizeElement).toBeVisible({ timeout: 5000 });

    await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="storage-size"]');
        return el && el.textContent && el.textContent !== '0 B' && el.textContent !== '0';
      },
      { timeout: 15000 }
    );

    const sizeText = await sizeElement.textContent();
    expect(sizeText).not.toBe('0 B');

    const limitElement = page.getByTestId('storage-limit');
    const limitText = await limitElement.textContent();
    expect(limitText).toContain('GB');
  });

  test('can edit storage limit', async ({ page }) => {
    test.setTimeout(60000);
    setupPageErrorHandler(page);
    await page.goto('/#/settings/storage');

    await expect(page.getByRole('heading', { name: 'On this device' })).toBeVisible({ timeout: 10000 });

    const storageSectionHeader = page.locator('h3:has-text("On this device")');
    await expect(storageSectionHeader).toBeVisible({ timeout: 5000 });

    const editBtn = storageSectionHeader.locator('..').getByRole('button', { name: 'Edit' });
    await expect(editBtn).toBeVisible({ timeout: 5000 });
    await editBtn.click();

    const limitInput = page.getByTestId('storage-limit-input');
    await expect(limitInput).toBeVisible({ timeout: 5000 });

    await limitInput.fill('500');
    await limitInput.blur();

    const doneBtn = storageSectionHeader.locator('..').getByRole('button', { name: 'Done' });
    await doneBtn.click();

    const limitElement = page.getByTestId('storage-limit');
    await expect(limitElement).toContainText('500');
  });
});
