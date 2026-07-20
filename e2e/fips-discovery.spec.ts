import { getPublicKey, nip19 } from 'nostr-tools';
import { expect, test } from './fixtures';
import { ensureLoggedIn, evaluateWithRetry, waitForAppReady, waitForWorkerAdapter } from './test-utils';

const FIRST_NOSTR_SECRET = new Uint8Array(32).fill(0x61);
const SECOND_NOSTR_SECRET = new Uint8Array(32).fill(0x62);
const SWITCHED_NOSTR_SECRET = new Uint8Array(32).fill(0x63);

async function fipsLinkState(page: import('@playwright/test').Page): Promise<{
  localPeerId: string;
  connectedPeerIds: string[];
}> {
  return page.evaluate(async () => {
    const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    const stats = getDriveFipsRuntime()?.getStats();
    return {
      localPeerId: stats?.localPeerId ?? '',
      connectedPeerIds: stats?.connectedPeerIds ?? [],
    };
  }).catch(() => ({ localPeerId: '', connectedPeerIds: [] }));
}

async function installNostrLogin(page: import('@playwright/test').Page, secret: Uint8Array): Promise<void> {
  const nsec = nip19.nsecEncode(secret);
  await page.addInitScript((value) => {
    localStorage.setItem('hashtree:loginType', 'nsec');
    localStorage.setItem('hashtree:nsec', value);
  }, nsec);
}

async function activateNostrLogin(
  page: import('@playwright/test').Page,
  secret: Uint8Array,
): Promise<void> {
  await evaluateWithRetry(page, async (nsec) => {
    const { loginWithNsec } = await import('/src/nostr/auth.ts');
    if (!await loginWithNsec(nsec)) throw new Error('Nostr login failed');
  }, nip19.nsecEncode(secret), 5);
}

