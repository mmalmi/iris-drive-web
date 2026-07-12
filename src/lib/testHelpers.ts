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
    __getSocialGraph?: Window['__getSocialGraph'];
    __socialGraph?: unknown;
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

export async function setupTestHelpers(): Promise<void> {
  if (typeof window === 'undefined') return;

  const actionsPromise = Promise.all([
    import('../actions/index'),
    import('../stores/follows'),
  ]).then(([actions, followsStore]) => {
    window.__testHelpers = { uploadSingleFile: actions.uploadSingleFile, followPubkey: followsStore.followPubkey };
  });

  const storePromise = import('../store').then(({ localStore }) => {
    window.__localStore = localStore;
  });

  const workerPromise = import('./workerInit').then(({ getWorkerAdapter }) => {
    window.__getWorkerAdapter = getWorkerAdapter;
  });

  const socialGraphPromise = import('../utils/socialGraph').then(({ getSocialGraph }) => {
    window.__getSocialGraph = getSocialGraph;
    Object.defineProperty(window, '__socialGraph', {
      get: () => getSocialGraph(),
      configurable: true,
    });
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
    socialGraphPromise,
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
