import { cid, fromHex, toHex, visibilityHex, type Hash, type SubscribeVisibilityInfo } from '@hashtree/core';
import { getRefResolver } from '../refResolver';
import { decrypt } from '../nostr';
import { logHtreeDebug } from '../lib/htreeDebug';
import {
  getNostrState,
  type ResolverListVisibilityEntry,
} from './treeRootShared';

/**
 * Decrypt the encryption key for a tree based on visibility and available keys
 */
export async function decryptEncryptionKey(
  visibilityInfo: SubscribeVisibilityInfo | undefined,
  encryptionKey: Hash | undefined,
  linkKey: string | null
): Promise<Hash | undefined> {
  if (encryptionKey) {
    return encryptionKey;
  }

  if (!visibilityInfo) {
    // Fallback: if linkKey is present but no visibility info, use linkKey directly
    if (linkKey && linkKey.length === 64) {
      try {
        return fromHex(linkKey);
      } catch (e) {
        console.debug('Could not use linkKey directly:', e);
      }
    }
    return undefined;
  }

  // Link-visible tree with linkKey from URL
  if (visibilityInfo.visibility === 'link-visible' && linkKey) {
    logHtreeDebug('treeRoot:decrypt-link', {
      hasEncryptedKey: !!visibilityInfo.encryptedKey,
      encryptedKeyPrefix: visibilityInfo.encryptedKey?.slice(0, 16) ?? null,
      linkKeyPrefix: linkKey.slice(0, 16),
    });

    if (visibilityInfo.encryptedKey) {
      try {
        const decryptedHex = await visibilityHex.decryptKeyFromLink(visibilityInfo.encryptedKey, linkKey);
        logHtreeDebug('treeRoot:decrypt-link-result', {
          success: !!decryptedHex,
          resultPrefix: decryptedHex?.slice(0, 16) ?? null,
        });
        if (decryptedHex) {
          return fromHex(decryptedHex);
        }
        console.warn('[decryptEncryptionKey] Key mismatch - linkKey does not decrypt encryptedKey');
      } catch (e) {
        console.error('[decryptEncryptionKey] Decryption failed:', e);
      }
    } else {
      console.warn('[decryptEncryptionKey] Link-visible tree missing encryptedKey metadata; waiting for resolver update');
    }
    return undefined;
  }

  // Link-visible tree - owner access via selfEncryptedLinkKey
  // Decrypt linkKey, then derive contentKey from encryptedKey
  if (visibilityInfo.visibility === 'link-visible' && visibilityInfo.encryptedKey && visibilityInfo.selfEncryptedLinkKey) {
    try {
      const state = getNostrState();
      if (state.pubkey) {
        const decryptedLinkKey = await decrypt(state.pubkey, visibilityInfo.selfEncryptedLinkKey);
        if (decryptedLinkKey && decryptedLinkKey.length === 64) {
          const decryptedHex = await visibilityHex.decryptKeyFromLink(visibilityInfo.encryptedKey, decryptedLinkKey);
          if (decryptedHex) {
            return fromHex(decryptedHex);
          }
        }
      }
    } catch (e) {
      console.debug('Could not decrypt via selfEncryptedLinkKey (not owner?):', e);
    }
  }

  // Private tree - try selfEncryptedKey (owner access)
  if (visibilityInfo.selfEncryptedKey) {
    try {
      const state = getNostrState();
      if (state.pubkey) {
        // Use centralized decrypt (works with both nsec and extension login)
        const decrypted = await decrypt(state.pubkey, visibilityInfo.selfEncryptedKey);
        return fromHex(decrypted);
      }
    } catch (e) {
      console.debug('Could not decrypt selfEncryptedKey (not owner?):', e);
    }
  }

  // Fallback: if linkKey is present but we have no visibility metadata at all,
  // try using it directly for legacy content.
  if (linkKey && linkKey.length === 64) {
    try {
      return fromHex(linkKey);
    } catch (e) {
      console.debug('Could not use linkKey directly:', e);
    }
  }

  return undefined;
}


