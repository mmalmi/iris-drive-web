/**
 * The social graph is kept by the worker, which also answers follow distances.
 * The page only hears that it changed, so whatever ranks people by it (finding
 * people to share with) can look again.
 */
import { get, writable } from 'svelte/store';
import { getWorkerAdapter } from '../workerAdapter';

const version = writable({ version: 0 });

export const socialGraphStore = {
  subscribe: version.subscribe,
  getState: () => get(version),
};

/** Called once the worker is ready. */
export function setupVersionCallback(): void {
  const adapter = getWorkerAdapter();
  adapter?.onSocialGraphVersion(() => {
    if (adapter !== getWorkerAdapter()) return;
    version.update((state) => ({ version: state.version + 1 }));
  });
}

/** The people an account follows, as far as the worker knows now. */
export async function getFollows(pubkey: string | null | undefined): Promise<string[]> {
  const adapter = getWorkerAdapter();
  if (!adapter || !pubkey) return [];
  try {
    return await adapter.getFollows(pubkey);
  } catch {
    return [];
  }
}
