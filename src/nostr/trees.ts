/**
 * Tree Publishing and Management
 */
import { nip19 } from 'nostr-tools';
import {
  toHex,
  fromHex,
  type CID,
  type TreeVisibility,
} from '@hashtree/core';
import { nostrStore } from './store';
import { ndk } from './ndk';
import { updateLocalRootCache } from '../treeRootCache';
import { parseRoute } from '../utils/route';
import { getRefResolver } from '../refResolver';
import { resolvePublishLabels } from '@iris/hashtree-app/publishLabels';
import { publishNostrIdentityDriveRootIfAvailable } from '../drive/profileDriveRootPublish';
import { activeNostrIdentityRootScope, isActiveNostrIdentityRouteScope } from '../drive/profileRoute';
import { treeRootRegistry } from '../TreeRootRegistry';
import { getWorkerAdapter } from '../workerAdapter';

// Re-export visibility hex helpers from hashtree lib
export { visibilityHex as linkKeyUtils } from '@hashtree/core';

export interface SaveHashtreeOptions {
  visibility?: TreeVisibility;
  /** Link key for link-visible trees - if not provided, one will be generated */
  linkKey?: string;
  /** Additional l-tags to add (e.g., ['docs'] for document trees) */
  labels?: string[];
}

/**
 * Parse visibility from Nostr event tags
 */
export function parseVisibility(tags: string[][]): TreeVisibility {
  const visibility = tags.find((tag) => tag[0] === 'visibility')?.[1];
  return visibility === 'link-visible' || visibility === 'private' ? visibility : 'public';
}

/**
 * Save/publish hashtree to relays
 * Uses the resolver's publish method which handles all visibility encryption.
 * @param name - Tree name
 * @param rootCid - Root CID (hash + optional encryption key)
 * @param options - Visibility options
 * @returns Object with success status and linkKey (for link-visible trees)
 */
