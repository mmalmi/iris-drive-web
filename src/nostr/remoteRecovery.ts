import { connectRemoteNostrIdentitySigner } from '@iris/identity/remoteSigner';
import { NostrRuntime } from 'nostr-pubsub';

/** Recovery signer traffic stays on its explicitly selected private relays. */
export async function createRemoteRecoverySigner(connection: string, relay?: string) {
  const runtime = new NostrRuntime({ relays: [], historyTimeoutMs: 30_000, publishTimeoutMs: 30_000 });
  try {
    const signer = await connectRemoteNostrIdentitySigner({
      connection,
      relays: relay ? [relay] : undefined,
      timeoutMs: 30_000,
      transport: {
        subscribe: (relays, filters, receive) => runtime.subscribe(filters, { onEvent: receive }, {
          relays, sources: [], cache: 'network-only', localEcho: false,
        }),
        publish: async (relays, event) => {
          const result = await runtime.publish(event, { relays, sources: [], requireAck: true });
          if (!result.remoteAccepted) throw new Error('Could not reach the remote signer.');
        },
      },
      onAuth: url => {
        const parsed = new URL(url);
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') window.open(parsed.href, '_blank', 'noopener,noreferrer');
      },
    });
    return Object.assign(signer, {
      close: (() => {
        const closeSigner = signer.close.bind(signer);
        return async () => { await closeSigner(); await runtime.close(); };
      })(),
    });
  } catch (error) { await runtime.close(); throw error; }
}
