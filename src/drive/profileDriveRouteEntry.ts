import {
  LinkType,
  type CID,
  type HashTree,
  type TreeEntry,
} from '@hashtree/core';
import { mutateProfileDriveRoot } from './profileDriveMutation';
import { isActiveNostrIdentityRouteScope } from './profileRoute';

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
  if (route.treeName && isActiveNostrIdentityRouteScope(route.npub, state)) {
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
