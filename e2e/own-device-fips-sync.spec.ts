/**
 * The account's devices pass Drive's own events to each other over the FIPS
 * nostr-pubsub feed, so roots still arrive when relays stop answering, and a
 * device that was away catches up through Negentropy when it comes back.
 */
import { expect, type Page } from './fixtures';
import { fipsState, fipsTest as test, linkBrowserDevice } from './fips-devices';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { createFolder, expectFolderEditable, waitForAppReady } from './test-utils';

async function prepare(page: Page, relayUrl: string, seedUrl: string): Promise<void> {
  await page.addInitScript((url: string) => {
    (window as typeof window & { __testFipsWebSocketSeedUrls?: string[] }).__testFipsWebSocketSeedUrls = [url];
  }, seedUrl);
  await prepareFreshSession(page, relayUrl);
}

/** The test relay stops answering anything in this test's namespace. */
async function silenceRelay(relayUrl: string): Promise<void> {
  const url = new URL(relayUrl);
  const response = await fetch(`http://${url.host}/__silence?ns=${encodeURIComponent(url.pathname)}`);
  expect(response.ok).toBe(true);
}

async function appKey(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { getCurrentNostrIdentitySession } = await import('/src/nostr');
    const session = getCurrentNostrIdentitySession();
    if (!session) throw new Error('No Drive session');
    return session.appKeyPubkey;
  });
}

async function openMyDrive(page: Page, profileId: string): Promise<void> {
  await page.goto(`/#/${profileId}/main`, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page, 60_000);
  await expectFolderEditable(page);
}

/** Both devices hold each other as event peers on the FIPS feed. */
async function expectEventPeers(first: Page, firstKey: string, second: Page, secondKey: string): Promise<void> {
  await expect.poll(async () => {
    const [firstState, secondState] = await Promise.all([fipsState(first), fipsState(second)]);
    return [
      firstState.nostrPeerIds.some((peerId) => peerId.slice(2) === secondKey),
      secondState.nostrPeerIds.some((peerId) => peerId.slice(2) === firstKey),
    ];
  }, { timeout: 90_000, intervals: [500, 1_000, 2_000] }).toEqual([true, true]);
}

function folderLink(page: Page, name: string) {
  return page.getByTestId('file-list').getByRole('link', { name, exact: true });
}

test('linked browsers exchange Drive roots over FIPS while relays are silent', async ({
  browser,
  page: ownerPage,
  relayUrl,
  fipsSeedUrl,
}) => {
  test.setTimeout(360_000);
  await prepare(ownerPage, relayUrl, fipsSeedUrl);
  const owner = await createDriveProfile(ownerPage, 'FIPS sync owner');
  await expectFolderEditable(ownerPage);
  const ownerKey = await appKey(ownerPage);

  const deviceContext = await browser.newContext();
  try {
    let devicePage = await deviceContext.newPage();
    await prepare(devicePage, relayUrl, fipsSeedUrl);
    const device = await linkBrowserDevice(ownerPage, devicePage);
    expect(device.profileId).toBe(owner.profileId);
    await openMyDrive(devicePage, owner.profileId);
    await expectEventPeers(ownerPage, ownerKey, devicePage, device.appKeyPubkey);

    await silenceRelay(relayUrl);
    const live = `Live over FIPS ${crypto.randomUUID().slice(0, 8)}`;
    await createFolder(ownerPage, live);
    await expect(folderLink(devicePage, live)).toBeVisible({ timeout: 60_000 });

    // The device is away while the owner changes the Drive. When it comes
    // back, still without relays, it catches up from the owner through
    // Negentropy on the feed.
    await devicePage.close();
    await ownerPage.evaluate(async () => {
      const { recordFeedSyncFrames } = await import('/e2e/drive-peer-test-helpers.ts');
      (window as typeof window & { __feedSync?: unknown }).__feedSync = recordFeedSyncFrames();
    });
    const away = `Made while away ${crypto.randomUUID().slice(0, 8)}`;
    await createFolder(ownerPage, away);
    await expect(folderLink(ownerPage, away)).toBeVisible({ timeout: 30_000 });
    devicePage = await deviceContext.newPage();
    await devicePage.addInitScript((url: string) => {
      (window as typeof window & { __testFipsWebSocketSeedUrls?: string[] }).__testFipsWebSocketSeedUrls = [url];
    }, fipsSeedUrl);
    await openMyDrive(devicePage, owner.profileId);
    await expect(folderLink(devicePage, live)).toBeVisible({ timeout: 30_000 });
    await expectEventPeers(ownerPage, ownerKey, devicePage, device.appKeyPubkey);
    await expect(folderLink(devicePage, away)).toBeVisible({ timeout: 60_000 });
    const frames = await ownerPage.evaluate(() => (
      window as typeof window & { __feedSync?: { sent: string[]; received: string[] } }
    ).__feedSync!);
    // The owner opened a Negentropy session for the device's feed request and
    // the device answered it.
    expect(frames.sent).toContain('open');
    expect(frames.received).toContain('reply');

    // And the other way: the device's change reaches the owner.
    const back = `From the device ${crypto.randomUUID().slice(0, 8)}`;
    await createFolder(devicePage, back);
    await expect(folderLink(ownerPage, back)).toBeVisible({ timeout: 60_000 });
  } finally {
    await deviceContext.close();
  }
});
