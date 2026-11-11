import {
  LinkType,
  type CID,
  type HashTree,
  type TreeEntry,
} from '@hashtree/core';
import { mutateProfileDriveRoot } from './profileDriveMutation';
import { isEditableDriveRouteScope } from './profileRoute';

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
 */
export async function setEntryForDriveRoute(
  tree: HashTree,
  root: CID,
  parentPath: string[],
  name: string,
  entry: Omit<TreeEntry, 'name'>,
  route: DriveRoute,
  state: EditableNostrState,
): Promise<CID> {
  if (route.treeName && isEditableDriveRouteScope(route.npub, state)) {
    if (entry.type === LinkType.Dir) {
      const existing = await tree.resolvePath(root, [...parentPath, name]);
      // Directory-upload setup and document initialization are ensure-style
      // writes. Never replace an existing profile directory with a fresh empty
      // directory and silently discard its children.
      if (existing?.type === LinkType.Dir) return root;
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
