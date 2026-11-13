/**
 * Keeps other people's follow lists fresh enough to rank people by follow
 * distance, without downloading them while nobody searches.
 *
 * The storage worker runs one catch-up pass (up to 2 MB) when asked: when a
 * people search opens or gets its first keystroke, and otherwise at most every
 * 30 minutes while the page is shown. Asking returns at once; the graph
 * updates as lists arrive, so nothing waits for relays.
 */
import { getWorkerAdapter } from '../workerAdapter';
import { setVisibleInterval } from './visibleInterval';

/** A search opened again soon after uses the pass already made. */
const SEARCH_REFRESH_GAP_MS = 5 * 60_000;
const BACKGROUND_REFRESH_MS = 30 * 60_000;
/** Timers fire a little early or late; a tick this close to due still runs. */
const TIMER_SLACK_MS = 60_000;

let lastRefreshAt = 0;

function refreshIfOlderThan(gapMs: number, now: number): boolean {
  const adapter = getWorkerAdapter();
  if (!adapter?.refreshSocialGraph) return false;
  if (lastRefreshAt !== 0 && now - lastRefreshAt < gapMs) return false;
  lastRefreshAt = now;
  adapter.refreshSocialGraph();
  return true;
}

/**
 * Brings follow lists up to date for a people search. Call when the search
 * opens or gets its first keystroke. Returns at once; true when a pass started.
 */
export function refreshSocialGraph(now = Date.now()): boolean {
  return refreshIfOlderThan(SEARCH_REFRESH_GAP_MS, now);
}

/** Catches up at most every 30 minutes while the page is shown. Returns a stop function. */
export function startBackgroundSocialGraphRefresh(now: () => number = Date.now): () => void {
  // The first pass is 30 minutes in, not at start.
  if (lastRefreshAt === 0) lastRefreshAt = now();
  return setVisibleInterval(
    () => void refreshIfOlderThan(BACKGROUND_REFRESH_MS - TIMER_SLACK_MS, now()),
    BACKGROUND_REFRESH_MS,
  );
}

/** For tests. */
export function resetSocialGraphRefresh(): void {
  lastRefreshAt = 0;
}
