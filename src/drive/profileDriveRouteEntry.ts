import {
  LinkType,
  type CID,
  type HashTree,
  type TreeEntry,
} from '@hashtree/core';
import { mutateProfileDriveRoot, resolveEntry } from './profileDriveMutation';
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

/**
 * Route every entry write through the durable profile-Drive mutation protocol
 * when the current tree is scoped to the active profile UUID. Legacy npub,
 * permalink, and local trees retain the HashTree setEntry behavior unchanged.
 * What is written is marked as changed now, for the list's Last modified.
 */
export async function setEntryForDriveRoute(
  tree: HashTree,
  root: CID,
  parentPath: string[],
  name: string,
  written: Omit<TreeEntry, 'name'>,
  route: DriveRoute,
  state: EditableNostrState,
): Promise<CID> {
  const entry = { ...written, meta: withModifiedAt(written.meta) };
  if (route.treeName && isEditableDriveRouteScope(route.npub, state)) {
    const share = route.treeName === 'main' ? activeShareScope(route.npub, state) : null;
    if (entry.type === LinkType.Dir) {
      const existing = await tree.resolvePath(root, [...parentPath, name]);
      // Directory-upload setup and document initialization are ensure-style
      // writes. Never replace an existing profile directory with a fresh empty
      // directory and silently discard its children.
      if (existing?.type === LinkType.Dir) return root;
      if (share && existing) throw new Error('A shared file already uses this folder name');
    }
    if (share?.canWrite) {
      const { getSecretKey } = await import('../nostr/auth');
      const { claimCopiedDirectory, claimNewFile, OWNER_META, REQUEST_META, RETURNED_META } = await import('./fileReturnProtocol');
      const key = getSecretKey();
      if (!key) throw new Error('Sign in to change this shared file');
      delete entry.meta[OWNER_META];
      delete entry.meta[REQUEST_META];
      delete entry.meta[RETURNED_META];
      if (entry.type === LinkType.Dir) {
        entry.cid = await claimCopiedDirectory(tree, entry.cid, share.record.share_id, share.record.local_profile_id, key);
      } else {
        const previous = await resolveEntry(tree, root, [...parentPath, name]);
        if (!previous) {
          entry.meta[OWNER_META] = claimNewFile(share.record.share_id, share.record.local_profile_id, entry.cid, key);
        } else if (previous.type === LinkType.Blob && typeof previous.meta?.[OWNER_META] === 'string') {
          entry.meta[OWNER_META] = previous.meta[OWNER_META];
        } else if (previous.type === LinkType.Dir) {
          throw new Error('Choose another name. A shared folder already uses this one.');
        }
      }
    }
    return mutateProfileDriveRoot(tree, root, {
      type: 'set-entry',
      path: [...parentPath, name].filter(Boolean).join('/'),
      entry,
    });
  }
  // The profile-Drive mutation creates missing parents itself; a plain tree needs them first.
  for (let depth = 1; depth <= parentPath.length; depth += 1) {
    const prefix = parentPath.slice(0, depth);
    if (await tree.resolvePath(root, prefix)) continue;
    const empty = await tree.putDirectory([]);
    root = await tree.setEntry(root, prefix.slice(0, -1), prefix[prefix.length - 1], empty.cid, 0, LinkType.Dir);
  }
  return tree.setEntry(
    root,
    parentPath,
    name,
    entry.cid,
    entry.size,
    entry.type ?? LinkType.Blob,
    entry.meta,
  );
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
