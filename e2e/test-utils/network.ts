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
 * Disable the "others pool" for WebRTC connections.
 * This prevents the app from connecting to random peers from other parallel tests.
 * Use this for single-user tests that don't need WebRTC connections but might be
 * affected by incoming data from parallel test instances.
 *
 * IMPORTANT: Call this BEFORE any navigation or state changes in the test.
 */
export async function disableOthersPool(page: any) {
  await waitForAppShell(page);
  await waitForOptionalWorkerAdapter(page);
  await page.waitForFunction(() => {
    const win = window as any;
    return !!win.__setPoolSettings || !!win.__settingsStore;
  }, { timeout: 10000 }).catch(() => {});
  await evaluateWithRetry(page, async () => {
    const win = window as any;
    const setPoolSettings = win.__setPoolSettings || win.__settingsStore?.setPoolSettings;
    if (setPoolSettings) {
      setPoolSettings({ otherMax: 0, otherSatisfied: 0 });
    } else {
      const { settingsStore } = await import('/src/stores/settings.ts');
      settingsStore.setPoolSettings({ otherMax: 0, otherSatisfied: 0 });
    }

    let adapter = win.__getWorkerAdapter?.();
    if (!adapter) {
      const { getWorkerAdapter } = await import('/src/workerAdapter.ts');
      adapter = getWorkerAdapter();
    }
    adapter?.setWebRTCPools({
      follows: { max: 20, satisfied: 10 },
      other: { max: 0, satisfied: 0 },
    });
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
 * Enable the "others pool" for WebRTC connections.
 * Use this for tests that need same-user cross-device sync (same account on two browsers).
 * In test mode, the others pool is disabled by default to prevent interference.
 *
 * @param page - Playwright page
 * @param max - Maximum number of peers (default: 10)
 *
 * IMPORTANT: Call this AFTER login but BEFORE operations that need WebRTC.
 */
export async function enableOthersPool(page: any, max: number = 10) {
  await waitForTestHelpers(page);
  await waitForWorkerAdapter(page);
  await page.waitForFunction(() => {
    const win = window as any;
    return !!win.__setPoolSettings || !!win.__settingsStore;
  }, { timeout: 10000 }).catch(() => {});
  await evaluateWithRetry(page, async (maxPeers: number) => {
    const win = window as any;
    const setPoolSettings = win.__setPoolSettings || win.__settingsStore?.setPoolSettings;
    if (setPoolSettings) {
      setPoolSettings({ otherMax: maxPeers, otherSatisfied: Math.floor(maxPeers / 5), followsMax: 20, followsSatisfied: 10 });
    } else {
      const { settingsStore } = await import('/src/stores/settings.ts');
      settingsStore.setPoolSettings({ otherMax: maxPeers, otherSatisfied: Math.floor(maxPeers / 5), followsMax: 20, followsSatisfied: 10 });
    }

    // Update the worker's WebRTC pool config - use the exposed global to avoid module duplication issues
    let adapter = win.__getWorkerAdapter?.();
    if (!adapter) {
      const { getWorkerAdapter } = await import('/src/workerAdapter.ts');
      adapter = getWorkerAdapter();
    }
    if (adapter) {
      await adapter.setWebRTCPools({
        follows: { max: 20, satisfied: 10 },
        other: { max: maxPeers, satisfied: Math.floor(maxPeers / 5) },
      });
      console.log('[Test] Pool config updated via adapter, otherMax:', maxPeers);
    } else {
      console.error('[Test] No worker adapter available for pool config!');
    }
  }, max);
}

/**
 * Pre-set pool settings in IndexedDB before page load/reload.
 * This ensures WebRTC initializes with correct pool limits since it starts
 * before enableOthersPool can be called.
 *
 * IMPORTANT: Call this BEFORE reload when you need others pool enabled on init.
 */
export async function presetOthersPoolInDB(page: any) {
  await page.evaluate(async () => {
    // Open without version to use current version (Dexie manages versioning)
    const request = indexedDB.open('hashtree-settings');
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        // Check if the 'settings' object store exists
        if (!db.objectStoreNames.contains('settings')) {
          db.close();
          // Need to create the object store with version upgrade
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
              key: 'pools',
              value: {
                followsMax: 20,
                followsSatisfied: 10,
                otherMax: 10,
                otherSatisfied: 2
              }
            });
            tx.oncomplete = () => {
              newDb.close();
              resolve();
            };
            tx.onerror = () => reject(tx.error);
          };
          upgradeRequest.onerror = () => reject(upgradeRequest.error);
        } else {
          const tx = db.transaction('settings', 'readwrite');
          const store = tx.objectStore('settings');
          store.put({
            key: 'pools',
            value: {
              followsMax: 20,
              followsSatisfied: 10,
              otherMax: 10,
              otherSatisfied: 2
            }
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        }
      };
    });
  });
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

    // Also update the running WebRTC store if it exists
    // Use window global which is always in sync with the app
    const store = (window as unknown as { webrtcStore?: { setRelays?: (relays: string[]) => void } }).webrtcStore;
    if (store && typeof store.setRelays === 'function') {
      store.setRelays([relay]);
    }

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
 * Use this to establish reliable WebRTC connections via the "follows pool".
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
 * Wait for a pubkey to be in the worker's follows set.
 * This is essential before sending WebRTC hellos - ensures the peer will be
 * classified in the "follows" pool rather than "other" pool.
 */
export async function waitForFollowInWorker(page: any, pubkeyHex: string, timeoutMs: number = 15000): Promise<boolean> {
  return page.waitForFunction(
    (pk: string) => {
      const store = (window as any).webrtcStore;
      if (!store) return false;
      // Check via internal API that exposes followsSet
      const isFollowing = store.isFollowing?.(pk);
      if (isFollowing) return true;
      // Fallback: check directly if available
      const followsSet = store.getFollowsSet?.();
      return followsSet?.has?.(pk) ?? false;
    },
    pubkeyHex,
    { timeout: timeoutMs }
  ).then(() => true).catch(() => false);
}

/**
 * Wait for WebRTC connection to be established.
 * Polls until at least one peer is connected with data channel open.
 * If targetPubkey is provided, waits for that specific peer to connect.
 * Use this after users follow each other to ensure WebRTC is ready.
 */
export async function waitForWebRTCConnection(page: any, timeoutMs: number = 15000, targetPubkey?: string): Promise<boolean> {
  return page.waitForFunction(
    async (target: string | null) => {
      const adapter = (window as unknown as { __workerAdapter?: { getPeerStats: () => Promise<Array<{ connected?: boolean; pubkey?: string }>> } }).__workerAdapter;
      if (!adapter) return false;
      try {
        const stats = await adapter.getPeerStats();
        const connected = stats.filter((p: { connected?: boolean }) => p.connected);
        if (!target) return connected.length > 0;
        return connected.some((p: { pubkey?: string }) => p.pubkey === target);
      } catch {
        return false;
      }
    },
    targetPubkey ?? null,
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
