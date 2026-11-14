import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createTextFile } from './test-utils';

/** A new Drive with one text file written in it, open for viewing. */
async function openNewFile(page: Page, relayUrl: string, name: string, content: string): Promise<void> {
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Anchor Test');
  await createTextFile(page, name, content);
  await page.getByTestId('file-list').getByRole('link', { name: new RegExp(`^${name.replace('.', '\\.')}`) }).click();
}

test.describe('links into a file', () => {
  test.setTimeout(120_000);

  test('markdown headings get ids and an anchor that puts them in the address', async ({ page, relayUrl }) => {
    await openNewFile(page, relayUrl, 'notes.md', '# First Heading\n\nSome text.\n\n## Second Heading\n\n### Third-Level Heading\n\nMore.');
    const markdown = page.locator('.markdown-content');
    await expect(markdown.locator('#first-heading')).toBeVisible({ timeout: 30_000 });
    await expect(markdown.locator('#second-heading')).toBeVisible();
    await expect(markdown.locator('#third-level-heading')).toBeVisible();

    await markdown.locator('#second-heading').hover();
    await markdown.locator('#second-heading a.heading-anchor').click();
    await expect(page).toHaveURL(/[?&]anchor=second-heading/);
  });

  test('code lines are numbered and link to one line, to a range, and from the address', async ({ page, relayUrl }) => {
    const lines = Array.from({ length: 100 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');
    await openNewFile(page, relayUrl, 'long.ts', lines);
    const line = (n: number) => page.locator(`[data-line="${n}"]`);
    await expect(line(1)).toBeVisible({ timeout: 30_000 });

    // The number and the text of a line sit on one row.
    const row = await line(1).evaluate((el) => ({
      height: el.getBoundingClientRect().height,
      numberTop: el.querySelector('.line-number')!.getBoundingClientRect().top,
      textTop: el.querySelector('.line-content')!.getBoundingClientRect().top,
      text: el.querySelector('.line-content')!.textContent,
    }));
    expect(row.text).toBe('const line1 = 1;');
    expect(Math.abs(row.numberTop - row.textTop)).toBeLessThan(4);
    expect(row.height).toBeLessThan(40);

    await line(3).locator('.line-number').click();
    await expect(page).toHaveURL(/[?&]L=3($|&)/);
    await expect(line(3)).toHaveClass(/line-highlighted/);
    await line(5).locator('.line-number').click({ modifiers: ['Shift'] });
    await expect(page).toHaveURL(/[?&]L=3-5/);
    for (const n of [3, 4, 5]) await expect(line(n)).toHaveClass(/line-highlighted/);
    for (const n of [2, 6]) await expect(line(n)).not.toHaveClass(/line-highlighted/);

    // Opened from an address with a line, the line is highlighted and scrolled to.
    const address = page.url().replace(/\?.*$/, '?L=80');
    await page.goto(address);
    await page.reload();
    await expect(line(80)).toHaveClass(/line-highlighted/, { timeout: 30_000 });
    await expect(line(80)).toBeInViewport();
  });
});
