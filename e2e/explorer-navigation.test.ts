import { saveTextFile } from './test-utils.js';
import { test, expect } from './fixtures';
import {
  createAndEnterTree,
  createAndOpenFile,
  goToTreeList,
  prepareExplorerPage,
  safeReload,
  waitForAppReady,
} from './explorer.helpers';

test.describe('Hashtree Explorer', () => {
  test.setTimeout(180000);
  test.beforeEach(async ({ page }) => {
    await prepareExplorerPage(page);
  });

  test('should persist login across page reload', async ({ page }) => {
    // Avatar button should be visible (logged in state)
    const profileButton = page.getByTestId('header-user-avatar');
    await expect(profileButton).toBeVisible();

    // Reload page
    await safeReload(page, { waitUntil: 'domcontentloaded', timeoutMs: 60000 });
    await page.waitForTimeout(500);

    // Should still be logged in - avatar button still visible
    await expect(profileButton).toBeVisible();
  });

  test('should navigate to settings page and display sections', async ({ page }) => {
    await page.locator('a[href="#/settings"]').first().click();
    await page.waitForTimeout(300);

    expect(page.url()).toContain('/settings');

    await expect(page.getByTestId('settings-nav-network')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('settings-nav-storage')).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('settings-nav-app')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('settings-nav-network').click();
    await page.getByTestId('settings-network-servers').click();
    await expect(page.getByRole('heading', { name: 'Relays' })).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('heading', { name: /File Servers/ })).toBeVisible({ timeout: 5000 });
    await page.getByTestId('settings-network-p2p').click();
    await expect(page.getByTestId('settings-fips-peers')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText(/Device peers discovered over Nostr/)).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId('settings-fips-peers')).not.toContainText('Follows');

    await page.getByTestId('settings-nav-storage').click();
    await expect(page.getByText('Local Storage')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Items')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Size')).toBeVisible({ timeout: 5000 });

    await page.getByTestId('settings-nav-app').click();
    await expect(page.getByText('About')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('button', { name: 'Refresh App' })).toBeVisible({ timeout: 5000 });
  });

  test('old profile, follows and edit addresses open the person page', async ({ page }) => {
    const npub = page.url().match(/npub[a-z0-9]+/)?.[0];
    expect(npub).toBeTruthy();
    for (const suffix of ['profile', 'follows', 'followers', 'edit', '']) {
      await page.goto(`/#/${npub}${suffix ? `/${suffix}` : ''}`);
      await expect(page.getByTestId('person-page')).toBeVisible({ timeout: 5000 });
    }
  });

  test('should display file content when directly navigating to file URL', async ({ page }) => {
    // Create tree and create a text file via File button
    await createAndEnterTree(page, 'direct-nav-test');

    // Create text file using File button
    await createAndOpenFile(page, 'readme.txt');

    // File opens in edit mode - add content
    await page.locator('textarea').fill('Hello Direct Nav');
    await saveTextFile(page);
    await page.waitForTimeout(300);

    // Exit edit mode
    await page.getByRole('button', { name: 'Done' }).click();
    await page.waitForTimeout(500);

    // Get current URL (should be the file URL)
    const fileUrl = page.url();
    expect(fileUrl).toContain('readme.txt');

    // Navigate away to tree list
    await goToTreeList(page);
    await page.waitForTimeout(500);

    // Navigate directly back to the file URL
    await page.goto(fileUrl);
    await page.waitForTimeout(500);

    // The file should be displayed in preview (shows filename in viewer header)
    await expect(page.getByTestId('viewer-header')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('viewer-header').getByText('readme.txt')).toBeVisible({ timeout: 5000 });

    // Content should be visible
    await expect(page.locator('pre')).toContainText('Hello Direct Nav', { timeout: 5000 });
  });

  test('should display file content on mobile when directly navigating to file URL', async ({ page }) => {
    // Create tree and create a text file via File button
    await createAndEnterTree(page, 'mobile-file-test');

    // Create text file using File button
    await createAndOpenFile(page, 'mobile-readme.txt');

    // File opens in edit mode - add content
    await page.locator('textarea').fill('Hello Mobile View');
    await saveTextFile(page);
    await page.waitForTimeout(300);

    // Exit edit mode
    await page.getByRole('button', { name: 'Done' }).click();
    await page.waitForTimeout(500);

    // Get current URL (should be the file URL)
    const fileUrl = page.url();
    expect(fileUrl).toContain('mobile-readme.txt');

    // Navigate away to tree list
    await goToTreeList(page);
    await page.waitForTimeout(500);

    // Set mobile viewport BEFORE navigating
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(100);

    // Navigate directly back to the file URL
    await page.goto(fileUrl);
    await page.waitForTimeout(500);

    // On mobile, the file viewer should show (not the file browser)
    // The file should be displayed in preview (shows filename in viewer header)
    await expect(page.getByTestId('viewer-header')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('viewer-header').getByText('mobile-readme.txt')).toBeVisible({ timeout: 5000 });

    // Content should be visible
    await expect(page.locator('pre')).toContainText('Hello Mobile View', { timeout: 5000 });
  });

  test('should display document folder contents on mobile when navigating to document folder in files app', async ({ page }) => {
    // Navigate to public folder first
    const { chooseNew, navigateToPublicFolder, newMenuButton } = await import('./test-utils.js');
    await navigateToPublicFolder(page);

    if (await newMenuButton(page).isVisible().catch(() => false)) {
      await chooseNew(page, 'Document');
      const docInput = page.locator('input[placeholder="Document name..."]');
      await expect(docInput).toBeVisible({ timeout: 10000 });
      await docInput.fill('mobile-doc');
      await page.getByRole('button', { name: 'Create' }).click();
    } else {
      await page.evaluate(async () => {
        const { createDocument } = await import('/src/actions/tree.ts');
        await createDocument('mobile-doc');
      });
      const docLink = page.locator('[data-testid="file-list"] a').filter({ hasText: 'mobile-doc' }).first();
      await expect(docLink).toBeVisible({ timeout: 10000 });
      await docLink.click();
    }

    // Capture the document folder URL for direct mobile navigation.
    const docUrl = page.url();
    expect(docUrl).toContain('mobile-doc');

    // Navigate away
    await goToTreeList(page);
    await page.waitForTimeout(500);

    // Set mobile viewport BEFORE navigating back
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(100);

    // Navigate directly back to the document URL
    await page.goto(docUrl);
    await waitForAppReady(page);

    // In the files app, document folders still render as folders even on mobile.
    await expect(page.locator('[data-testid="file-list"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('[data-testid="file-list"] a').filter({ hasText: '.yjs' })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.ProseMirror')).toHaveCount(0);
  });
});
