import { expect, type Page } from './fixtures';
import {
  clearAllStorage,
  configureBlossomServers,
  presetLocalRelayInDB,
  setupPageErrorHandler,
  useLocalRelay,
  waitForAppReady,
  waitForRelayConnected,
} from './test-utils';

export async function prepareFreshSession(page: Page, relayUrl: string): Promise<void> {
  setupPageErrorHandler(page);
  page.on('console', (message) => {
    if (message.type() === 'error' && message.text().includes('[Document]')) console.log('browser:', message.text().slice(0, 400));
  });
  await page.addInitScript(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await clearAllStorage(page);
  await page.evaluate(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
  });
  await presetLocalRelayInDB(page, relayUrl);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60_000);
  await useLocalRelay(page, relayUrl);
  await configureBlossomServers(page);
  await waitForRelayConnected(page, 30_000);
}

export async function createDriveProfile(page: Page, name = 'Document Test'): Promise<{ profileId: string; npub: string }> {
  await expect(page.getByTestId('drive-setup')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('generate-new-account').click();
  await expect(page.getByTestId('identity-create-name')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('identity-create-name').fill(name);
  await page.getByTestId('create-new-after-recovery-miss').click();
  const identity = await page.waitForFunction(() => {
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    const npub = (window as unknown as {
      __nostrStore?: { getState?: () => { npub?: string } };
    }).__nostrStore?.getState?.().npub;
    return stored?.status === 'active' && stored.profileId && npub
      ? { profileId: stored.profileId as string, npub }
      : null;
  }, undefined, { timeout: 30_000 });
  return await identity.jsonValue() as { profileId: string; npub: string };
}

/** Creates a document in the folder that is open and waits for its editor. */
export async function createDocument(page: Page, title: string): Promise<void> {
  await page.getByTestId('new-document').filter({ visible: true }).first().click();
  await page.getByPlaceholder('Document name...').fill(title);
  await page.getByPlaceholder('Document name...').press('Enter');
  await expect(page.getByTestId('document-title')).toHaveText(title, { timeout: 30_000 });
  await expect(documentBody(page)).toBeVisible({ timeout: 30_000 });
}

export function documentBody(page: Page) {
  return page.getByTestId('document-content').locator('.ProseMirror');
}

export async function typeInDocument(page: Page, text: string): Promise<void> {
  await documentBody(page).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(text);
}

export async function expectSaved(page: Page): Promise<void> {
  await expect(page.getByTestId('document-save-status')).toHaveText('Saved', { timeout: 30_000 });
}
