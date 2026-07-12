import { test, expect } from './fixtures';
import type { Page } from '@playwright/test';
import { navigateToPublicFolder, goToTreeList, setupFreshUser, waitForCurrentDirectoryEntries } from './test-utils.js';

test.use({
  permissions: ['clipboard-read', 'clipboard-write'],
});

// Helper to create tree and navigate into it
async function createAndEnterTree(page: Page, name: string) {
  await goToTreeList(page);
  await expect(page.getByRole('button', { name: 'New Folder' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'New Folder' }).click();
  await page.locator('input[placeholder="Folder name..."]').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  const folderLink = page.locator('a').filter({ hasText: name }).first();
  await expect(folderLink).toBeVisible({ timeout: 10000 });
  await folderLink.click();
  await expect(page).toHaveURL(new RegExp(`/${name}(?:[?#]|$)`), { timeout: 30000 });
  await expect(page.getByRole('button', { name: 'New File' })).toBeVisible({ timeout: 30000 });
  await expect(page.getByText('Empty directory')).toBeVisible({ timeout: 10000 });
}

// Helper to create a file
async function createFile(page: Page, name: string, content: string = '') {
  await page.getByRole('button', { name: /File/ }).first().click();
  await page.locator('input[placeholder="File name..."]').fill(name);
  await page.getByRole('button', { name: 'Create' }).click();
  const doneButton = page.getByRole('button', { name: 'Done' });
  const editorTextarea = page.locator('textarea').last();
  await expect(doneButton).toBeVisible({ timeout: 5000 });
  await expect(editorTextarea).toBeVisible({ timeout: 5000 });
  if (content) {
    await editorTextarea.fill(content);
    const saveButton = page.getByRole('button', { name: /Save|Saved|Saving/ }).first();
    if (await saveButton.isEnabled().catch(() => false)) {
      await saveButton.click();
    }
    await expect(saveButton).toBeDisabled({ timeout: 10000 });
  }
  await doneButton.click();
  await expect(doneButton).not.toBeVisible({ timeout: 10000 });
  await expect(editorTextarea).not.toBeVisible({ timeout: 10000 });
}

async function openReadmeFile(page: Page, treeName: string) {
  await goToTreeList(page);
  await page.locator('a').filter({ hasText: treeName }).first().click();
  const readmeLink = page.getByRole('link', { name: /^README\.md/ }).first();
  await expect(readmeLink).toBeVisible({ timeout: 30000 });
  await readmeLink.click();
  await expect(page.locator('.markdown-content')).toBeVisible({ timeout: 30000 });
}

test.describe('README Viewer', () => {
  test.setTimeout(120000);

  test.beforeEach(async ({ page }) => {
    await setupFreshUser(page);
    await navigateToPublicFolder(page);
  });

  test('should display README.md content when opened', async ({ page }) => {
    // Create tree with README
    await createAndEnterTree(page, 'readme-test');
    await createFile(page, 'README.md', '# Hello World\n\nThis is a test readme.');

    await openReadmeFile(page, 'readme-test');
    await expect(page.locator('text=Hello World')).toBeVisible();
    await expect(page.locator('text=This is a test readme')).toBeVisible();
  });

  test('should have edit button for README when user can edit', async ({ page }) => {
    // Create tree with README
    await createAndEnterTree(page, 'readme-edit-test');
    await createFile(page, 'README.md', '# Editable');

    await openReadmeFile(page, 'readme-edit-test');
    await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();
  });

  test('should navigate relative links within the tree', async ({ page }) => {
    // Create tree with a subdirectory and README linking to it
    await createAndEnterTree(page, 'link-test');

    // Create a subdir with its own README
    await page.getByRole('button', { name: 'Folder' }).click();
    await page.locator('input[placeholder="Folder name..."]').fill('subdir');
    await page.getByRole('button', { name: 'Create' }).click();
    const subdirLink = page.locator('a:has-text("subdir")').first();
    await expect(subdirLink).toBeVisible({ timeout: 10000 });
    await subdirLink.click();
    await expect(page.getByRole('button', { name: /File/ }).first()).toBeVisible({ timeout: 10000 });

    // Create README in subdir
    await createFile(page, 'README.md', '# Subdir Docs\n\nThis is the subdir readme.');

    // Go back to parent
    await page.getByRole('link', { name: '..' }).click();
    await expect(page.getByRole('button', { name: /File/ }).first()).toBeVisible({ timeout: 10000 });

    // Create root README with relative link
    await createFile(page, 'README.md', '# Main\n\nSee [subdir docs](subdir/README.md) for more.');

    await openReadmeFile(page, 'link-test');

    // Click the relative link in the README
    await page.locator('.prose a:has-text("subdir docs")').click();

    // Should navigate to the subdir README file
    await expect(page).toHaveURL(/#.*link-test.*subdir.*README\.md/);
  });

  test('should wrap long inline markdown tokens without horizontal overflow', async ({ page }) => {
    await createAndEnterTree(page, 'readme-wrap-test');
    await createFile(
      page,
      'README.md',
      `# Wrap Test

> \`htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/${'iris-client-'.repeat(18)}\`
`
    );

    await openReadmeFile(page, 'readme-wrap-test');
    await expect(page.locator('text=Wrap Test')).toBeVisible();

    const wrapState = await page.locator('.markdown-content').first().evaluate((node) => {
      const container = node as HTMLElement;
      const code = container.querySelector('blockquote code') as HTMLElement | null;
      const containerRect = container.getBoundingClientRect();
      const codeRect = code?.getBoundingClientRect();
      return {
        hasOverflow: container.scrollWidth > container.clientWidth + 1,
        codeRight: codeRect?.right ?? 0,
        containerRight: containerRect.right,
      };
    });

    expect(wrapState.hasOverflow).toBe(false);
    expect(wrapState.codeRight).toBeLessThanOrEqual(wrapState.containerRight + 1);
  });

  test('should constrain wide markdown images to the README container', async ({ page }) => {
    await createAndEnterTree(page, 'readme-image-size-test');

    await page.evaluate(async () => {
      const { getTree, LinkType } = await import('/src/store.ts');
      const { autosaveIfOwn } = await import('/src/nostr.ts');
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const route = getRouteSync();
      const tree = getTree();
      let rootCid = getCurrentRootCid();
      if (!rootCid) throw new Error('Missing root CID for README image sizing test');

      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2200" height="1000" viewBox="0 0 2200 1000"><rect width="2200" height="1000" fill="#203044"/><circle cx="640" cy="500" r="310" fill="#47d16c"/><rect x="1120" y="260" width="760" height="480" rx="42" fill="#d84aa0"/></svg>';
      const svgContent = new TextEncoder().encode(svg);
      const { cid: svgCid, size: svgSize } = await tree.putFile(svgContent);
      rootCid = await tree.setEntry(rootCid, route.path, 'wide-preview.svg', svgCid, svgSize, LinkType.Blob);

      const readmeContent = new TextEncoder().encode('# Image Size\n\n![wide preview](wide-preview.svg)');
      const { cid: readmeCid, size: readmeSize } = await tree.putFile(readmeContent);
      rootCid = await tree.setEntry(rootCid, route.path, 'README.md', readmeCid, readmeSize, LinkType.Blob);

      autosaveIfOwn(rootCid);
    });

    await waitForCurrentDirectoryEntries(page, ['wide-preview.svg', 'README.md'], 15000);
    await expect.poll(() => page.evaluate(async () => {
      const { getCurrentRootCid } = await import('/src/actions/route.ts');
      const { getWorkerAdapter } = await import('/src/workerAdapter.ts');
      const { getRouteSync } = await import('/src/stores/index.ts');
      const toHex = (value: Uint8Array) => Array.from(
        value,
        (byte) => byte.toString(16).padStart(2, '0'),
      ).join('');
      const route = getRouteSync();
      const mainRoot = getCurrentRootCid();
      const workerRoot = route.npub && route.treeName
        ? await getWorkerAdapter()?.getTreeRootInfo?.(route.npub, route.treeName)
        : null;
      return !!mainRoot && !!workerRoot && toHex(mainRoot.hash) === toHex(workerRoot.hash);
    }), { timeout: 15000 }).toBe(true);

    await openReadmeFile(page, 'readme-image-size-test');

    const image = page.locator('.markdown-content img[alt="wide preview"]').first();
    await expect(image).toBeVisible({ timeout: 30000 });
    await page.waitForFunction(() => {
      const img = document.querySelector('.markdown-content img[alt="wide preview"]') as HTMLImageElement | null;
      return Boolean(img?.complete && img.naturalWidth > 0);
    });

    const imageState = await image.evaluate((img) => {
      const imageEl = img as HTMLImageElement;
      const container = imageEl.closest('.markdown-content') as HTMLElement | null;
      const imageRect = imageEl.getBoundingClientRect();
      const containerRect = container?.getBoundingClientRect();

      return {
        naturalWidth: imageEl.naturalWidth,
        imageWidth: imageRect.width,
        containerWidth: containerRect?.width ?? 0,
        hasOverflow: container ? container.scrollWidth > container.clientWidth + 1 : true,
      };
    });

    expect(imageState.naturalWidth).toBe(2200);
    expect(imageState.hasOverflow).toBe(false);
    expect(imageState.imageWidth).toBeLessThanOrEqual(imageState.containerWidth + 1);
    expect(imageState.imageWidth).toBeLessThanOrEqual(960 + 1);

    const noClientKeyFetch = await image.evaluate(async (img) => {
      const src = (img as HTMLImageElement).getAttribute('src') || '';
      const url = new URL(src, window.location.href);
      url.searchParams.delete('htree_c');
      const response = await fetch(url.toString(), { cache: 'no-store' });
      return {
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        byteLength: (await response.arrayBuffer()).byteLength,
      };
    });

    expect(noClientKeyFetch.status).toBe(200);
    expect(noClientKeyFetch.contentType).toContain('image/svg+xml');
    expect(noClientKeyFetch.byteLength).toBeGreaterThan(100);
  });

  test('should style inline code, links, quotes, and fenced code distinctly', async ({ page }) => {
    await createAndEnterTree(page, 'readme-style-test');
    await createFile(
      page,
      'README.md',
      `# Style Test

Read the [guide](docs/guide.md) and run \`htree add dist --publish site_name\`.

> Quote with \`inline code\` should still stand out.

\`\`\`bash
echo hello
\`\`\`
`
    );

    await openReadmeFile(page, 'readme-style-test');
    await expect(page.locator('text=Style Test')).toBeVisible();

    const styleState = await page.locator('.markdown-content').first().evaluate((node) => {
      const container = node as HTMLElement;
      const inlineCode = container.querySelector('p code') as HTMLElement | null;
      const link = container.querySelector('p a') as HTMLAnchorElement | null;
      const paragraph = link?.closest('p') as HTMLElement | null;
      const blockquote = container.querySelector('blockquote') as HTMLElement | null;
      const toolbar = container.querySelector('.markdown-code-toolbar') as HTMLElement | null;
      const language = container.querySelector('.markdown-code-language') as HTMLElement | null;
      const inlineCodeStyle = inlineCode ? getComputedStyle(inlineCode) : null;
      const linkStyle = link ? getComputedStyle(link) : null;
      const paragraphStyle = paragraph ? getComputedStyle(paragraph) : null;
      const blockquoteStyle = blockquote ? getComputedStyle(blockquote) : null;

      return {
        inlineCodeBefore: inlineCode ? getComputedStyle(inlineCode, '::before').content : '',
        inlineCodeAfter: inlineCode ? getComputedStyle(inlineCode, '::after').content : '',
        inlineCodeBackground: inlineCodeStyle?.backgroundColor ?? '',
        inlineCodeBorderTopWidth: inlineCodeStyle?.borderTopWidth ?? '0px',
        inlineCodeFontFamily: inlineCodeStyle?.fontFamily ?? '',
        linkColor: linkStyle?.color ?? '',
        paragraphColor: paragraphStyle?.color ?? '',
        linkDecoration: linkStyle?.textDecorationLine ?? '',
        blockquoteBorderLeftWidth: blockquoteStyle?.borderLeftWidth ?? '0px',
        blockquoteBackground: blockquoteStyle?.backgroundColor ?? '',
        hasCodeToolbar: Boolean(toolbar),
        languageLabel: language?.textContent?.trim() ?? '',
      };
    });

    expect(styleState.inlineCodeBefore).not.toContain('`');
    expect(styleState.inlineCodeAfter).not.toContain('`');
    expect(styleState.inlineCodeBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(Number.parseFloat(styleState.inlineCodeBorderTopWidth)).toBeGreaterThan(0);
    expect(styleState.inlineCodeFontFamily.toLowerCase()).toContain('mono');
    expect(styleState.linkDecoration).toContain('underline');
    expect(styleState.linkColor).not.toBe(styleState.paragraphColor);
    expect(Number.parseFloat(styleState.blockquoteBorderLeftWidth)).toBeGreaterThan(0);
    expect(styleState.blockquoteBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(styleState.hasCodeToolbar).toBe(true);
    expect(styleState.languageLabel.toLowerCase()).toBe('bash');
  });

  test('should copy fenced command blocks from README.md', async ({ page }) => {
    const installCommand = 'curl -fsSL https://upload.iris.to/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/releases%2Fhashtree/latest/install.sh | sh';

    await createAndEnterTree(page, 'readme-copy-test');
    await createFile(
      page,
      'README.md',
      `# Install

\`\`\`bash
${installCommand}
\`\`\`
`
    );

    await openReadmeFile(page, 'readme-copy-test');
    const copyButton = page.locator('.markdown-content').first().getByRole('button', { name: 'Copy code' });
    await expect(copyButton).toBeVisible();

    await copyButton.click();

    await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText())).toBe(installCommand);
    await expect(copyButton).toContainText('Copied');
  });
});