/**
 * Recover linkKey for URL when owner navigates to link-visible without k= param
 * This allows easy sharing by copying URL from address bar
 */
export async function recoverLinkKeyForUrl(resolverKey: string): Promise<void> {
  const npubStr = resolverKey.split('/')[0];
  const treeName = resolverKey.split('/').slice(1).join('/');
  const resolver = getRefResolver();

  // Use list to get fresh visibility data
  const entries = await new Promise<ResolverListVisibilityEntry[] | null>((resolve) => {
    let resolved = false;

    const unsub = resolver.list?.(npubStr, (list) => {
      if (resolved) return;
      resolved = true;
      // Defer unsubscribe to avoid calling it during callback
      setTimeout(() => unsub?.(), 0);
      // list entries have 'key' field like 'npub/treeName', we need to match by treeName
      const entry = list.find(e => {
        const keyParts = e.key?.split('/');
        const entryTreeName = keyParts?.slice(1).join('/');
        return entryTreeName === treeName;
      });
      resolve(entry ? [entry as ResolverListVisibilityEntry] : null);
    });

    // Timeout after 2 seconds
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unsub?.();
        resolve(null);
      }
    }, 2000);
  });

  if (!entries?.[0]) return;

  const { visibility, selfEncryptedLinkKey } = entries[0];
  if (visibility !== 'link-visible' || !selfEncryptedLinkKey) return;

  try {
    const state = getNostrState();
    const { nip19: nip19Mod } = await import('nostr-tools');
    const decoded = nip19Mod.decode(npubStr);
    const treePubkey = decoded.type === 'npub' ? decoded.data as string : null;

    if (state.pubkey && treePubkey && state.pubkey === treePubkey) {
      const decryptedLinkKey = await decrypt(state.pubkey, selfEncryptedLinkKey);
      if (decryptedLinkKey && decryptedLinkKey.length === 64) {
        // Update URL with k= param (use replaceState to avoid history pollution)
        const currentHash = window.location.hash;
        if (!currentHash.includes('k=')) {
          const separator = currentHash.includes('?') ? '&' : '?';
          window.history.replaceState(null, '', currentHash + separator + 'k=' + decryptedLinkKey);
        }
      }
    }
  } catch (e) {
    console.debug('[treeRoot] Could not recover linkKey for URL:', e);
  }
}



