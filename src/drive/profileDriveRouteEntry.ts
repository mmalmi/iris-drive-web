import {
  LinkType,
  type CID,
  type HashTree,
  type TreeEntry,
} from '@hashtree/core';
import {
  mutateProfileDriveRoot,
  setProfileDriveEntries,
  spliceEntriesInTree,
  type TreeEntryWrite,
} from './profileDriveMutation';
import { isEditableDriveRouteScope } from './profileRoute';
import { activeShareScope } from './shareScope';
import { withModifiedAt } from '../lib/modifiedAt';

type DriveRoute = {
  npub: string | null | undefined;
  treeName: string | null | undefined;
};

type EditableNostrState = {
  isLoggedIn: boolean;
  pubkey: string | null;
};

export interface DriveEntryWrite {
  parentPath: string[];
  name: string;
  entry: Omit<TreeEntry, 'name'>;
  /** Keep existing `meta.modified_at` untouched (used when affirming an identical remote Trash entry). */
  preserveModifiedAt?: boolean;
}

/**
 * Route entry writes through the durable profile-Drive mutation protocol when
 * the current tree is scoped to the active profile UUID, splicing all entries
 * bottom-up in one pass. Legacy npub, permalink, and local trees retain plain
 * HashTree behavior while also batching parent creation and folder writes.
 */
export async function setEntriesForDriveRoute(
  tree: HashTree,
  root: CID,
  items: readonly DriveEntryWrite[],
  route: DriveRoute,
  state: EditableNostrState,
): Promise<CID> {
  if (items.length === 0) return root;
  const writes: TreeEntryWrite[] = [];

  if (route.treeName && isEditableDriveRouteScope(route.npub, state)) {
    const share = route.treeName === 'main' ? activeShareScope(route.npub, state) : null;
    let shareTools: {
      key: Uint8Array;
      claimCopiedDirectory: typeof import('./fileReturnProtocol').claimCopiedDirectory;
      claimNewFile: typeof import('./fileReturnProtocol').claimNewFile;
      OWNER_META: string;
      REQUEST_META: string;
      RETURNED_META: string;
    } | null = null;

    if (share?.canWrite) {
      const [{ getSecretKey }, proto] = await Promise.all([
        import('../nostr/auth'),
        import('./fileReturnProtocol'),
      ]);
      const key = getSecretKey();
      if (!key) throw new Error('Sign in to change this shared file');
      shareTools = { key, ...proto };
    }

    const parentCache = new Map<string, Promise<Map<string, TreeEntry> | null>>();
    const lookupExisting = async (parentPath: string[], name: string): Promise<TreeEntry | null> => {
      const key = parentPath.join('\0');
      let pending = parentCache.get(key);
      if (!pending) {
        pending = (async () => {
          const parent = parentPath.length > 0
            ? await tree.resolvePath(root, parentPath)
            : { cid: root, type: LinkType.Dir };
          if (!parent?.cid || parent.type !== LinkType.Dir) return null;
          return new Map((await tree.listDirectory(parent.cid)).map((e) => [e.name, e]));
        })();
        parentCache.set(key, pending);
      }
      return (await pending)?.get(name) ?? null;
    };

    for (const item of items) {
      const entry = {
        ...item.entry,
        meta: item.preserveModifiedAt ? item.entry.meta : withModifiedAt(item.entry.meta),
      };
      const path = [...item.parentPath, item.name].flatMap((part) => part.split('/')).filter(Boolean);
      const name = path.at(-1)!;
      const parentPath = path.slice(0, -1);
      if (entry.type === LinkType.Dir) {
        const existing = await lookupExisting(parentPath, name);
        // Directory-upload setup and document initialization are ensure-style
        // writes. Never replace an existing profile directory with a fresh empty
        // directory and silently discard its children.
        if (existing?.type === LinkType.Dir) continue;
        if (share && existing) throw new Error('A shared file already uses this folder name');
      }
      if (share?.canWrite && shareTools) {
        const meta = { ...entry.meta };
        delete meta[shareTools.OWNER_META];
        delete meta[shareTools.REQUEST_META];
        delete meta[shareTools.RETURNED_META];
        entry.meta = meta;
        if (entry.type === LinkType.Dir) {
          entry.cid = await shareTools.claimCopiedDirectory(
            tree,
            entry.cid,
            share.record.share_id,
            share.record.local_profile_id,
            shareTools.key,
          );
        } else {
          const previous = await lookupExisting(parentPath, name);
          if (!previous) {
            meta[shareTools.OWNER_META] = shareTools.claimNewFile(
              share.record.share_id,
              share.record.local_profile_id,
              entry.cid,
              shareTools.key,
            );
          } else if (previous.type === LinkType.Blob && typeof previous.meta?.[shareTools.OWNER_META] === 'string') {
            meta[shareTools.OWNER_META] = previous.meta[shareTools.OWNER_META];
          } else if (previous.type === LinkType.Dir) {
            throw new Error('Choose another name. A shared folder already uses this one.');
          }
        }
      }
      writes.push({ path, entry, ensureDir: entry.type === LinkType.Dir });
    }
    if (writes.length === 0) return root;
    return setProfileDriveEntries(tree, root, writes);
  }

  for (const item of items) {
    writes.push({
      path: [...item.parentPath, item.name].flatMap((part) => part.split('/')).filter(Boolean),
      entry: {
        ...item.entry,
        type: item.entry.type ?? LinkType.Blob,
        meta: item.preserveModifiedAt ? item.entry.meta : withModifiedAt(item.entry.meta),
      },
    });
  }
  return (await spliceEntriesInTree(tree, root, writes)).root;
}

