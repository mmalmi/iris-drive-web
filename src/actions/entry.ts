/**
 * Entry operations - rename, delete, move entries
 */
import { navigate } from '../utils/navigate';
import { parseRoute } from '../utils/route';
import { autosaveIfOwn, nostrStore } from '../nostr';
import { getTree } from '../store';
import { LinkType, type CID } from '@hashtree/core';
import { getCurrentRootCid, getCurrentPathFromUrl, buildRouteUrl, updateRoute } from './route';
import { activeNostrIdentityRootScope, isEditableDriveRouteScope } from '../drive/profileRoute';
import { followLinkShares } from '../drive/linkShareSync';
import { mutateProfileDriveRoot } from '../drive/profileDriveMutation';
import { moveRecents } from '../stores/recents';
import { inTurn } from '../lib/driveWrites';

function isProfileDriveMutation(): boolean {
  const route = parseRoute();
  return !!route.treeName && isEditableDriveRouteScope(route.npub, nostrStore.getState());
}

function pathString(parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

/** Moves Recent and links along with an entry of the open tree, or drops them when `to` is null. */
function followInRecents(from: string[], to: string[] | null) {
  const route = parseRoute();
  if (!route.npub || !route.treeName) return;
  const at = (parts: string[]) => `/${route.npub}/${route.treeName}/${pathString(parts)}`;
  moveRecents(at(from), to ? at(to) : null);
  if (route.treeName === 'main' && route.npub === activeNostrIdentityRootScope(nostrStore.getState())) followLinkShares(from, to);
}

/**
 * Changes the open tree in turn with every other change this page makes to a
 * Drive (see driveWrites), from its root as the change before saved it, so
 * that neither drops what the other did. `change` gives the new root, or null
 * to change nothing. Resolves whether it saved one.
 */
function changeOpenTree(change: (root: CID) => Promise<CID | null>): Promise<boolean> {
  const started = parseRoute();
  const sameTree = () => {
    const route = parseRoute();
    return route.npub === started.npub && route.treeName === started.treeName;
  };
  return inTurn(async () => {
    const root = sameTree() ? getCurrentRootCid() : null;
    if (!root) return false;
    const next = await change(root);
    if (!next) return false;
    if (!sameTree()) throw new Error('The folder was left before the change could be saved');
    // Update local cache (publishes to nostr with throttle)
    autosaveIfOwn(next);
    return true;
  });
}

/** Renames an entry of `root` in the folder at `parentPath`. */
function renameIn(root: CID, parentPath: string[], oldName: string, newName: string): Promise<CID> {
  const tree = getTree();
  return isProfileDriveMutation()
    ? mutateProfileDriveRoot(tree, root, {
      type: 'rename',
      from: pathString([...parentPath, oldName]),
      to: pathString([...parentPath, newName]),
    })
    : tree.renameEntry(root, parentPath, oldName, newName);
}

/** Removes an entry of `root` from the folder at `parentPath`. */
function removeIn(root: CID, parentPath: string[], name: string): Promise<CID> {
  const tree = getTree();
  return isProfileDriveMutation()
    ? mutateProfileDriveRoot(tree, root, { type: 'delete', path: pathString([...parentPath, name]) })
    : tree.removeEntry(root, parentPath, name);
}

/** Moves an entry of `root` from the folder at `parentPath` into the folder at `targetPath`. */
function moveIn(root: CID, parentPath: string[], name: string, targetPath: string[]): Promise<CID> {
  const tree = getTree();
  return isProfileDriveMutation()
    ? mutateProfileDriveRoot(tree, root, {
      type: 'rename',
      from: pathString([...parentPath, name]),
      to: pathString([...targetPath, name]),
    })
    : tree.moveEntry(root, parentPath, name, targetPath);
}

// Rename entry
export async function renameEntry(oldName: string, newName: string) {
  if (!newName || oldName === newName) return;

  const route = parseRoute();
  const urlPath = route.path;

  // Check if we're renaming the current directory (we're inside it)
  const lastSegment = urlPath.length > 0 ? urlPath[urlPath.length - 1] : null;
  const isRenamingCurrentDir = lastSegment === oldName && !/\.[a-zA-Z0-9]+$/.test(oldName);

  let parentPath: string[];
  if (isRenamingCurrentDir) {
    // Renaming current directory - parent is everything except last segment
    parentPath = urlPath.slice(0, -1);
  } else {
    // Renaming item within current directory
    parentPath = getCurrentPathFromUrl();
  }

  if (!await changeOpenTree(root => renameIn(root, parentPath, oldName, newName))) return;
  followInRecents([...parentPath, oldName], [...parentPath, newName]);

  // Update URL if renamed file/dir was selected or we're inside it
  if (isRenamingCurrentDir) {
    // Navigate to the renamed directory
    const newPath = [...parentPath, newName];
    const url = buildRouteUrl(route.npub, route.treeName, newPath, undefined, route.params.get('k'));
    navigate(url);
  } else if (lastSegment === oldName) {
    updateRoute(newName);
  }
}

// Delete entry
export async function deleteEntry(name: string) {
  const currentPath = getCurrentPathFromUrl();
  if (!await changeOpenTree(root => removeIn(root, currentPath, name))) return;
  followInRecents([...currentPath, name], null);

  // Navigate to directory if deleted file was active
  const route = parseRoute();
  const urlFileName = route.path.length > 0 ? route.path[route.path.length - 1] : null;
  if (urlFileName === name) {
    const url = buildRouteUrl(route.npub, route.treeName, currentPath, undefined, route.params.get('k'));
    navigate(url);
  }
}

// Delete current folder (must be in a subdirectory)
export async function deleteCurrentFolder() {
  const route = parseRoute();
  if (route.path.length === 0) return; // Can't delete root

  const parentPath = route.path.slice(0, -1);
  const name = route.path[route.path.length - 1];
  if (!await changeOpenTree(root => removeIn(root, parentPath, name))) return;
  followInRecents([...parentPath, name], null);

  // Navigate to parent directory
  const url = buildRouteUrl(route.npub, route.treeName, parentPath, undefined, route.params.get('k'));
  navigate(url);
}

/**
 * Gives the folder the page shows another name and goes on showing it under
 * that name. Resolves false, changing nothing, when something in the same
 * place already has the name.
 */
export async function renameCurrentFolder(newName: string): Promise<boolean> {
  const route = parseRoute();
  if (route.path.length === 0) return false;

  const oldName = route.path[route.path.length - 1];
  const parentPath = route.path.slice(0, -1);
  const renamed = await changeOpenTree(async (root) => {
    if (await getTree().resolvePath(root, pathString([...parentPath, newName]))) return null;
    return renameIn(root, parentPath, oldName, newName);
  });
  if (!renamed) return false;
  followInRecents([...parentPath, oldName], [...parentPath, newName]);
  navigate(buildRouteUrl(route.npub, route.treeName, [...parentPath, newName], undefined, route.params.get('k')));
  return true;
}

/**
 * Move an entry of the open tree from the folder at `parentPath` into the
 * folder at `targetPath`. What was open inside it stays open where it went.
 */
export async function moveEntryTo(parentPath: string[], name: string, targetPath: string[]): Promise<void> {
  const tree = getTree();
  const moved = await changeOpenTree(async (root) => {
    const target = targetPath.length === 0
      ? { cid: root, type: LinkType.Dir }
      : await tree.resolvePath(root, pathString(targetPath));
    if (target?.type !== LinkType.Dir) throw new Error('That folder is no longer there');
    if ((await tree.listDirectory(target.cid)).some((entry) => entry.name === name)) {
      throw new Error(`There is already something called “${name}” there`);
    }
    return moveIn(root, parentPath, name, targetPath);
  });
  if (!moved) throw new Error('Nothing is open');
  const from = [...parentPath, name];
  followInRecents(from, [...targetPath, name]);

  const route = parseRoute();
  if (from.every((part, index) => route.path[index] === part)) {
    navigate(buildRouteUrl(route.npub, route.treeName, [...targetPath, name, ...route.path.slice(from.length)], undefined, route.params.get('k')));
  }
}