export async function saveHashtree(
  name: string,
  rootCid: CID,
  options: SaveHashtreeOptions = {}
): Promise<{ success: boolean; linkKey?: string }> {
  const state = nostrStore.getState();
  if (!state.pubkey || !state.npub) return { success: false };

  const visibility = options.visibility ?? 'public';
  const resolver = getRefResolver();
  const rootScope = activeNostrIdentityRootScope(state) ?? state.npub;

  const currentSelected = state.selectedTree;
  const selectedTreeLabels = currentSelected && currentSelected.name === name && currentSelected.pubkey === state.pubkey
    ? currentSelected.labels
    : undefined;

  const publishLabels = resolvePublishLabels({
    currentLabels: selectedTreeLabels,
    explicitLabels: options.labels,
  });

  // Optimistically update local state for offline-first behavior
  if (currentSelected && currentSelected.name === name && currentSelected.pubkey === state.pubkey) {
    nostrStore.setSelectedTree({
      ...currentSelected,
      labels: publishLabels,
      rootHash: toHex(rootCid.hash),
      rootKey: rootCid.key ? toHex(rootCid.key) : undefined,
      visibility,
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  // Update treeRootCache immediately so local ops don't wait on publish
  updateLocalRootCache(rootScope, name, rootCid.hash, rootCid.key, visibility, publishLabels);

  if (rootScope !== state.npub) {
    const driveRootPublished = await publishNostrIdentityDriveRootIfAvailable(name, rootCid);
    return {
      success: driveRootPublished,
      linkKey: undefined,
    };
  }

  // Use resolver to publish - it handles all visibility encryption
  const result = await resolver.publish?.(
    `${state.npub}/${name}`,
    rootCid,
    {
      visibility,
      linkKey: options.linkKey ? fromHex(options.linkKey) : undefined,
      labels: publishLabels,
    }
  );

  if (!result?.success) {
    return { success: false, linkKey: result?.linkKey ? toHex(result.linkKey) : undefined };
  }

  const driveRootPublished = await publishNostrIdentityDriveRootIfAvailable(name, rootCid);
  if (!driveRootPublished) {
    return { success: false, linkKey: result.linkKey ? toHex(result.linkKey) : undefined };
  }
  pushRootToBlossomInBackground(name, rootCid);

  return {
    success: true,
    linkKey: result.linkKey ? toHex(result.linkKey) : undefined,
  };
}

function pushRootToBlossomInBackground(treeName: string, rootCid: CID): void {
  const adapter = getWorkerAdapter();
  if (!adapter) return;
  void adapter.pushToBlossom(rootCid.hash, rootCid.key, treeName)
    .then((result) => {
      if (result.failed > 0) {
        console.warn(`[nostr] Background file-server push left ${result.failed} block(s) unavailable`);
      }
    })
    .catch((error) => {
      console.warn('[nostr] Background file-server push failed:', error);
    });
}

/**
 * Check if the selected tree belongs to the logged-in user
 */
export function isOwnTree(): boolean {
  const state = nostrStore.getState();
  if (!state.isLoggedIn || !state.pubkey) return false;
  if (state.selectedTree?.pubkey === state.pubkey) return true;

  const route = parseRoute();
  return !!route.treeName && isActiveNostrIdentityRouteScope(route.npub, state);
}

/**
 * Autosave current tree if it's our own.
 * Updates local cache immediately, publishing is throttled.
 * @param rootCid - Root CID (contains hash and optional encryption key)
 */
export function autosaveIfOwn(rootCid: CID): void {
  const state = nostrStore.getState();
  if (!isOwnTree()) return;

  const route = parseRoute();
  const isProfileDriveRoute = !!route.treeName && isActiveNostrIdentityRouteScope(route.npub, state);
  const treeName = isProfileDriveRoute ? route.treeName! : state.selectedTree?.name;
  const rootScope = isProfileDriveRoute ? route.npub! : state.npub;
  if (!treeName || !rootScope) return;

  const selectedTree = state.selectedTree?.name === treeName ? state.selectedTree : null;
  const visibility = isProfileDriveRoute
    ? (treeRootRegistry.getVisibility(rootScope, treeName) ?? selectedTree?.visibility ?? 'private')
    : selectedTree?.visibility;
  const labels = isProfileDriveRoute
    ? (treeRootRegistry.getLabels(rootScope, treeName) ?? selectedTree?.labels)
    : selectedTree?.labels;

  // Update local cache - this triggers throttled publish to Nostr
  // Pass visibility to ensure correct tags are published
  updateLocalRootCache(
    rootScope,
    treeName,
    rootCid.hash,
    rootCid.key,
    visibility,
    labels
  );

  // Update selectedTree state immediately for UI (uses hex for state storage)
  if (!selectedTree) return;
  const rootHash = toHex(rootCid.hash);
  const rootKey = rootCid.key ? toHex(rootCid.key) : undefined;
  nostrStore.setSelectedTree({
    ...selectedTree,
    rootHash,
    rootKey: selectedTree.visibility === 'public' ? rootKey : selectedTree.rootKey,
  });
}

/**
 * Publish tree root to Nostr (called by treeRootCache after throttle)
 * This is the ONLY place that should publish merkle roots.
 *
 * @param cachedVisibility - Visibility from the root cache. Use this first, then fall back to selectedTree.
 */
export async function publishTreeRoot(treeName: string, rootCid: CID, cachedVisibility?: TreeVisibility): Promise<boolean> {
  const state = nostrStore.getState();
  if (!state.pubkey || !ndk.signer) return false;
  const selectedTreeLabels = state.selectedTree?.name === treeName && state.selectedTree.pubkey === state.pubkey
    ? state.selectedTree.labels
    : undefined;

  // Priority: cached visibility > selectedTree visibility > 'public'
  let visibility: TreeVisibility = cachedVisibility ?? 'public';
  let linkKey: string | undefined;

  // If no cached visibility, try to get from selectedTree
  if (!cachedVisibility) {
    const isOwnSelectedTree = state.selectedTree?.name === treeName &&
      state.selectedTree?.pubkey === state.pubkey;
    if (isOwnSelectedTree && state.selectedTree?.visibility) {
      visibility = state.selectedTree.visibility;
    }
  }

  // For link-visible trees, get the linkKey from the URL
  if (visibility === 'link-visible') {
    const route = parseRoute();
    linkKey = route.params.get('k') ?? undefined;

    // Fallback to stored key when the current URL omits ?k=
    if (!linkKey && state.npub) {
      const { getLinkKey, waitForLinkKeysCache } = await import('../stores/trees');
      linkKey = getLinkKey(state.npub, treeName) ?? undefined;
      if (!linkKey) {
        await waitForLinkKeysCache().catch(() => {});
        linkKey = getLinkKey(state.npub, treeName) ?? undefined;
      }
    }

    if (!linkKey) {
      console.warn('[nostr] Missing link key for link-visible publish', { treeName, npub: state.npub });
      return false;
    }
  }

  const result = await saveHashtree(treeName, rootCid, {
    visibility,
    linkKey,
    labels: selectedTreeLabels,
  });

  return result.success;
}

/**
 * Delete a tree (publishes event without hash to nullify)
 * Tree will disappear from listings but can be re-created with same name
 */
export async function deleteTree(treeName: string): Promise<boolean> {
  const state = nostrStore.getState();
  if (!state.npub) return false;

  // Cancel any pending throttled publish - this is critical!
  const { cancelPendingPublish } = await import('../treeRootCache');
  cancelPendingPublish(state.npub, treeName);

  // Remove from recents store
  const { removeRecentByTreeName } = await import('../stores/recents');
  removeRecentByTreeName(state.npub, treeName);

  const { getRefResolver } = await import('../refResolver');
  const resolver = getRefResolver();

  const key = `${state.npub}/${treeName}`;
  return resolver.delete?.(key) ?? false;
}

/**
 * Get npub from pubkey
 */
export function pubkeyToNpub(pk: string): string {
  return nip19.npubEncode(pk);
}

/**
 * Get pubkey from npub
 */
export function npubToPubkey(npubStr: string): string | null {
  try {
    const decoded = nip19.decode(npubStr);
    if (decoded.type !== 'npub') return null;
    return decoded.data as string;
  } catch {
    return null;
  }
}
