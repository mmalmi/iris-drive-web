import type { Event, Filter } from 'nostr-tools';
import { nostr } from '../nostr';
import { startBackoffPoll, type BackoffPoll } from '../lib/backoffPoll';

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

// The live subscription delivers new roots as they are published. Asking the
// relays again is only a safety net: soon after opening, then less and less
// often, and again whenever the page is shown or the relays come back.
const BACKFILL_MIN_MS = 3000;
const BACKFILL_MAX_MS = 5 * 60_000;
// Building the Drive from roots this device already holds can fail while their
// blocks are still on their way; it is tried again without asking the relays.
const REBUILD_RETRY_MIN_MS = 3000;
const REBUILD_RETRY_MAX_MS = 60_000;

const backfillPolls = new Map<string, BackoffPoll>();
const rebuildRetries = new Map<string, ReturnType<typeof setTimeout>>();

/** Backfill an open Drive scope now and then, less often while nothing changes. */
export function startDriveRootBackfillPoll(key: string, backfill: () => void): BackoffPoll {
  backfillPolls.get(key)?.stop();
  const poll = startBackoffPoll(backfill, { minMs: BACKFILL_MIN_MS, maxMs: BACKFILL_MAX_MS });
  backfillPolls.set(key, poll);
  return poll;
}

export function stopDriveRootBackfillPoll(key: string, poll: BackoffPoll): void {
  poll.stop();
  if (backfillPolls.get(key) === poll) backfillPolls.delete(key);
  cancelDriveRootRebuildRetry(key);
}

/** Ask the relays again soon, for example after new writers were let in. */
export function kickDriveRootBackfill(key: string): void {
  backfillPolls.get(key)?.kick();
}

/** Try building an open Drive again after its `failures`-th failure in a row. */
export function retryDriveRootRebuild(key: string, failures: number, rebuild: () => void): void {
  cancelDriveRootRebuildRetry(key);
  if (!backfillPolls.has(key)) return;
  const delay = Math.min(REBUILD_RETRY_MIN_MS * 2 ** Math.min(Math.max(failures - 1, 0), 8), REBUILD_RETRY_MAX_MS);
  rebuildRetries.set(key, setTimeout(() => {
    rebuildRetries.delete(key);
    if (backfillPolls.has(key)) rebuild();
  }, delay));
}

export function cancelDriveRootRebuildRetry(key: string): void {
  const timer = rebuildRetries.get(key);
  if (timer) clearTimeout(timer);
  rebuildRetries.delete(key);
}
