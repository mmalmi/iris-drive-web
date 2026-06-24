import { test, expect } from './fixtures';
import { getPublicKey, nip19 } from 'nostr-tools';
import { BOOTSTRAP_SECKEY, FOLLOW_SECKEY } from './nostr-test-keys';

const driveIdentityAccounts = [
  {
    pubkey: getPublicKey(BOOTSTRAP_SECKEY),
    npub: nip19.npubEncode(getPublicKey(BOOTSTRAP_SECKEY)),
    type: 'drive_profile',
    nsec: nip19.nsecEncode(BOOTSTRAP_SECKEY),
    irisProfileId: '019ed693-4110-7352-8cc3-be90158ba91e',
    addedAt: 1,
  },
  {
    pubkey: getPublicKey(FOLLOW_SECKEY),
    npub: nip19.npubEncode(getPublicKey(FOLLOW_SECKEY)),
    type: 'drive_profile',
    nsec: nip19.nsecEncode(FOLLOW_SECKEY),
    irisProfileId: '019ed693-4110-7352-8cc3-be90158ba92f',
    addedAt: 2,
  },
];

test.describe('Users Page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for page to load
    await page.waitForTimeout(500);
  });

  // Helper to close any open modals
  async function closeModals(page) {
    const cancelButton = page.getByRole('button', { name: 'Cancel' });
    if (await cancelButton.isVisible({ timeout: 500 }).catch(() => false)) {
      await cancelButton.click();
      await page.waitForTimeout(200);
    }
  }

  test('should show Create new button on users page', async ({ page }) => {
    // First login to be able to access users page
    await page.getByRole('button', { name: /New/i }).click();
    await page.waitForTimeout(1000);

    // Navigate to users page via double-click or URL
    await page.goto('/#/users');
    await page.waitForTimeout(500);

    // Should see the first-view actions
    await expect(page.getByTestId('generate-new-account')).toBeVisible();
    await expect(page.getByTestId('generate-new-account')).toHaveText(/Create new/);
    await expect(page.getByTestId('add-existing-profile')).toBeVisible();
    await expect(page.getByTestId('add-existing-profile')).toHaveText(/Add existing/);
    await expect(page.getByTestId('identity-recovery-section')).toHaveCount(0);
  });

  test('should show Drive recovery options on users page', async ({ page }) => {
    // First login
    await page.getByRole('button', { name: /New/i }).click();
    await page.waitForTimeout(1000);

    // Navigate to users page
    await page.goto('/#/users');
    await page.waitForTimeout(500);
    await closeModals(page);

    await expect(page.getByTestId('identity-recovery-section')).toHaveCount(0);
    await page.getByTestId('add-existing-profile').click();
    await expect(page).toHaveURL(/#\/users\/existing/);

    await expect(page.getByTestId('identity-recovery-section')).toBeVisible();
    await expect(page.getByTestId('account-item')).toHaveCount(0);
    await expect(page.getByTestId('generate-new-account')).toHaveCount(0);
    await expect(page.getByTestId('add-existing-profile')).toHaveCount(0);
    await expect(page.getByTestId('recovery-profile-id')).toHaveCount(0);
    await expect(page.locator('input[placeholder="nsec1..."]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Browser extension' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Seed phrase' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Link device' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Secret key' })).toBeVisible();
    const methodButtons = [
      page.getByRole('button', { name: 'Seed phrase' }),
      page.getByRole('button', { name: 'Link device' }),
      page.getByRole('button', { name: 'Secret key' }),
    ];
    const methodBoxes = await Promise.all(methodButtons.map((button) => button.boundingBox()));
    for (const box of methodBoxes) {
      expect(box).not.toBeNull();
    }
    const firstMethodBox = methodBoxes[0]!;
    for (let index = 1; index < methodBoxes.length; index += 1) {
      expect(Math.abs(methodBoxes[index]!.x - firstMethodBox.x)).toBeLessThan(2);
      expect(methodBoxes[index]!.y).toBeGreaterThan(methodBoxes[index - 1]!.y);
    }
    await page.getByRole('button', { name: 'Secret key' }).click();
    await expect(page.getByRole('button', { name: 'Seed phrase' })).toHaveCount(0);
    await expect(page.locator('input[placeholder="nsec1..."]')).toBeVisible();

    await page.getByTestId('back-to-profile-actions').click();
    await expect(page).toHaveURL(/#\/users$/);
    await expect(page.getByTestId('identity-recovery-section')).toHaveCount(0);
    await expect(page.getByTestId('add-existing-profile')).toBeVisible();
  });

  test('should create Drive profile when clicking Create new', async ({ page }) => {
    // First login
    await page.getByRole('button', { name: /New/i }).click();
    await page.waitForTimeout(1500);
    await closeModals(page);

    // Navigate to users page
    await page.goto('/#/users');
    await page.waitForTimeout(500);
    await closeModals(page);

    // Click Create new
    await page.getByTestId('generate-new-account').click();

    await expect(page).toHaveURL(/\/main/, { timeout: 10000 });
  });

  test('should show account list with avatar and name', async ({ page }) => {
    // First login
    await page.getByRole('button', { name: /New/i }).click();
    await page.waitForTimeout(1500);
    await closeModals(page);

    // Navigate to users page
    await page.goto('/#/users');
    await page.waitForTimeout(500);

    // Should see account cards
    const accountCard = page.getByTestId('account-item').first();
    await expect(accountCard).toBeVisible();

    // Should have avatar (img or svg)
    const avatar = accountCard.locator('img, svg').first();
    await expect(avatar).toBeVisible();
  });

  test('should allow switching between stored Drive identities', async ({ page }) => {
    await page.evaluate(({ accounts }) => {
      localStorage.setItem('hashtree:accounts', JSON.stringify(accounts));
      localStorage.setItem('hashtree:activeAccount', accounts[0].pubkey);
      localStorage.setItem('hashtree:loginType', 'nsec');
      localStorage.setItem('hashtree:nsec', accounts[0].nsec);
      localStorage.removeItem('iris:identity:session');
      localStorage.removeItem('iris:identity:sessions');
    }, { accounts: driveIdentityAccounts });

    await page.goto('/#/users');
    await page.reload();
    await page.waitForTimeout(500);

    const accountItems = page.getByTestId('account-item');
    await expect(accountItems).toHaveCount(2);
    await expect(accountItems.first()).toContainText('Electric Fountain');
    await expect(accountItems.nth(1)).toContainText('Verdant Field');
    await expect(accountItems.first()).not.toContainText('019ed693');
    await expect(accountItems.nth(1)).not.toContainText('019ed693');

    await accountItems.nth(1).click();
    await page.waitForTimeout(500);

    await expect(page.getByTestId('account-item')).toHaveCount(2);
  });

  test('should show recovery nsec input without legacy nsec add flow', async ({ page }) => {
    // First login
    await page.getByRole('button', { name: /New/i }).click();
    await page.waitForTimeout(1500);
    await closeModals(page);

    // Navigate to users page
    await page.goto('/#/users');
    await page.waitForTimeout(500);
    await closeModals(page);

    await expect(page.getByTestId('add-with-nsec')).toHaveCount(0);
    await expect(page.locator('input[placeholder="nsec1..."]')).toHaveCount(0);
    await page.getByTestId('add-existing-profile').click();
    await expect(page).toHaveURL(/#\/users\/existing/);
    await expect(page.locator('input[placeholder="nsec1..."]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Secret key' }).click();
    await expect(page.locator('input[placeholder="nsec1..."]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Recover app key' })).toBeVisible();
  });

  test('should navigate back to home when clicking Back button', async ({ page }) => {
    // First login
    await page.getByRole('button', { name: /New/i }).click();
    await page.waitForTimeout(1500);
    await closeModals(page);

    // Navigate to users page
    await page.goto('/#/users');
    await page.waitForTimeout(500);
    await closeModals(page);

    // Click Back button (chevron-left icon)
    await page.locator('button:has(span.i-lucide-chevron-left)').click();
    await page.waitForTimeout(500);

    // Should be back at home
    expect(page.url()).toContain('#/');
    expect(page.url()).not.toContain('users');
  });
});
