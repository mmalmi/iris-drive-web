/**
 * Ref resolver singleton for the explorer app
 *
 * Provides access to the NostrRefResolver which maps npub/treename keys
 * to merkle root hashes (refs), with subscription support for live updates.
 */
import { nip19 } from 'nostr-tools';
import { fromHex, toHex, type RefResolver } from '@hashtree/core';
import { HASHTREE_ROOT_KIND, createNostrRefResolver, type NostrFilter, type NostrEvent, type VisibilityCallbacks } from '@hashtree/nostr';
import { decrypt, encrypt, nostr, useNostrStore, type NostrState } from './nostr';
import { parseRoute } from './utils/route';
import { cacheTreeEventSnapshot } from './lib/treeEventSnapshots';

// Use window to store the resolver to ensure it's truly a singleton
// even if the module is reloaded by HMR or there are multiple bundle instances
declare global {
  interface Window {
    __hashtreeResolver?: RefResolver;
  }
}

/**
 * Get the ref resolver instance (creates it on first call)
 */
export function getRefResolver(): RefResolver {
  // Check window first to ensure true singleton
  if (typeof window !== 'undefined' && window.__hashtreeResolver) {
    return window.__hashtreeResolver;
  }
  // Visibility callbacks for NIP-44 encryption/decryption
  const visibilityCallbacks: VisibilityCallbacks = {
    // Encrypt data to a pubkey using NIP-44
    encrypt: async (data: Uint8Array, toPubkey: string): Promise<string> => {
      // Convert Uint8Array to hex string for NIP-44
      const dataHex = toHex(data);
      return encrypt(toPubkey, dataHex);
    },

    // Decrypt data from a pubkey using NIP-44
    decrypt: async (ciphertext: string, fromPubkey: string): Promise<Uint8Array | null> => {
      try {
        const decrypted = await decrypt(fromPubkey, ciphertext);
        // Convert hex string back to Uint8Array
        return fromHex(decrypted);
      } catch {
        return null;
      }
    },

    // Get link key from URL (k= parameter)
    getLinkKey: (): Uint8Array | null => {
      const route = parseRoute();
      const k = route.params.get('k');
      if (!k || k.length !== 64) return null;
      try {
        return fromHex(k);
      } catch {
        return null;
      }
    },
  };

  const resolver = createNostrRefResolver({
      subscribe: (filter: NostrFilter, onEvent: (event: NostrEvent) => void) => {
        const eventFilter: NostrFilter = {
          kinds: filter.kinds,
          authors: filter.authors,
        };
        if (filter['#d']) {
          eventFilter['#d'] = filter['#d'];
        }
        if (filter['#l']) {
          eventFilter['#l'] = filter['#l'];
        }
        const opts = { closeAfterHistory: false };

        const attachSub = () => {
          const sub = nostr.subscribe(eventFilter as import('nostr-tools').Filter, opts);
          sub.on('event', (e: NostrEvent) => {
            onEvent({
              id: e.id,
              pubkey: e.pubkey,
              kind: e.kind ?? HASHTREE_ROOT_KIND,
              content: e.content,
              tags: e.tags,
              created_at: e.created_at ?? 0,
            });
          });
          return sub;
        };

        // Subscribe immediately - worker owns relay connections
        let sub = attachSub();
        let lastConnectedRelays = useNostrStore.getState().connectedRelays;
        const relayUnsub = useNostrStore.subscribe((state: NostrState) => {
          if (state.connectedRelays > 0 && lastConnectedRelays === 0) {
            try {
              sub.stop();
            } catch {
              // ignore
            }
            sub = attachSub();
          }
          lastConnectedRelays = state.connectedRelays;
        });

        return () => {
          relayUnsub?.();
          sub.stop();
        };
      },
      publish: async (event) => {
        try {
          const rawEvent = await nostr.signEvent(event);
          await nostr.publish(rawEvent);
          if (rawEvent.sig) {
            await cacheTreeEventSnapshot({
              id: rawEvent.id ?? '',
              pubkey: rawEvent.pubkey,
              created_at: rawEvent.created_at ?? 0,
              kind: rawEvent.kind,
              tags: rawEvent.tags,
              content: rawEvent.content,
              sig: rawEvent.sig,
            }).catch(() => {});
          }
          return true;
        } catch {
          return false;
        }
      },
      getPubkey: () => useNostrStore.getState().pubkey,
      nip19,
      visibility: visibilityCallbacks,
    });

  // Store on window for true singleton across HMR/bundle reloads
  if (typeof window !== 'undefined') {
    window.__hashtreeResolver = resolver;
  }

  return resolver;
}

/**
 * Build a resolver key from npub and tree name
 */
export function getResolverKey(npub: string | undefined, treeName: string | undefined): string | null {
  if (!npub || !treeName) return null;
  return `${npub}/${treeName}`;
}

/**
 * @deprecated Use resolver.publish directly instead
 */
export async function updateLocalTreeCache(
  _npub: string,
  _treeName: string,
  _hashHex: string,
  _keyHex?: string,
  _visibility: 'public' | 'link-visible' | 'private' = 'public'
): Promise<void> {
  console.warn('updateLocalTreeCache is deprecated - use resolver.publish directly');
}
