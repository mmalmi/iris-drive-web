/**
 * One-off lookups sent straight to relays, on short-lived connections of their own.
 *
 * The worker checks and stores every incoming event one at a time and hands
 * nothing over out of turn: while it works through a long run of events (a first
 * visit, a profile's follower lists) an answer the relay sent within a second
 * reaches the page many seconds later. What the screen is waiting for can
 * therefore also be asked for here, where each relay's answer is used the moment
 * it arrives. No relay is waited for: every relay is asked at once and whichever
 * answers first is shown first. The worker still receives the same events for
 * storage and live updates.
 *
 * Stored matches only: each connection closes when the relay has sent what it has.
 */
import { get } from 'svelte/store';
import { matchFilters, verifyEvent, type Event, type Filter } from 'nostr-tools';
import { getEffectiveNostrRelays } from '../lib/runtimeNetwork';
import { settingsStore, waitForSettingsLoaded } from '../stores/settings';

let queryCounter = 0;

/** Whether an event is an answer to what was asked: a relay is not trusted to send only matches. */
export function answers(filters: Filter[], event: Event): boolean {
  try {
    return matchFilters(filters.map(({ limit: _limit, ...rest }) => rest), event);
  } catch {
    return false;
  }
}

/** Returns a function that ends the lookup. */
export function queryRelaysDirectly(
  relays: readonly string[],
  filters: Filter[],
  onEvent: (event: Event) => void,
  listenMs: number,
): () => void {
  const sockets = new Set<WebSocket>();
  const seen = new Set<string>();
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    for (const socket of sockets) socket.close();
    sockets.clear();
  };
  const timer = setTimeout(stop, listenMs);

  for (const relay of relays) {
    let socket: WebSocket;
    try {
      socket = new WebSocket(relay);
    } catch {
      continue;
    }
    const id = `direct-${++queryCounter}`;
    sockets.add(socket);
    socket.onopen = () => socket.send(JSON.stringify(['REQ', id, ...filters]));
    socket.onmessage = (message) => {
      let frame: unknown;
      try {
        frame = JSON.parse(String(message.data));
      } catch {
        return;
      }
      if (!Array.isArray(frame) || frame[1] !== id) return;
      if (frame[0] === 'EOSE' || frame[0] === 'CLOSED') {
        socket.close();
        return;
      }
      const event = frame[0] === 'EVENT' ? frame[2] as Event : null;
      if (!event || typeof event.id !== 'string' || seen.has(event.id) || !answers(filters, event)) return;
      seen.add(event.id);
      // The worker checks what it relays; here that is this code's job.
      if (!stopped && verifyEvent(event)) onEvent(event);
    };
    socket.onclose = () => sockets.delete(socket);
    socket.onerror = () => socket.close();
  }
  return stop;
}

/**
 * The same, to the viewer's own relays. Starts once their saved settings are
 * read (a local read), so somebody with their own relay list never has the
 * default relays contacted on their behalf.
 */
export function queryConfiguredRelaysDirectly(filters: Filter[], onEvent: (event: Event) => void, listenMs: number): () => void {
  let stop = () => {};
  let stopped = false;
  void waitForSettingsLoaded().then(() => {
    if (stopped) return;
    stop = queryRelaysDirectly(getEffectiveNostrRelays(get(settingsStore).network.relays), filters, onEvent, listenMs);
  });
  return () => {
    stopped = true;
    stop();
  };
}
