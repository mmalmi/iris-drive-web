import { expect, test } from './fixtures';
import { getPublicKey, nip19 } from 'nostr-tools';
import { setupPageErrorHandler, waitForAppReady } from './test-utils.js';
import { BOOTSTRAP_SECKEY, FOLLOW_SECKEY } from './nostr-test-keys';

// Making a profile and recovering one from the setup page is in drive-setup.
const accounts = [
  { key: BOOTSTRAP_SECKEY, id: '019ed693-4110-7352-8cc3-be90158ba91e', addedAt: 1 },
  { key: FOLLOW_SECKEY, id: '019ed693-4110-7352-8cc3-be90158ba92f', addedAt: 2 },
].map(({ key, id, addedAt }) => ({
  pubkey: getPublicKey(key),
  npub: nip19.npubEncode(getPublicKey(key)),
  type: 'drive_profile',
  nsec: nip19.nsecEncode(key),
  nostrIdentityId: id,
  addedAt,
}));

test.describe('the Users page', () => {
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await page.evaluate((stored) => {
      localStorage.setItem('hashtree:accounts', JSON.stringify(stored));
      localStorage.setItem('hashtree:activeAccount', stored[0].pubkey);
      localStorage.setItem('hashtree:loginType', 'nsec');
      localStorage.setItem('hashtree:nsec', stored[0].nsec);
      localStorage.removeItem('iris:identity:session');
      localStorage.removeItem('iris:identity:sessions');
    }, accounts);
    await page.goto('/#/users');
    await page.reload();
    await waitForAppReady(page);
  });

  test('lists the stored users by name with a picture, switches between them, and goes back', async ({ page }) => {
    const rows = page.getByTestId('account-item');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toContainText('Electric Fountain');
    await expect(rows.nth(1)).toContainText('Verdant Field');
    for (const row of await rows.all()) {
      await expect(row.locator('img, svg').first()).toBeVisible();
      await expect(row).not.toContainText('019ed693');
    }

    await rows.nth(1).getByRole('button').first().click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('hashtree:activeAccount'))).toBe(accounts[1].pubkey);

    await page.goto('/#/users');
    await page.locator('button:has(span.i-lucide-chevron-left)').click();
    await expect(page).not.toHaveURL(/users/);
  });

  test('signing in offers the recovery methods one under another, and goes back to the first choices', async ({ page }) => {
    await expect(page.getByTestId('identity-recovery-section')).toHaveCount(0);
    await page.getByTestId('add-existing-profile').click();
    await expect(page).toHaveURL(/#\/users\/existing/);
    await expect(page.getByTestId('identity-recovery-section')).toBeVisible();
    await expect(page.getByTestId('generate-new-account')).toHaveCount(0);
    await expect(page.locator('input[placeholder="nsec1..."]')).toHaveCount(0);

    const phrase = await page.getByRole('button', { name: 'Recovery phrase' }).boundingBox();
    const secret = await page.getByRole('button', { name: 'Secret key' }).boundingBox();
    expect(Math.abs(phrase!.x - secret!.x)).toBeLessThan(2);
    expect(secret!.y).toBeGreaterThan(phrase!.y);

    await page.getByRole('button', { name: 'Secret key' }).click();
    await expect(page.getByRole('button', { name: 'Recovery phrase' })).toHaveCount(0);
    await expect(page.locator('input[placeholder="nsec1..."]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();

    await page.getByTestId('back-to-profile-actions').click();
    await expect(page).toHaveURL(/#\/users$/);
    await expect(page.getByTestId('identity-recovery-section')).toHaveCount(0);
    await expect(page.getByTestId('add-existing-profile')).toBeVisible();
  });
});
