/**
 * Test helpers exposed on window for e2e tests
 * Shared between all app entry points
 */

// Extend window interface for test helpers
declare global {
  interface Window {
    __testHelpers?: { uploadSingleFile: unknown; followPubkey: unknown };
    __localStore?: unknown;
    __getWorkerAdapter?: unknown;
    __settingsStore?: unknown;
    __setPoolSettings?: (pools: Record<string, unknown>) => void;
    __getMyPubkey?: () => string | null;
    __hashtree?: unknown;
    __getTreeRoot?: () => string | null;
    __consoleLogs?: string[];
    __testHelpersReady?: boolean;
  }
}

// Capture console logs for E2E testing
const consoleLogs: string[] = [];
const origLog = console.log;
const origError = console.error;
const origWarn = console.warn;

if (typeof window !== 'undefined') {
  console.log = (...args) => {
    consoleLogs.push('[log] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    origLog.apply(console, args);
  };
  console.error = (...args) => {
    consoleLogs.push('[error] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    origError.apply(console, args);
  };
  console.warn = (...args) => {
    consoleLogs.push('[warn] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' '));
    origWarn.apply(console, args);
  };
  window.__consoleLogs = consoleLogs;
}

/** Tests follow someone by publishing this account's follow list with them added. */
async function followForTest(pubkey: string): Promise<boolean> {
  const [{ nostrStore }, { getFollows }, { publishEvent }] = await Promise.all([
    import('../nostr'),
    import('../utils/socialGraph'),
    import('./nostrPublish'),
  ]);
  const own = nostrStore.getState().pubkey;
  if (!own) return false;
  const follows = new Set(await getFollows(own));
  follows.add(pubkey);
  await publishEvent({
    kind: 3,
    content: '',
    created_at: Math.floor(Date.now() / 1000),
    tags: [...follows].map((followed) => ['p', followed]),
  });
  return true;
}

export async function setupTestHelpers(): Promise<void> {
  if (typeof window === 'undefined') return;

  const actionsPromise = import('../actions/index').then((actions) => {
    window.__testHelpers = { uploadSingleFile: actions.uploadSingleFile, followPubkey: followForTest };
  });

  const storePromise = import('../store').then(({ localStore }) => {
    window.__localStore = localStore;
  });

  const workerPromise = import('./workerInit').then(({ getWorkerAdapter }) => {
    window.__getWorkerAdapter = getWorkerAdapter;
  });

  const settingsPromise = import('../stores/settings').then(({ settingsStore }) => {
    window.__settingsStore = settingsStore;
    window.__setPoolSettings = (pools: Record<string, unknown>) => settingsStore.setPoolSettings(pools);
  });

  const nostrPromise = import('../nostr').then(({ useNostrStore }) => {
    window.__getMyPubkey = () => useNostrStore.getState().pubkey;
  });

  const hashtreePromise = import('@hashtree/core').then((hashtree) => {
    window.__hashtree = hashtree;
  });

  const treeRootPromise = Promise.all([
    import('../stores'),
    import('svelte/store'),
    import('@hashtree/core'),
  ]).then(([stores, svelteStore, hashtree]) => {
    window.__getTreeRoot = () => {
      const rootCid = svelteStore.get(stores.treeRootStore);
      return rootCid?.hash ? hashtree.toHex(rootCid.hash) : null;
    };
  });

  const criticalResults = await Promise.allSettled([
    actionsPromise,
    storePromise,
    workerPromise,
    settingsPromise,
    nostrPromise,
  ]);
  const failedCritical = criticalResults.filter((result) => result.status === 'rejected');
  if (failedCritical.length > 0) {
    console.error('[testHelpers] critical init failed', failedCritical);
  }

  window.__testHelpersReady = true;

  void Promise.all([
    hashtreePromise,
    treeRootPromise,
  ]).catch((err) => {
    console.error('[testHelpers] background init failed', err);
  });
}