export async function recoverMissingLinkKeyForOwner(options: {
  resolverKey: string;
  visibilityInfo?: SubscribeVisibilityInfo;
  hash: Hash;
  decryptedKey?: Hash;
}): Promise<void> {
  const { resolverKey, visibilityInfo, hash, decryptedKey } = options;
  let selfEncryptedLinkKey = visibilityInfo?.selfEncryptedLinkKey;
  let visibility = visibilityInfo?.visibility;
  let listEntries: ResolverListVisibilityEntry[] | null = null;

  if (!selfEncryptedLinkKey) {
    const npubStr = resolverKey.split('/')[0];
    const treeName = resolverKey.split('/').slice(1).join('/');
    const resolver = getRefResolver();

    listEntries = await new Promise<ResolverListVisibilityEntry[] | null>((resolve) => {
      let resolved = false;
      const unsub = resolver.list?.(npubStr, (list) => {
        if (resolved) return;
        resolved = true;
        setTimeout(() => unsub?.(), 0);
        const entry = list.find(e => {
          const keyParts = e.key?.split('/');
          const entryTreeName = keyParts?.slice(1).join('/');
          return entryTreeName === treeName;
        });
        resolve(entry ? [entry as ResolverListVisibilityEntry] : null);
      });
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          unsub?.();
          resolve(null);
        }
      }, 2000);
    });

    if (listEntries?.[0]) {
      selfEncryptedLinkKey = listEntries[0].selfEncryptedLinkKey;
      visibility = listEntries[0].visibility as typeof visibility;
    }
  }

  if (visibility !== 'link-visible') return;

  const state = getNostrState();
  const npubStr = resolverKey.split('/')[0];
  const { nip19: nip19Mod } = await import('nostr-tools');
  const decoded = nip19Mod.decode(npubStr);
  const treePubkey = decoded.type === 'npub' ? decoded.data as string : null;
  const isOwner = state.pubkey && treePubkey && state.pubkey === treePubkey;
  if (!isOwner) return;

  const treeName = resolverKey.split('/').slice(1).join('/');
  if (selfEncryptedLinkKey) {
    try {
      const linkKeyHex = await decrypt(state.pubkey!, selfEncryptedLinkKey);
      if (linkKeyHex && linkKeyHex.length === 64 && !window.location.hash.includes('k=')) {
        const separator = window.location.hash.includes('?') ? '&' : '?';
        window.history.replaceState(null, '', window.location.hash + separator + 'k=' + linkKeyHex);
      }
    } catch (e) {
      console.error('[treeRoot] Could not decrypt linkKey:', e);
    }
    return;
  }

  const encryptedKeyHex = visibilityInfo?.encryptedKey ?? listEntries?.[0]?.encryptedKey;
  const selfEncryptedKey = visibilityInfo?.selfEncryptedKey ?? listEntries?.[0]?.selfEncryptedKey;
  logHtreeDebug('treeRoot:migration-check', {
    hasSelfEncryptedKey: !!selfEncryptedKey,
    hasEncryptedKey: !!encryptedKeyHex,
    visibility: visibility ?? null,
  });

  if (encryptedKeyHex && selfEncryptedKey) {
    try {
      const contentKeyHex = await decrypt(state.pubkey!, selfEncryptedKey);
      logHtreeDebug('treeRoot:migration-decrypted', {
        contentKeyHex: contentKeyHex ? contentKeyHex.slice(0, 16) + '...' : null,
        length: contentKeyHex?.length ?? null,
      });
      if (contentKeyHex && contentKeyHex.length === 64) {
        const linkKeyHex = visibilityHex.encryptKeyForLink(contentKeyHex, encryptedKeyHex);
        if (!window.location.hash.includes('k=')) {
          const separator = window.location.hash.includes('?') ? '&' : '?';
          window.history.replaceState(null, '', window.location.hash + separator + 'k=' + linkKeyHex);
        }
        try {
          const resolver = getRefResolver();
          if (!resolver.publish) throw new Error('Resolver does not support publish');
          await resolver.publish(treeName, cid(hash, fromHex(contentKeyHex)), {
            visibility: 'link-visible',
            linkKey: fromHex(linkKeyHex),
          });
        } catch (e) {
          console.debug('[treeRoot] Migration republish failed:', e);
        }
      }
    } catch (e) {
      console.debug('[treeRoot] Could not derive linkKey from selfEncryptedKey:', e);
    }
    return;
  }

  if (!encryptedKeyHex) return;

  const { getLocalRootKey } = await import('../treeRootCache');
  const cachedKey = getLocalRootKey(npubStr, treeName);
  const contentKey = decryptedKey || cachedKey;
  logHtreeDebug('treeRoot:migration-fallback', {
    hasDecryptedKey: !!decryptedKey,
    hasCachedKey: !!cachedKey,
    hasContentKey: !!contentKey,
    encryptedKeyHex: encryptedKeyHex.slice(0, 16) + '...',
  });
  if (!contentKey) {
    logHtreeDebug('treeRoot:migration-no-content-key');
    return;
  }

  try {
    const contentKeyHex = toHex(contentKey);
    const linkKeyHex = visibilityHex.encryptKeyForLink(contentKeyHex, encryptedKeyHex);
    if (!window.location.hash.includes('k=')) {
      const separator = window.location.hash.includes('?') ? '&' : '?';
      window.history.replaceState(null, '', window.location.hash + separator + 'k=' + linkKeyHex);
    }
    const resolver = getRefResolver();
    if (!resolver.publish) throw new Error('Resolver does not support publish');
    resolver.publish(treeName, cid(hash, contentKey), { visibility: 'link-visible' })
      .catch(e => console.debug('[treeRoot] Migration republish failed:', e));
  } catch (e) {
    console.debug('[treeRoot] Could not derive linkKey from contentKey:', e);
  }
}
