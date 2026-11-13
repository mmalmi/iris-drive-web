/**
 * The public follow-list catch-up of `nostr-social-graph`, run once when the
 * storage worker starts and then when asked, instead of every minute.
 *
 * The library's catch-up fetches up to 2 MB of other people's follow lists
 * each minute, also while the tab is hidden, since a worker cannot tell. Drive
 * needs those lists to rank people when someone searches for people to share
 * with. The build points the worker's import of
 * `nostr-social-graph/publicGraphSync` at this module (see
 * `graphSyncOnDemandPlugin` in vite.config.ts): starting runs the first pass
 * as before, and `requestGraphSync()` runs each later one.
 *
 * Only this module imports the library under its own name; everything else
 * the library offers passes through unchanged.
 */
import {
  startGraphSync as startScheduledGraphSync,
  type GraphSyncLifecycleOptions,
} from 'nostr-social-graph/publicGraphSync';

export * from 'nostr-social-graph/publicGraphSync';

// The library runs a pass at once and then waits this long for the next one;
// the next pass is normally the next request.
const NEXT_PASS_MS = 24 * 60 * 60 * 1000;

interface Registered {
  options: GraphSyncLifecycleOptions;
  stopPass: (() => void) | null;
}

let registered: Registered | null = null;

/** Runs the first pass now and keeps the settings for the next request. */
export function startGraphSync(options: GraphSyncLifecycleOptions): () => void {
  const entry: Registered = { options, stopPass: null };
  registered?.stopPass?.();
  registered = entry;
  requestGraphSync();
  return () => {
    entry.stopPass?.();
    entry.stopPass = null;
    if (registered === entry) registered = null;
  };
}

/** Runs one catch-up pass now. False when the worker has not started one yet. */
export function requestGraphSync(): boolean {
  const entry = registered;
  if (!entry) return false;
  entry.stopPass?.();
  entry.stopPass = startScheduledGraphSync({ ...entry.options, intervalMs: NEXT_PASS_MS });
  return true;
}
