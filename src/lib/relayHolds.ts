/**
 * Telling when the relays hold something this page sent, so the page can say
 * it is safe to close. Only reads: nothing that sends waits for it. A live
 * subscription can pass over an event it was sent before it began, so the
 * relays are asked again now and then, less and less often.
 */
import type { Event, Filter } from 'nostr-tools';
import { nostr } from '../nostr';
import { startBackoffPoll } from './backoffPoll';

const ASK_AGAIN_MIN_MS = 2000;
const ASK_AGAIN_MAX_MS = 30_000;

/** Calls `onHeld` once a relay has an event matching `filter` and `test`; returns a stop. */
export function whenRelaysHold(filter: Filter, test: (event: Event) => boolean, onHeld: () => void): () => void {
  let done = false;
  let history: ReturnType<typeof nostr.subscribe> | null = null;
  const seen = (event: Event) => {
    if (done || !test(event)) return;
    done = true;
    queueMicrotask(stop);
    onHeld();
  };
  const live = nostr.subscribe(filter);
  live.on('event', seen);
  const poll = startBackoffPoll(() => {
    history?.stop();
    history = nostr.subscribe(filter, { closeAfterHistory: true });
    history.on('event', seen);
  }, { minMs: ASK_AGAIN_MIN_MS, maxMs: ASK_AGAIN_MAX_MS });
  function stop(): void {
    done = true;
    poll.stop();
    history?.stop();
    live.stop();
  }
  return stop;
}
