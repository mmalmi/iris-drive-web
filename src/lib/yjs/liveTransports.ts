/**
 * Where live messages (liveChannel.ts) travel: through the Nostr relays, and
 * straight to the peers of the FIPS network that are connected and may read
 * the document. Both only send; nothing waits for an answer.
 */
import type { Event, Filter } from 'nostr-tools';
import { getLoadedDriveFipsRuntime } from '../driveFipsRuntimeRef';
import { LIVE_KIND, type LiveTransport } from './liveChannel';

/**
 * A new subscription asks for nothing older than this second. Relays keep no
 * ephemeral messages, and one that did would bring back copies already gone;
 * what was written before joining comes by asking (see liveChannel.ts).
 */
const LISTEN_BACK_S = 0;

/** The app's Nostr client, as far as live messages need it. */
export interface LiveNostrClient {
  subscribe(filters: Filter): { on(name: 'event', handler: (event: Event) => void): unknown; stop(): void };
  publish(event: Event): Promise<unknown>;
}

export function nostrLiveTransport(nostr: LiveNostrClient): LiveTransport {
  return {
    listen(topics, receive) {
      const subscription = nostr.subscribe({ kinds: [LIVE_KIND], '#d': topics, since: Math.floor(Date.now() / 1000) - LISTEN_BACK_S });
      subscription.on('event', receive);
      return () => subscription.stop();
    },
    send(event) {
      void nostr.publish(event).catch(() => {});
    },
  };
}

/** The service port of live documents on the FIPS network. */
export const LIVE_FIPS_PORT = 39_020;
/** Larger messages go by the relays alone. */
const MAX_DATAGRAM = 16_000;

interface FipsServiceContext {
  src: string;
  payload: Uint8Array;
}

export interface LiveFipsNode {
  registerService(port: number, handler: (context: FipsServiceContext) => void | Promise<void>): () => void;
  sendDatagram(args: { dst: string; dstPort: number; payload: Uint8Array }): Promise<void>;
}

export interface LiveFipsRuntime {
  node(): LiveFipsNode | null;
  connectedPeerIds(): readonly string[];
}

type Receiver = (event: Event, fromKey: string) => void;

/** A device's key from its FIPS address, which carries it compressed. */
function deviceKeyOf(peerId: string): string {
  const id = peerId.toLowerCase();
  return id.length === 66 ? id.slice(2) : id;
}

function loadedRuntime(): LiveFipsRuntime | null {
  const runtime = getLoadedDriveFipsRuntime();
  if (!runtime) return null;
  return {
    node: () => {
      try {
        return (runtime.getP2PProvider() as unknown as { node: LiveFipsNode }).node;
      } catch {
        return null;
      }
    },
    connectedPeerIds: () => runtime.getStats().connectedPeerIds,
  };
}

/** One service on the page's node passes datagrams on to every open document. */
const receivers = new Set<Receiver>();
let service: { node: LiveFipsNode; stop: () => void } | null = null;

function serve(node: LiveFipsNode | null): void {
  if (!node || service?.node === node) return;
  service?.stop();
  const stop = node.registerService(LIVE_FIPS_PORT, ({ src, payload }) => {
    let event: Event;
    try {
      event = JSON.parse(new TextDecoder().decode(payload)) as Event;
    } catch {
      return;
    }
    const fromKey = deviceKeyOf(src);
    for (const receiver of receivers) receiver(event, fromKey);
  });
  service = { node, stop };
}

export function fipsLiveTransport(options: {
  /** The device keys that may read the document. */
  audience: () => ReadonlySet<string>;
  ownKey: string;
  runtime?: () => LiveFipsRuntime | null;
}): LiveTransport {
  const runtime = options.runtime ?? loadedRuntime;
  return {
    listen(topics, receive) {
      const receiver: Receiver = (event, fromKey) => {
        if (fromKey === options.ownKey || !options.audience().has(fromKey)) return;
        const topic = Array.isArray(event?.tags) ? event.tags.find(tag => tag[0] === 'd')?.[1] : undefined;
        if (topic && topics.includes(topic)) receive(event);
      };
      receivers.add(receiver);
      serve(runtime()?.node() ?? null);
      return () => {
        receivers.delete(receiver);
      };
    },
    send(event) {
      const current = runtime();
      const node = current?.node() ?? null;
      if (!current || !node) return;
      // The peer network may have started, or started again, since the document opened.
      serve(node);
      const payload = new TextEncoder().encode(JSON.stringify(event));
      if (payload.length > MAX_DATAGRAM) return;
      const audience = options.audience();
      for (const peerId of current.connectedPeerIds()) {
        const key = deviceKeyOf(peerId);
        if (key === options.ownKey || !audience.has(key)) continue;
        void node.sendDatagram({ dst: peerId, dstPort: LIVE_FIPS_PORT, payload }).catch(() => {});
      }
    },
  };
}

/** For tests: forgets the service, as when the page starts again. */
export function resetLiveFipsService(): void {
  service?.stop();
  service = null;
  receivers.clear();
}