test('Drive keeps its FIPS device identity across Nostr accounts and explicitly exchanges blocks', async ({
  browser,
  page,
}) => {
  test.slow();
  await installNostrLogin(page, FIRST_NOSTR_SECRET);
  await page.goto('/');
  await waitForAppReady(page);
  await ensureLoggedIn(page, 30_000);
  await activateNostrLogin(page, FIRST_NOSTR_SECRET);
  await waitForWorkerAdapter(page);

  const secondContext = await browser.newContext();
  const secondNsec = nip19.nsecEncode(SECOND_NOSTR_SECRET);
  await secondContext.addInitScript((value) => {
    localStorage.setItem('hashtree:loginType', 'nsec');
    localStorage.setItem('hashtree:nsec', value);
  }, secondNsec);
  const secondPage = await secondContext.newPage();
  await secondPage.goto('/');
  await waitForAppReady(secondPage);
  await ensureLoggedIn(secondPage, 30_000);
  await activateNostrLogin(secondPage, SECOND_NOSTR_SECRET);
  await waitForWorkerAdapter(secondPage);

  await expect.poll(async () => Promise.all(
    [page, secondPage].map(async (candidate) => (await fipsLinkState(candidate)).localPeerId),
  ), { timeout: 60_000 }).toEqual([
    expect.stringMatching(/^(02|03)[0-9a-f]{64}$/),
    expect.stringMatching(/^(02|03)[0-9a-f]{64}$/),
  ]);
  const [firstFipsPeerId, secondFipsPeerId] = await Promise.all(
    [page, secondPage].map(async (candidate) => (await fipsLinkState(candidate)).localPeerId),
  );
  await expect.poll(async () => Promise.all(
    [
      [page, secondFipsPeerId],
      [secondPage, firstFipsPeerId],
    ].map(async ([candidate, peerId]) => (
      await fipsLinkState(candidate as import('@playwright/test').Page)
    ).connectedPeerIds.includes(peerId as string)),
  ), { timeout: 60_000 }).toEqual([true, true]);

  await page.evaluate(async () => {
    const { settingsStore } = await import('/src/stores/settings.ts');
    const { refreshFipsStats } = await import('/src/store.ts');
    settingsStore.setPoolSettings({ showConnectivity: true });
    await refreshFipsStats();
  });
  const indicator = page.getByTestId('peer-indicator-dot');
  await expect(indicator).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => indicator.evaluate((element) => getComputedStyle(element).color), {
    timeout: 10_000,
  }).toBe('rgb(63, 185, 80)');

  await page.goto('/#/settings/network/p2p');
  await waitForAppReady(page);
  await expect(page.getByTestId('settings-fips-peers')).toContainText(/FIPS peers \([1-9]\d*\)/, {
    timeout: 10_000,
  });
  await expect.poll(() => page.getByTestId('settings-fips-peer').count(), { timeout: 10_000 })
    .toBeGreaterThan(0);
  const fipsPeerLabels = await page.getByTestId('settings-fips-peer').allTextContents();
  expect(fipsPeerLabels.every((label) => label.includes('FIPS device identity'))).toBe(true);
  expect(fipsPeerLabels.some((label) => label.includes('Follow'))).toBe(false);

  const initialIdentity = await page.evaluate(async () => {
    const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    return {
      fipsPeerId: getDriveFipsRuntime()?.getStats().localPeerId ?? '',
      nostrPubkey: (window as typeof window & {
        __nostrStore?: { getState(): { pubkey?: string } };
      }).__nostrStore?.getState().pubkey ?? '',
    };
  });
  expect(initialIdentity.fipsPeerId).toMatch(/^(02|03)[0-9a-f]{64}$/);
  expect(initialIdentity.nostrPubkey).toBe(getPublicKey(FIRST_NOSTR_SECRET));
  expect(initialIdentity.fipsPeerId.slice(2)).not.toBe(initialIdentity.nostrPubkey);

  await activateNostrLogin(page, SWITCHED_NOSTR_SECRET);
  await page.reload();
  await waitForAppReady(page);
  await ensureLoggedIn(page, 30_000);
  await waitForWorkerAdapter(page);
  await expect.poll(() => page.evaluate(async () => {
    const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    return {
      fipsPeerId: getDriveFipsRuntime()?.getStats().localPeerId ?? '',
      nostrPubkey: (window as typeof window & {
        __nostrStore?: { getState(): { pubkey?: string } };
      }).__nostrStore?.getState().pubkey ?? '',
    };
  }), { timeout: 30_000 }).toEqual({
    fipsPeerId: initialIdentity.fipsPeerId,
    nostrPubkey: getPublicKey(SWITCHED_NOSTR_SECRET),
  });
  await expect.poll(async () => Promise.all(
    [
      [page, secondFipsPeerId],
      [secondPage, firstFipsPeerId],
    ].map(async ([candidate, peerId]) => (
      await fipsLinkState(candidate as import('@playwright/test').Page)
    ).connectedPeerIds.includes(peerId as string)),
  ), { timeout: 60_000 }).toEqual([true, true]);

  const source = await page.evaluate(async () => {
    const adapter = (window as typeof window & {
      __getWorkerAdapter?: () => {
        put(hash: Uint8Array, data: Uint8Array): Promise<boolean>;
        webrtcProxy?: unknown;
      } | null;
    }).__getWorkerAdapter?.();
    if (!adapter) throw new Error('worker adapter is not ready');
    const text = `drive-fips-block-${crypto.randomUUID()}`;
    const data = new TextEncoder().encode(text);
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    if (!await adapter.put(hash, data)) throw new Error('failed to store source block');
    return {
      hashHex: Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(''),
      text,
      legacyProxyActive: adapter.webrtcProxy != null,
    };
  });
  expect(source.legacyProxyActive).toBe(false);

  const received = await evaluateWithRetry(secondPage, async ({ hashHex, peerId }) => {
    const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    const runtime = getDriveFipsRuntime();
    if (!runtime) throw new Error('FIPS provider bridge is not ready');
    const data = await runtime.getP2PProvider().fetch(hashHex, peerId, 10);
    return data ? new TextDecoder().decode(data) : null;
  }, { hashHex: source.hashHex, peerId: firstFipsPeerId }, 5);
  expect(received).toBe(source.text);

  await secondContext.close();
});
