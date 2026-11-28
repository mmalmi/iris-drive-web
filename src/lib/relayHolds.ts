/**
 * Telling when the relays hold something this page sent, so the page can say
 * it is safe to close. Only reads: nothing that sends waits for it. A live
 * subscription also returns locally cached events, which cannot establish
 * that another device can recover them. Read the relays directly, with
 * bounded requests that become less frequent while waiting.
 */
import type { Event, Filter } from 'nostr-tools';
import { getNostrRelayUrls } from '../nostr/client';
import { getWorkerAdapter } from '../workerAdapter';
import { startBackoffPoll } from './backoffPoll';

const ASK_AGAIN_MIN_MS = 2000;
const ASK_AGAIN_MAX_MS = 30_000;
const QUERY_TIMEOUT_MS = 5000;

/** Calls `onHeld` once a relay has an event matching `filter` and `test`; returns a stop. */
export function whenRelaysHold(filter: Filter, test: (event: Event) => boolean, onHeld: () => void): () => void {
  let done = false;
  let pending: AbortController | null = null;
  const poll = startBackoffPoll(() => {
    const adapter = getWorkerAdapter();
    const relays = getNostrRelayUrls();
    if (done || pending || !adapter?.queryEvents || relays.length === 0) return;
    const controller = new AbortController();
    pending = controller;
    void adapter.queryEvents([filter], {
      cache: 'network-only', localEcho: false, relays, sources: [],
      deadline: Date.now() + QUERY_TIMEOUT_MS, signal: controller.signal,
    }).then(report => {
      if (!done && report.events.some(event => test(event as Event))) {
        stop();
        onHeld();
      }
    }).catch(() => {
      // A disconnected relay is not confirmation; the bounded poll tries later.
    }).finally(() => {
      if (pending === controller) pending = null;
    });
  }, { minMs: ASK_AGAIN_MIN_MS, maxMs: ASK_AGAIN_MAX_MS });
  function stop(): void {
    done = true;
    poll.stop();
    pending?.abort();
    pending = null;
  }
  poll.now();
  return stop;
}
