import { expect } from '../fixtures';
import { evaluateWithRetry, waitForAppShell, waitForOptionalWorkerAdapter, waitForTestHelpers, waitForWorkerAdapter } from './core';

const DEFAULT_E2E_PRODUCTION_RELAYS = [
  'wss://relay.damus.io',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
  'wss://relay.snort.social',
  'wss://temp.iris.to',
];

/**
 * Wait for at least one relay connection.
 * Use this before tests that require Nostr publishes to be queryable by other users.
 */
export async function waitForRelayConnected(page: any, timeoutMs: number = 15000) {
  await waitForTestHelpers(page, timeoutMs);
  await evaluateWithRetry(page, async (fallbackRelay: string) => {
    const win = window as any;
    const { settingsStore } = await import('/src/stores/settings.ts');
    const currentRelays = settingsStore.getState().network.relays ?? [];
    const testRelay = win.__testRelayUrl ?? fallbackRelay;
    const isLocalRelay = (url: string): boolean => {
      try {
        const parsed = new URL(url);
        return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
      } catch {
        return false;
      }
    };
    const relays = testRelay && (currentRelays.length === 0 || currentRelays.every(isLocalRelay))
      ? [testRelay]
      : currentRelays;

    if (relays.length > 0) {
      settingsStore.setNetworkSettings({ relays });
      const adapter = win.__getWorkerAdapter?.();
      await Promise.resolve(adapter?.setRelays?.(relays)).catch(() => {});
    }
  }, getTestRelayUrl()).catch(() => {});
  await page.waitForFunction(
    async (fallbackRelay: string) => {
      const win = window as any;
      const store = win.__nostrStore;
      if ((store?.getState?.().connectedRelays ?? 0) > 0) {
        return true;
      }

      const adapter = win.__getWorkerAdapter?.();
      if (!adapter) {
        return false;
      }

      const { settingsStore } = await import('/src/stores/settings.ts');
      const currentRelays = settingsStore.getState().network.relays ?? [];
      const testRelay = win.__testRelayUrl ?? fallbackRelay;
      const isLocalRelay = (url: string): boolean => {
        try {
          const parsed = new URL(url);
          return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        } catch {
          return false;
        }
      };
      const relays = testRelay && (currentRelays.length === 0 || currentRelays.every(isLocalRelay))
        ? [testRelay]
        : currentRelays;
      const relayKey = JSON.stringify(relays);
      if (relays.length > 0 && win.__lastRelayWaitTarget !== relayKey) {
        win.__lastRelayWaitTarget = relayKey;
        await Promise.resolve(adapter.setRelays?.(relays)).catch(() => {});
      }

      const stats = await adapter.getRelayStats?.().catch(() => []);
      const connectedRelays = Array.isArray(stats)
        ? stats.filter((relay: { connected?: boolean }) => relay.connected).length
        : 0;
      if (connectedRelays > 0) {
        store?.setConnectedRelays?.(connectedRelays);
        return true;
      }
      return false;
    },
    getTestRelayUrl(),
    { timeout: timeoutMs }
  );
}

/**
 * Disable FIPS peer networking for isolated single-page tests.
 * This prevents the app from connecting to peers from other parallel tests.
 * Use this for tests that don't need cross-device connections but might be
 * affected by incoming data from parallel test instances.
 *
 * IMPORTANT: Call this BEFORE any navigation or state changes in the test.
 */
