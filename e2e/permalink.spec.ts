import { saveTextFile } from './test-utils.js';
import { test, expect } from './fixtures';
import { disableOthersPool, ensureLoggedIn, waitForAppReady } from './test-utils.js';

test.describe('Permalink Navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppReady(page); // Wait for app to load before calling disableOthersPool
    await disableOthersPool(page); // Prevent WebRTC cross-talk from parallel tests

    // Test mode creates an isolated account; "New" creates a folder.
    await ensureLoggedIn(page);

    // Drive opens the current profile's main folder rather than a legacy tree list.
    await expect(page.getByTestId('home-link')).toHaveAttribute('href', /#\/[^/]+\/main$/, { timeout: 10000 });

    // Close any modals
    const cancelButton = page.getByRole('button', { name: 'Cancel' });
    if (await cancelButton.isVisible({ timeout: 500 }).catch(() => false)) {
      await cancelButton.click();
    }
  });

  test('file permalink should display file content', async ({ page }) => {
    test.slow(); // File operations can be slow under parallel load
    // Create content in the current profile's actual home folder.
    await page.getByTestId('home-link').click();
    await expect(page.getByRole('button', { name: 'New File', exact: true })).toBeVisible({ timeout: 5000 });

    // Create a file
    await page.getByRole('button', { name: 'New File', exact: true }).click();
    await expect(page.locator('input[placeholder="File name..."]')).toBeVisible({ timeout: 3000 });
    await page.locator('input[placeholder="File name..."]').fill('permalink-test.txt');
    await page.getByRole('button', { name: 'Create' }).click();

    // Wait for editor
    await expect(page.locator('textarea')).toBeVisible({ timeout: 5000 });
    await page.locator('textarea').fill('Hello from permalink test content!');
    await saveTextFile(page, 10_000);

    // Exit edit mode
    await page.getByRole('button', { name: 'Done' }).click();

    // Wait for textarea to disappear (confirms we exited edit mode)
    await expect(page.locator('textarea')).not.toBeVisible({ timeout: 10000 });

    // Wait for the content to be visible in the viewer (text files render in viewer)
    await expect(page.getByText('Hello from permalink test content!')).toBeVisible({ timeout: 30000 });

    // Find the Permalink link in viewer
    const permalinkLink = page.getByTestId('viewer-permalink');
    await expect(permalinkLink).toBeVisible({ timeout: 10000 });

    // Get the href
    const permalinkHref = await permalinkLink.getAttribute('href');
    console.log('File Permalink href:', permalinkHref);
    expect(permalinkHref).toBeTruthy();
    expect(permalinkHref).toContain('#/nhash1');
    expect(permalinkHref).toMatch(/\/permalink-test\.txt(?:\?|$)/);

    await permalinkLink.click();
    await page.waitForURL(/#\/nhash1/, { timeout: 15000 });

    // Should see the file content
    await expect(page.getByText('Hello from permalink test content!')).toBeVisible({ timeout: 30000 });
  });

  test('directory permalink should display directory listing', async ({ page }) => {
    test.slow(); // File operations can be slow under parallel load
    // Navigate to public folder
    await page.getByRole('link', { name: 'public' }).first().click();
    await expect(page.getByRole('button', { name: /New File/i })).toBeVisible({ timeout: 5000 });

    // Create a file so directory isn't empty
    await page.getByRole('button', { name: /New File/i }).click();
    await expect(page.locator('input[placeholder="File name..."]')).toBeVisible({ timeout: 3000 });
    await page.locator('input[placeholder="File name..."]').fill('test-in-dir.txt');
    await page.getByRole('button', { name: 'Create' }).click();

    // Wait for editor and add content
    await expect(page.locator('textarea')).toBeVisible({ timeout: 5000 });
    await page.locator('textarea').fill('Test file content');
    await saveTextFile(page);

    // Exit edit mode
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 3000 });
    await page.getByRole('button', { name: 'Done' }).click();

    await expect(page.locator('[data-modal-backdrop]')).not.toBeVisible({ timeout: 5000 });

    // Click on "Back to folder" link to go back to directory
    const backLink = page.getByRole('link', { name: 'Back to folder' });
    await expect(backLink).toBeVisible({ timeout: 10000 });
    await backLink.click();

    // Wait for directory view to load - New File button indicates we're in directory view
    await expect(page.getByRole('button', { name: /New File/i })).toBeVisible({ timeout: 5000 });

    // Wait for file to appear in the file list
    await expect(page.getByTestId('file-list').locator('text=test-in-dir.txt')).toBeVisible({ timeout: 5000 });

    // Find the directory Permalink link - use the data-testid
    // The link may be hidden on small screens, so wait for it to exist (not necessarily visible)
    const dirPermalinkLink = page.locator('[data-testid="permalink-link"]').first();
    await expect(dirPermalinkLink).toHaveCount(1, { timeout: 5000 });

    // Get the href - should NOT have a filename
    const dirPermalinkHref = await dirPermalinkLink.getAttribute('href');
    console.log('Directory Permalink href:', dirPermalinkHref);
    expect(dirPermalinkHref).toBeTruthy();
    expect(dirPermalinkHref).toContain('#/nhash1');
    // Directory permalink should NOT include filename
    expect(dirPermalinkHref).not.toContain('test-in-dir.txt');

    await page.goto(`http://localhost:5173/${dirPermalinkHref}`);
    await page.waitForURL(/#\/nhash1/, { timeout: 15000 });

    // Should see the file in the directory listing
    await expect(page.getByText('test-in-dir.txt')).toBeVisible({ timeout: 30000 });
  });

  test('file in permalink directory should display correctly', async ({ page }) => {
    test.slow(); // File operations can be slow under parallel load
    // Create an linkvis (encrypted) tree
    await page.getByRole('button', { name: /New Folder/i }).click();
    await expect(page.locator('input[placeholder="Folder name..."]')).toBeVisible({ timeout: 3000 });

    await page.locator('input[placeholder="Folder name..."]').fill('permalink-file-test');
    await page.getByRole('button', { name: /link-visible/i }).click();
    await page.getByRole('button', { name: 'Create' }).click();

    // Wait for navigation into the new tree (shows empty directory or New File button)
    await expect(page.getByRole('button', { name: /New File/i })).toBeVisible({ timeout: 10000 });

    // Create a file inside the encrypted tree
    await page.getByRole('button', { name: /New File/i }).click();
    await expect(page.locator('input[placeholder="File name..."]')).toBeVisible({ timeout: 3000 });
    await page.locator('input[placeholder="File name..."]').fill('test-content.txt');
    await page.getByRole('button', { name: 'Create' }).click();

    // Wait for editor and add content
    await expect(page.locator('textarea')).toBeVisible({ timeout: 5000 });
    await page.locator('textarea').fill('Hello from encrypted file!');
    await saveTextFile(page);

    // Exit edit mode
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible({ timeout: 3000 });
    await page.getByRole('button', { name: 'Done' }).click();

    await expect(page.locator('[data-modal-backdrop]')).not.toBeVisible({ timeout: 5000 });

    // Go back to directory to get permalink
    const backLink = page.getByRole('link', { name: 'Back to folder' });
    await expect(backLink).toBeVisible({ timeout: 10000 });
    await backLink.click();

    // Wait for directory view to load - "New File" button appears in directory view
    await expect(page.getByRole('button', { name: /New File/i })).toBeVisible({ timeout: 10000 });

    // Also wait for file to appear in the list to confirm directory loaded
    await expect(page.locator('[data-testid="file-list"]').getByText('test-content.txt')).toBeVisible({ timeout: 10000 });

    // Get the directory permalink href - use visible link (there are two, one hidden on desktop)
    const dirPermalinkLink = page.getByRole('link', { name: 'Snapshot', exact: true }).first();
    await expect(dirPermalinkLink).toBeVisible({ timeout: 5000 });
    const permalinkHref = await dirPermalinkLink.getAttribute('href');
    console.log('Directory permalink:', permalinkHref);
    expect(permalinkHref).toBeTruthy();

    await page.goto(`http://localhost:5173/${permalinkHref}`);
    await page.waitForURL(/#\/nhash1/, { timeout: 15000 });

    // Wait for page to load and decrypt - file should appear in listing
    // The permalink page may need time to decrypt and load directory entries
    // Use file-list testid to be specific about which element we're looking for
    await expect(page.locator('[data-testid="file-list"]').getByText('test-content.txt')).toBeVisible({ timeout: 30000 });

    // Navigate directly using the visible file link href to avoid detached-node races
    const filePermalinkLink = page.getByRole('link', { name: 'test-content.txt' }).first();
    const filePermalinkHref = await filePermalinkLink.getAttribute('href');
    expect(filePermalinkHref).toContain('#/nhash1');
    await page.goto(`http://localhost:5173/${filePermalinkHref}`);

    // Should see the file content (not a broken image) - allow more time for decryption
    await expect(page.getByText('Hello from encrypted file!')).toBeVisible({ timeout: 30000 });
  });
});