/**
 * Route a single entry write through `setEntriesForDriveRoute`.
 */
export function setEntryForDriveRoute(
  tree: HashTree,
  root: CID,
  parentPath: string[],
  name: string,
  written: Omit<TreeEntry, 'name'>,
  route: DriveRoute,
  state: EditableNostrState,
): Promise<CID> {
  return setEntriesForDriveRoute(tree, root, [{ parentPath, name, entry: written }], route, state);
}

/**
 * Marks the folder at `path` as changed now, keeping all in it: a document's
 * folder, when something inside it is saved. Only the folder's own details
 * change, so no deletion or replacement needs recording, even in a profile
 * Drive. Nothing changes when there is no folder there.
 */
export async function markFolderChanged(tree: HashTree, root: CID, path: string[]): Promise<CID> {
  const name = path.at(-1);
  if (!name) return root;
  const parentPath = path.slice(0, -1);
  const parent = parentPath.length > 0 ? await tree.resolvePath(root, parentPath) : { cid: root, type: LinkType.Dir };
  if (parent?.type !== LinkType.Dir) return root;
  const folder = (await tree.listDirectory(parent.cid)).find((entry) => entry.name === name);
  if (folder?.type !== LinkType.Dir) return root;
  return tree.setEntry(root, parentPath, name, folder.cid, folder.size, LinkType.Dir, withModifiedAt(folder.meta));
}

/**
 * Remove a folder that only this device wrote. On a profile Drive a single
 * marker on the folder covers its contents; a plain tree just drops the entry.
 */
export async function removeOwnDirectoryForDriveRoute(
  tree: HashTree,
  root: CID,
  path: string[],
  route: DriveRoute,
  state: EditableNostrState,
): Promise<CID> {
  if (path.length === 0) return root;
  if (route.treeName && isEditableDriveRouteScope(route.npub, state)) {
    return mutateProfileDriveRoot(tree, root, { type: 'delete', path: path.join('/'), markContents: false });
  }
  if (!await tree.resolvePath(root, path)) return root;
  return tree.removeEntry(root, path.slice(0, -1), path[path.length - 1]);
}
