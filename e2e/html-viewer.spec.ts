import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { setupPageErrorHandler, navigateToPublicFolder } from './test-utils.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

async function ensureFolderView(page: Page) {
  const fileList = page.locator('[data-testid="file-list"]');
  const backToFolder = page.getByRole('link', { name: 'Back to folder' });
  if (await backToFolder.isVisible().catch(() => false)) {
    await backToFolder.click({ force: true });
  } else {
    try {
      await backToFolder.waitFor({ state: 'visible', timeout: 2000 });
      await backToFolder.click({ force: true });
    } catch {
      // No-op: already in folder view.
    }
  }
  await expect(fileList).toBeVisible({ timeout: 10000 });
  await expect(backToFolder).toBeHidden({ timeout: 10000 });
}

test.describe('HTML file viewing', () => {
  test('shows HTML source in iris-files and Open Site links to sites.iris.to', async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await navigateToPublicFolder(page);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'html-test-'));
    const cssPath = path.join(tmpDir, 'style.css');
    const htmlPath = path.join(tmpDir, 'index.html');

    try {
      fs.writeFileSync(cssPath, 'body { background: rgb(0, 128, 0); }');
      fs.writeFileSync(htmlPath, `<!DOCTYPE html>
<html>
<head>
  <title>Test Page</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Hello from HashTree</h1>
</body>
</html>`);

      await page.getByTestId('home-link').click();
      await page.waitForTimeout(300);
      await page.getByRole('button', { name: 'New Folder' }).click();

      const input = page.locator('input[placeholder="Folder name..."]');
      await input.waitFor({ timeout: 5000 });
      await input.fill('html-test');
      await page.click('button:has-text("Create")');

      await expect(page.locator('.fixed.inset-0.bg-black')).not.toBeVisible({ timeout: 10000 });
      await expect(page.getByText(/Drop or click to add|Empty directory/).first()).toBeVisible({ timeout: 10000 });

      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(cssPath);
      await ensureFolderView(page);
      await expect(page.locator('[data-testid="file-list"] a:has-text("style.css")')).toBeVisible({ timeout: 10000 });

      await fileInput.setInputFiles(htmlPath);
      await ensureFolderView(page);
      await expect(page.locator('[data-testid="file-list"] a:has-text("index.html")')).toBeVisible({ timeout: 10000 });

      const directoryOpenSite = page.getByTestId('directory-open-site');
      await expect(directoryOpenSite).toBeVisible({ timeout: 10000 });
      await expect(directoryOpenSite).toHaveAttribute('href', /https:\/\/sites\.iris\.to\/#\//);
      await expect(directoryOpenSite).toHaveAttribute('href', /html-test\/index\.html\?reload=1$/);

      await page.locator('[data-testid="file-list"] a:has-text("index.html")').click();

      const viewerOpenSite = page.getByTestId('viewer-open-site');
      await expect(viewerOpenSite).toBeVisible({ timeout: 10000 });
      const viewerHref = await viewerOpenSite.getAttribute('href');
      expect(viewerHref).toMatch(/https:\/\/sites\.iris\.to\/#\//);
      expect(viewerHref).toMatch(/html-test\/index\.html\?reload=1$/);

      const codeViewer = page.locator('pre.code-viewer');
      await expect(codeViewer).toBeVisible({ timeout: 10000 });
      await expect(codeViewer).toContainText('<h1>Hello from HashTree</h1>');
      await expect(codeViewer).toContainText('<link rel="stylesheet" href="style.css">');
      await expect(page.locator('iframe')).toHaveCount(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