export async function disableOthersPool(page: any) {
  await waitForAppShell(page);
  await waitForOptionalWorkerAdapter(page);
  await evaluateWithRetry(page, async () => {
    const win = window as any;
    let adapter = win.__getWorkerAdapter?.();
    if (!adapter) {
      const { getWorkerAdapter } = await import('/src/workerAdapter.ts');
      adapter = getWorkerAdapter();
    }
    const { stopDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    await stopDriveFipsRuntime();
    adapter?.setP2PProvider?.(null);
  }, undefined);
}

/**
 * Force any pending tree publishes to complete.
 * Useful when a test needs newly created trees to be visible to another user.
 */
export async function flushPendingPublishes(page: any): Promise<void> {
  await waitForTestHelpers(page);
  await waitForWorkerAdapter(page);
  await evaluateWithRetry(page, async () => {
    const { flushPendingPublishes: flush } = await import('/src/treeRootCache.ts');
    await flush();
  }, undefined);
}

/**
 * Confirm FIPS peer networking is active for cross-device tests.
 *
 * @param page - Playwright page
 * IMPORTANT: Call this after login but before operations that need FIPS.
 */
export async function enableOthersPool(page: any, _max: number = 10) {
  await waitForTestHelpers(page);
  await waitForWorkerAdapter(page);
  await page.waitForFunction(async () => {
    const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    return getDriveFipsRuntime()?.getStats().active === true;
  }, undefined, { timeout: 30_000 });
}

/**
 * Pair two browser FIPS runtimes with explicit remote Hashtree routes.
 * Production never derives blob providers from connected WebRTC peers; tests
 * name both device identities here so cross-context reads exercise that rule.
 */
export async function configureExplicitFipsPair(
  firstPage: any,
  secondPage: any,
  timeoutMs = 60_000,
): Promise<void> {
  const readPeerId = (page: any): Promise<string> => page.evaluate(async () => {
    const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    return getDriveFipsRuntime()?.getStats().localPeerId ?? '';
  });
  await Promise.all([firstPage, secondPage].map((page) => page.waitForFunction(async () => {
    const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
    return !!getDriveFipsRuntime()?.getStats().localPeerId;
  }, undefined, { timeout: timeoutMs })));
  const [firstPeerId, secondPeerId] = await Promise.all([
    readPeerId(firstPage),
    readPeerId(secondPage),
  ]);

  await Promise.all([
    [firstPage, secondPeerId],
    [secondPage, firstPeerId],
  ].map(async ([page, remotePeerId]) => {
    await (page as any).waitForFunction(async (peerId: string) => {
      const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
      const runtime = getDriveFipsRuntime();
      const adapter = (window as any).__getWorkerAdapter?.() ?? (window as any).__workerAdapter;
      if (!runtime || !adapter || !runtime.getStats().connectedPeerIds.includes(peerId)) {
        return false;
      }
      // Relay/session changes can restart the runtime after navigation. Bind the
      // provider in the same readiness sample, before another browser call can
      // observe a different runtime. This never starts or replaces app state.
      const provider = runtime.getP2PProvider();
      adapter.setP2PProvider({
        listPeerIds: () => [peerId],
        fetch: (hashHex: string, selectedPeerId?: string, htl = 10) => {
          if (selectedPeerId && selectedPeerId !== peerId) {
            throw new Error(`Unexpected explicit FIPS peer ${selectedPeerId}`);
          }
          return provider.fetch(hashHex, peerId, htl);
        },
      });
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return true;
    }, remotePeerId, { timeout: timeoutMs, polling: 500 });
  }));
}

/**
 * Pre-set network relay settings in IndexedDB before page load.
 * This ensures the worker initializes with the local relay in test runs.
 *
 * IMPORTANT: Call this BEFORE the first page navigation.
 */
export function getTestRelayUrl(): string {
  return process.env.PW_TEST_RELAY_URL || process.env.VITE_TEST_RELAY || 'ws://localhost:4736';
}

export function getTestBlossomUrl(): string {
  return process.env.PW_TEST_BLOSSOM_URL || process.env.VITE_TEST_BLOSSOM_URL || 'http://127.0.0.1:18780';
}

export function getCrosslangPort(workerIndex: number): number {
  const baseEnv = Number(process.env.CROSSLANG_BASE_PORT);
  const basePort = Number.isFinite(baseEnv) && baseEnv > 0 ? baseEnv : 19090;
  const offset = Number.isFinite(workerIndex) && workerIndex >= 0 ? workerIndex : 0;
  return basePort + offset;
}

export async function presetLocalRelayInDB(page: any, relayUrl: string = getTestRelayUrl()) {
  await page.evaluate(async (relay: string) => {
    const request = indexedDB.open('hashtree-settings');
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('settings')) {
          db.close();
          const upgradeRequest = indexedDB.open('hashtree-settings', db.version + 1);
          upgradeRequest.onupgradeneeded = () => {
            const upgradeDb = upgradeRequest.result;
            if (!upgradeDb.objectStoreNames.contains('settings')) {
              upgradeDb.createObjectStore('settings', { keyPath: 'key' });
            }
          };
          upgradeRequest.onsuccess = () => {
            const newDb = upgradeRequest.result;
            const tx = newDb.transaction('settings', 'readwrite');
            const store = tx.objectStore('settings');
            store.put({
              key: 'network',
              value: {
                relays: [relay],
                blossomServers: [],
                negentropyEnabled: false,
              },
            });
            tx.oncomplete = () => {
              newDb.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
          upgradeRequest.onerror = () => reject(upgradeRequest.error);
          return;
        }

        const tx = db.transaction('settings', 'readwrite');
        const store = tx.objectStore('settings');
        store.put({
          key: 'network',
          value: {
            relays: [relay],
            blossomServers: [],
            negentropyEnabled: false,
          },
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, relayUrl);
}

/**
 * Pre-set production relay settings in IndexedDB before page load.
 * This ensures the worker initializes with public relays even on localhost.
 *
 * IMPORTANT: Call this BEFORE reload or initial navigation that should use production relays.
 */
export async function presetProductionRelaysInDB(page: any) {
  await page.evaluate(async (relays: string[]) => {
    const blossomServers = [
      { url: 'https://upload.iris.to', read: false, write: true },
      { url: 'https://cdn.iris.to', read: true, write: false },
    ];

    const request = indexedDB.open('hashtree-settings');
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('settings')) {
          db.close();
          const upgradeRequest = indexedDB.open('hashtree-settings', db.version + 1);
          upgradeRequest.onupgradeneeded = () => {
            const upgradeDb = upgradeRequest.result;
            if (!upgradeDb.objectStoreNames.contains('settings')) {
              upgradeDb.createObjectStore('settings', { keyPath: 'key' });
            }
          };
          upgradeRequest.onsuccess = () => {
            const newDb = upgradeRequest.result;
            const tx = newDb.transaction('settings', 'readwrite');
            const store = tx.objectStore('settings');
            store.put({
              key: 'network',
              value: {
                relays,
                blossomServers,
                negentropyEnabled: false,
              },
            });
            tx.oncomplete = () => {
              newDb.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
          upgradeRequest.onerror = () => reject(upgradeRequest.error);
          return;
        }

        const tx = db.transaction('settings', 'readwrite');
        const store = tx.objectStore('settings');
        store.put({
          key: 'network',
          value: {
            relays,
            blossomServers,
            negentropyEnabled: false,
          },
        });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => reject(tx.error);
      };
    });
  }, [...DEFAULT_E2E_PRODUCTION_RELAYS]);
}

/**
 * Configure the app to use the local test relay instead of public relays.
 * This eliminates network flakiness and rate limiting issues during tests.
 *
 * Updates both settings store (for future store creations) and the
 * existing WebRTC store (for immediate effect on current connections).
 */
export async function useLocalRelay(page: any, relayOverride?: string) {
  await waitForTestHelpers(page);
  await waitForWorkerAdapter(page);
  const localRelay = relayOverride || getTestRelayUrl();
  await evaluateWithRetry(page, async (relay) => {
    // Update settings store for future store creations
    const { settingsStore } = await import('/src/stores/settings.ts');
    settingsStore.setNetworkSettings({
      relays: [relay],
    });

    // Directly update worker's NDK relays via worker adapter
    const getWorkerAdapter = (window as any).__getWorkerAdapter;
    if (getWorkerAdapter) {
      const adapter = getWorkerAdapter();
      if (adapter?.setRelays) {
        console.log('[useLocalRelay] Syncing relay to worker:', relay);
        await adapter.setRelays([relay]);
      }
    }
  }, localRelay);
}

/**
 * Configure Blossom servers for tests that need them.
 * In e2e, this points at the local hashtree Blossom server (no external HTTP).
 * Call this for tests that specifically test Blossom functionality.
 *
 * Uses a global function exposed by the settings module to avoid Vite module duplication issues.
 */
export async function configureBlossomServers(page: any, blossomUrl: string = getTestBlossomUrl()) {
  await waitForTestHelpers(page);
  await waitForOptionalWorkerAdapter(page);
  await evaluateWithRetry(page, async (url: string) => {
    const configure = (window as unknown as { __configureBlossomServers?: (servers: unknown[]) => void }).__configureBlossomServers;
    if (!configure) {
      throw new Error('__configureBlossomServers not found - settings module may not be loaded');
    }
    configure([
      { url, read: true, write: true },
    ]);
    const adapter = (window as any).__getWorkerAdapter?.() ?? (window as any).__workerAdapter;
    if (adapter?.setBlossomServers) {
      await adapter.setBlossomServers([{ url, read: true, write: true }]);
    }
  }, blossomUrl);
}

/**
 * Helper to follow a user by their npub.
 * Navigates to target's profile and clicks Follow, waiting for completion.
 * Use this when the sharing behavior under test requires a follow relationship.
 */
export async function followUser(page: any, targetNpub: string) {
  // Navigate to the user's profile page
  const currentUrl = new URL(page.url());
  await page.goto(`${currentUrl.origin}/#/${targetNpub}`);

  // Dismiss any modal that might intercept the follow button
  const modalBackdrop = page.locator('.fixed.inset-0').first();
  if (await modalBackdrop.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    await modalBackdrop.waitFor({ state: 'hidden', timeout: 1000 }).catch(() => {});
    if (await modalBackdrop.isVisible().catch(() => false)) {
      const closeBtn = modalBackdrop.getByRole('button', { name: /close|cancel|back/i }).first();
      if (await closeBtn.isVisible().catch(() => false)) {
        await closeBtn.click().catch(() => {});
      } else {
        await modalBackdrop.click({ position: { x: 5, y: 5 } }).catch(() => {});
      }
    }
    await modalBackdrop.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  }

  // Click the Follow button
  const followButton = page.getByRole('button', { name: 'Follow', exact: true });
  await expect(followButton).toBeVisible({ timeout: 5000 });
  await followButton.click();

  // Wait for follow to complete - button becomes disabled or changes to "Following" or "Unfollow"
  await expect(
    page.getByRole('button', { name: 'Following' })
      .or(page.getByRole('button', { name: 'Unfollow' }))
      .or(followButton.and(page.locator('[disabled]')))
  ).toBeVisible({ timeout: 10000 });
}

/**
 * Wait for the Nostr-discovered FIPS WebRTC transport to have a connected
 * device peer. The legacy target argument is intentionally ignored: a Nostr
 * user pubkey is not a FIPS device identity.
 */
export async function waitForFipsConnection(page: any, timeoutMs: number = 15000): Promise<boolean> {
  return page.waitForFunction(
    async () => {
      try {
        const { getDriveFipsRuntime } = await import('/src/lib/driveFipsRuntime.ts');
        return (getDriveFipsRuntime()?.getStats().connectedPeerIds.length ?? 0) > 0;
      } catch {
        return false;
      }
    },
    undefined,
    { timeout: timeoutMs, polling: 500 }
  ).then(() => true).catch(() => false);
}

/**
 * Login as a test user with a given nsec.
 * Sets the nsec in localStorage and reloads the page.
 *
 * @param page - Playwright page
 * @param nsec - Nostr secret key in bech32 format (nsec1...)
 */
export async function loginAsTestUser(page: any, nsec: string) {
  await page.evaluate((secret: string) => {
    localStorage.setItem('hashtree:loginType', 'nsec');
    localStorage.setItem('hashtree:nsec', secret);
  }, nsec);
  await page.reload();
  // Wait for app to be ready after login
  await expect(page.locator('header').first()).toBeVisible({ timeout: 30000 });
  await page.waitForFunction(() => {
    const store = (window as any).__nostrStore;
    return store?.getState?.().pubkey?.length === 64;
  }, { timeout: 30000 });
}
