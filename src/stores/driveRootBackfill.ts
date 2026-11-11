import type { Event, Filter } from 'nostr-tools';
import { nostr } from '../nostr';

/** Backfill requests still waiting for relays, one set per resolver key. */
const openBackfills = new Map<string, Array<{ stop: () => void }>>();

export function stopOpenBackfill(key: string): void {
  for (const sub of openBackfills.get(key) ?? []) {
    try {
      sub.stop();
    } catch {
      // ignore
    }
  }
  openBackfills.delete(key);
}

/**
 * Send each request and hand over every stored event the moment it arrives.
 * A request closes itself when its relays have sent what they hold; a silent
 * relay only leaves its own request open until the next backfill replaces it.
 */
export function openBackfill(key: string, requests: Filter[][], onEvent: (event: Event) => void): void {
  stopOpenBackfill(key);
  const subs = requests.map((request) => {
    const sub = nostr.subscribe(request, { closeAfterHistory: true });
    sub.on('event', onEvent);
    return sub;
  });
  if (subs.length > 0) openBackfills.set(key, subs);
}
