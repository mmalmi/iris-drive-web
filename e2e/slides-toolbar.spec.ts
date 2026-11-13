import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createPresentation, elements, sheet, shot } from './slides.helpers';

/** Whether the row of tools holds all its buttons without scrolling. */
async function fits(page: Page): Promise<{ fits: boolean; scroll: number; width: number }> {
  return page.getByTestId('slides-toolbar').evaluate(node => ({
    fits: node.scrollWidth <= node.clientWidth + 1,
    scroll: node.scrollWidth,
    width: node.clientWidth,
  }));
}

test.describe('the row of tools on a laptop', () => {
  test.setTimeout(180_000);
  test.use({ viewport: { width: 1280, height: 800 } });

  test('with text or a table being edited, every tool stays on the row, and the slide\'s own tools fold into one', async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createPresentation(page, 'Crowded row');
    expect((await fits(page)).fits).toBe(true);
    await expect(page.getByTestId('deck-theme')).toBeVisible();

    // Typing in the title: the text tools join the row.
    await elements(page, 'text').first().click();
    await expect(sheet(page).locator('.ProseMirror')).toBeFocused();
    expect(await fits(page)).toMatchObject({ fits: true });
    await shot(page, 'toolbar-01-text');

    // Typing in a table: text and table tools at once.
    await page.keyboard.press('Escape');
    await page.getByTestId('new-slide-layout').click();
    await page.getByTestId('layout-blank').click();
    await page.getByTestId('add-table').click();
    await page.getByTestId('table-3x3').click();
    await expect(sheet(page).locator('.ProseMirror')).toBeFocused();
    expect(await fits(page)).toMatchObject({ fits: true });
    await expect(page.getByTestId('cell-fill')).toBeVisible();
    await expect(page.getByTestId('slide-options')).toBeVisible();
    await expect(page.getByTestId('deck-theme')).toBeHidden();
    await shot(page, 'toolbar-02-table');

    // The folded button still reaches every menu of the slide.
    await page.getByTestId('slide-options').click();
    await page.getByTestId('slide-options-theme').click();
    await expect(page.getByTestId('theme-dark')).toBeVisible();
    const menu = (await page.locator('[data-slides-popover]').boundingBox())!;
    const button = (await page.getByTestId('slide-options').boundingBox())!;
    expect(Math.abs(menu.y - (button.y + button.height + 6))).toBeLessThan(4);
    await page.getByTestId('theme-dark').click();
    await expect(sheet(page).locator('.slide-surface')).toHaveCSS('background-color', 'rgb(19, 20, 24)');
  });
});
