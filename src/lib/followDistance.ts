/**
 * How far a person is from this account in the follow graph the storage
 * worker already holds: 0 for this account, 1 for someone it follows, 2 for
 * someone followed by those. Only asks the worker what it knows; nothing is
 * loaded or waited for, and an unknown person has no distance.
 */
import { readable, type Readable } from 'svelte/store';
import { getWorkerAdapter } from '../workerAdapter';
import { socialGraphStore } from '../utils/socialGraph';

const UNKNOWN = 1000;
const known = new Map<string, number>();
let knownVersion = -1;

/** A follow distance the graph is sure of, or null. */
export function usableDistance(distance: number | null | undefined): number | null {
  return typeof distance === 'number' && Number.isFinite(distance) && distance >= 0 && distance < UNKNOWN ? distance : null;
}

/** The follow distance to a pubkey, or null while the graph does not know it. */
export function followDistance(pubkey: string | null | undefined): Readable<number | null> {
  return readable<number | null>(null, (set) => {
    if (!pubkey) return undefined;
    let stopped = false;
    const ask = (version: number): void => {
      // The graph changed: what it said before may be out of date.
      if (version !== knownVersion) {
        known.clear();
        knownVersion = version;
      }
      const cached = known.get(pubkey);
      if (cached !== undefined) {
        set(usableDistance(cached));
        return;
      }
      const adapter = getWorkerAdapter();
      if (!adapter) return;
      void adapter.getFollowDistance(pubkey).then((distance) => {
        known.set(pubkey, distance);
        if (!stopped) set(usableDistance(distance));
      }, () => {});
    };
    const stop = socialGraphStore.subscribe(({ version }) => ask(version));
    return () => {
      stopped = true;
      stop();
    };
  });
}
