/**
 * Tree operations - create and fork trees
 */
import { navigate } from '../utils/navigate';
import { documentFolderName } from '../lib/documentNames';
import { parseRoute } from '../utils/route';
import { toHex, LinkType } from '@hashtree/core';
import type { CID } from '@hashtree/core';
import { saveHashtree, useNostrStore } from '../nostr';
import { nip19 } from 'nostr-tools';
import { getTree } from '../store';
import { autosaveIfOwn } from '../nostr';
import { getCurrentRootCid, getCurrentPathFromUrl } from './route';
import { getLocalRootCache, updateLocalRootCache } from '../treeRootCache';
import { activeNostrIdentityRootScope, isEditableDriveRouteScope } from '../drive/profileRoute';
import { setEntryForDriveRoute } from '../drive/profileDriveRouteEntry';
import { captureRouteWriteGuard } from '../lib/routeWriteGuard';
export { forkTree } from './treeFork';

type DirectoryEntryInput = { name: string; cid: CID; size: number; type?: LinkType };

// Helper to initialize a virtual tree (when rootCid is null but we're in a tree route)
export async function initVirtualTree(entries: DirectoryEntryInput[]): Promise<CID | null> {
  const isCurrent = captureRouteWriteGuard();
  const route = parseRoute();
  if (!route.npub || !route.treeName) return null;

  const tree = getTree();
  const nostrStore = useNostrStore.getState();

  const isProfileDriveRoute = isEditableDriveRouteScope(route.npub, nostrStore);
  let routePubkey: string;
  if (isProfileDriveRoute) {
    if (!nostrStore.pubkey) return null;
    routePubkey = nostrStore.pubkey;
  } else {
    try {
      const decoded = nip19.decode(route.npub);
      if (decoded.type !== 'npub') return null;
      routePubkey = decoded.data as string;
    } catch {
      return null;
    }
  }

  const isOwnTree = isProfileDriveRoute || routePubkey === nostrStore.pubkey;
  if (!isOwnTree) return null; // Can only create in own trees

  // Create new encrypted tree with the entries (using DirEntry format)
  const dirEntries = entries.map(e => ({
    name: e.name,
    cid: e.cid,
    size: e.size,
    type: e.type ?? LinkType.Blob,
  }));
  const { cid: newRootCid } = await tree.putDirectory(dirEntries);

  // Preserve current tree's visibility when updating
  const currentVisibility = nostrStore.selectedTree?.visibility ?? (isProfileDriveRoute ? 'private' : 'public');

  // Update UI state immediately (uses hex for storage)
  if (!isCurrent()) return null;
  useNostrStore.setSelectedTree({
    id: '',
    name: route.treeName,
    pubkey: routePubkey,
    labels: nostrStore.selectedTree?.labels,
    rootHash: toHex(newRootCid.hash),
    rootKey: newRootCid.key ? toHex(newRootCid.key) : undefined,
    visibility: currentVisibility,
    created_at: Math.floor(Date.now() / 1000),
  });

  if (isProfileDriveRoute) {
    updateLocalRootCache(route.npub, route.treeName, newRootCid.hash, newRootCid.key, currentVisibility);
  } else {
    // Save to Nostr (fire-and-forget, also updates local cache)
    void saveHashtree(route.treeName, newRootCid, { visibility: currentVisibility });
  }

  return newRootCid;
}

// Create new folder
export async function createFolder(name: string) {
  const isCurrent = captureRouteWriteGuard();
  if (!name) return;

  const rootCid = getCurrentRootCid();
  const tree = getTree();
  const currentPath = getCurrentPathFromUrl();

  // putDirectory returns CID (encrypted by default)
  const { cid: emptyDirCid } = await tree.putDirectory([]);

  if (rootCid) {
    // Add to existing tree
    if (!isCurrent()) return;
    const newRootCid = await setEntryForDriveRoute(
      tree,
      rootCid,
      currentPath,
      name,
      { cid: emptyDirCid, size: 0, type: LinkType.Dir },
      parseRoute(),
      useNostrStore.getState(),
    );
    // Publish to nostr - resolver will pick up the update
    if (!isCurrent()) return;
    autosaveIfOwn(newRootCid);
  } else {
    // Initialize virtual tree with this folder
    if (!isCurrent()) return;
    await initVirtualTree([{ name, cid: emptyDirCid, size: 0, type: LinkType.Dir }]);
  }
}

/** A document is a folder named for it; the editor fills it on the first save. */
export async function createDocument(title: string): Promise<string | null> {
  const folderName = documentFolderName(title);
  if (!title.trim()) return null;
  await createFolder(folderName);
  return folderName;
}

// Create a new tree (top-level folder on nostr or local)
// Creates encrypted trees by default
// Set skipNavigation=true to create without navigating (for batch creation)
export async function createTree(name: string, visibility: import('@hashtree/core').TreeVisibility = 'public', skipNavigation = false): Promise<{ success: boolean; linkKey?: string }> {
  if (!name) return { success: false };

  const { saveHashtree } = await import('../nostr');
  const { storeLinkKey } = await import('../stores/trees');

  const tree = getTree();
  // Create encrypted empty directory (default)
  const { cid: rootCid } = await tree.putDirectory([]);

  const nostrState = useNostrStore.getState();

  // If logged in, publish to nostr
  if (nostrState.isLoggedIn && nostrState.npub && nostrState.pubkey) {
    const rootScope = activeNostrIdentityRootScope(nostrState) ?? nostrState.npub;
    // Background default-tree creation races with immediate user uploads after
    // login. Re-check after the async putDirectory call so an empty initializer
    // never replaces a real root that appeared while it was being prepared.
    if (skipNavigation && getLocalRootCache(rootScope, name)) {
      return { success: true };
    }
    // Set selectedTree BEFORE saving so updates work (only if we're navigating)
    if (!skipNavigation) {
      useNostrStore.setSelectedTree({
        id: '', // Will be set by actual nostr event
        name,
        pubkey: nostrState.pubkey,
        rootHash: toHex(rootCid.hash),
        rootKey: rootCid.key ? toHex(rootCid.key) : undefined,
        visibility,
        created_at: Math.floor(Date.now() / 1000),
      });
    }

    // Save to Nostr (also updates local cache immediately for subsequent operations)
    const result = await saveHashtree(name, rootCid, { visibility });

    // For link-visible trees, store link key locally and append to URL
    if (result.linkKey) {
      storeLinkKey(rootScope, name, result.linkKey);
    }

    if (!skipNavigation) {
      const linkKeyParam = result.linkKey ? `?k=${result.linkKey}` : '';
      navigate(`/${encodeURIComponent(rootScope)}/${encodeURIComponent(name)}${linkKeyParam}`);
    }
    return result;
  }

  // Not logged in - can't create trees without nostr
  return { success: false };
}

