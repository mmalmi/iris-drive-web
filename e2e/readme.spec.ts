import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createAndEnterFolder, createTextFile, openFileMenu, uploadIntoFolder } from './test-utils';

const INSTALL = 'curl -fsSL https://upload.iris.to/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/releases%2Fhashtree/latest/install.sh | sh';
const LONG_TOKEN = `htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/${'iris-client-'.repeat(18)}`;
const README = `# Main

See [subdir docs](subdir/README.md) and run \`htree add dist --publish site_name\`.

> Quote with \`${LONG_TOKEN}\`

![wide preview](wide.svg)

\`\`\`bash
${INSTALL}
\`\`\`
`;
const WIDE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="2200" height="1000" viewBox="0 0 2200 1000"><rect width="2200" height="1000" fill="#203044"/><circle cx="640" cy="500" r="310" fill="#47d16c"/></svg>';

function openFile(page: Page, name: string) {
  return page.getByTestId('file-list').getByRole('link', { name: new RegExp(`^${name.replace('.', '\\.')}`) }).dblclick();
}

test.describe('markdown files', () => {
  test.setTimeout(150_000);
  test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

  test('a README renders links, code, quotes and pictures within its width, copies code, and links to its neighbours', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Readme Test');
    await createAndEnterFolder(page, 'docs');
    await createAndEnterFolder(page, 'subdir');
    await createTextFile(page, 'README.md', '# Subdir Docs');
    await page.getByRole('navigation', { name: 'Folder path' }).getByRole('link', { name: 'docs' }).click();
    await uploadIntoFolder(page, { name: 'wide.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(WIDE_SVG) });
    await createTextFile(page, 'README.md', README);
    await openFile(page, 'README.md');

    const markdown = page.locator('.markdown-content').first();
    await expect(markdown.getByRole('heading', { name: 'Main' })).toBeVisible({ timeout: 30_000 });
    await expect((await openFileMenu(page)).getByTestId('viewer-edit')).toBeVisible();
    await page.keyboard.press('Escape');

    // Inline code, links and quotes stand out from the text; a long token wraps.
    const looks = await markdown.evaluate((container) => {
      const style = (selector: string, pseudo?: string) => getComputedStyle(container.querySelector(selector)!, pseudo);
      return {
        codeBefore: style('p code', '::before').content,
        codeBackground: style('p code').backgroundColor,
        codeFont: style('p code').fontFamily.toLowerCase(),
        linkColor: style('p a').color,
        textColor: style('p').color,
        linkLine: style('p a').textDecorationLine,
        quoteBorder: Number.parseFloat(style('blockquote').borderLeftWidth),
        overflow: container.scrollWidth - container.clientWidth,
        language: container.querySelector('.markdown-code-language')?.textContent?.trim().toLowerCase(),
      };
    });
    expect(looks.codeBefore).not.toContain('`');
    expect(looks.codeBackground).not.toBe('rgba(0, 0, 0, 0)');
    expect(looks.codeFont).toContain('mono');
    expect(looks.linkColor).not.toBe(looks.textColor);
    expect(looks.linkLine).toContain('underline');
    expect(looks.quoteBorder).toBeGreaterThan(0);
    expect(looks.overflow).toBeLessThanOrEqual(1);
    expect(looks.language).toBe('bash');

    // A wide picture beside the README is loaded and fits its width.
    const picture = markdown.locator('img[alt="wide preview"]');
    await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 30_000 }).toBe(2200);
    const fits = await picture.evaluate((img) => img.getBoundingClientRect().width <= img.closest('.markdown-content')!.clientWidth + 1);
    expect(fits).toBe(true);
    // The app's own address serves it even without this page's client key.
    const served = await picture.evaluate(async (img: HTMLImageElement) => {
      const url = new URL(img.src);
      url.searchParams.delete('htree_c');
      const response = await fetch(url, { cache: 'no-store' });
      return { status: response.status, type: response.headers.get('content-type') ?? '' };
    });
    expect(served.status).toBe(200);
    expect(served.type).toContain('image/svg+xml');

    await markdown.getByRole('button', { name: 'Copy code' }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(INSTALL);

    await markdown.getByRole('link', { name: 'subdir docs' }).click();
    await expect(page).toHaveURL(/\/docs\/subdir\/README\.md$/);
    await expect(page.locator('.markdown-content').getByRole('heading', { name: 'Subdir Docs' })).toBeVisible({ timeout: 30_000 });
  });
});
