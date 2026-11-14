// Drive's places: a full sidebar on a wide window, a rail of icons on a
// narrower one, either one by choice, and tabs along the bottom of a phone.
// With PLACES_SHOTS set it saves screenshots.
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from './fixtures';
import { createDocument, createDriveProfile, prepareFreshSession } from './documents.helpers';

const shots = process.env.PLACES_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.mouse.move(1, 1);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

const sidebar = (page: Page) => page.getByTestId('drive-sidebar');
const toggle = (page: Page) => page.getByTestId('sidebar-toggle');

test.describe('places in Drive', () => {
  test.setTimeout(120_000);

  test('the sidebar is full on a wide window, a rail on a narrower one, and stays as chosen', async ({ page, relayUrl }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await expect(sidebar(page)).not.toHaveAttribute('data-rail');
    await expect(sidebar(page).getByRole('button', { name: 'New' })).toContainText('New');
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await shot(page, 'wide-full');

    await page.setViewportSize({ width: 1000, height: 800 });
    await expect(sidebar(page)).toHaveAttribute('data-rail', '');
    expect((await sidebar(page).boundingBox())!.width).toBeLessThanOrEqual(80);
    // Each place keeps a short name under its icon, and its full name for assistive tech.
    await expect(sidebar(page).getByRole('link', { name: 'Shared with me' })).toContainText('Shared');
    await shot(page, 'medium-rail');

    // New works from the rail.
    await sidebar(page).getByRole('button', { name: 'New' }).click();
    await expect(page.getByRole('menu', { name: 'New' })).toBeVisible();
    await page.keyboard.press('Escape');

    await sidebar(page).getByRole('link', { name: 'Recent' }).click();
    await expect(page).toHaveURL(/#\/recent$/);
    await expect(sidebar(page).getByRole('link', { name: 'Recent' })).toHaveAttribute('aria-current', 'page');

    // Chosen with the menu button, it stays so after a reload, whatever the width.
    await toggle(page).click();
    await expect(sidebar(page)).not.toHaveAttribute('data-rail');
    await page.reload();
    await expect(sidebar(page)).not.toHaveAttribute('data-rail');
    await page.setViewportSize({ width: 1280, height: 800 });
    await toggle(page).click();
    await expect(sidebar(page)).toHaveAttribute('data-rail', '');
    await page.reload();
    await expect(sidebar(page)).toHaveAttribute('data-rail', '');
    await shot(page, 'wide-rail-chosen');
  });

  test('a phone has tabs at the bottom, and an open document has the screen to itself', async ({ page, relayUrl }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page);
    const tabs = page.getByTestId('drive-tabs');
    await expect(tabs).toBeVisible();
    await expect(sidebar(page)).toBeHidden();
    await expect(toggle(page)).toBeHidden();
    const box = (await tabs.boundingBox())!;
    expect(Math.round(box.y + box.height)).toBe(844);
    await expect(tabs.getByRole('link', { name: 'My Drive' })).toHaveAttribute('aria-current', 'page');
    await shot(page, 'phone-tabs');

    await tabs.getByRole('link', { name: 'Shared with me' }).click();
    await expect(page).toHaveURL(/#\/shared-with-me$/);
    await expect(tabs.getByRole('link', { name: 'Shared with me' })).toHaveAttribute('aria-current', 'page');
    await tabs.getByRole('link', { name: 'My Drive' }).click();
    await expect(page).toHaveURL(new RegExp(`#/${profileId}/main$`));

    await createDocument(page, 'Phone notes');
    await expect(page.getByTestId('document-title')).toBeVisible({ timeout: 30_000 });
    await expect(tabs).toHaveCount(0);
  });
});
