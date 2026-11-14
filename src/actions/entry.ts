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

/** Renames an entry of the open tree in the folder at `parentPath`. */
async function renameIn(rootCid: CID, parentPath: string[], oldName: string, newName: string): Promise<void> {
  const tree = getTree();
  const from = [...parentPath, oldName];
  const to = [...parentPath, newName];
  const newRootCid = isProfileDriveMutation()
    ? await mutateProfileDriveRoot(tree, rootCid, { type: 'rename', from: pathString(from), to: pathString(to) })
    : await tree.renameEntry(rootCid, parentPath, oldName, newName);
  // Update local cache (publishes to nostr with throttle)
  autosaveIfOwn(newRootCid);
  followInRecents(from, to);
}

/** Removes an entry of the open tree from the folder at `parentPath`. */
async function removeIn(rootCid: CID, parentPath: string[], name: string): Promise<void> {
  const tree = getTree();
  const newRootCid = isProfileDriveMutation()
    ? await mutateProfileDriveRoot(tree, rootCid, { type: 'delete', path: pathString([...parentPath, name]) })
    : await tree.removeEntry(rootCid, parentPath, name);
  autosaveIfOwn(newRootCid);
  followInRecents([...parentPath, name], null);
}

/** Moves an entry of the open tree from the folder at `parentPath` into the folder at `targetPath`. */
async function moveIn(rootCid: CID, parentPath: string[], name: string, targetPath: string[]): Promise<void> {
  const tree = getTree();
  const from = [...parentPath, name];
  const to = [...targetPath, name];
  const newRootCid = isProfileDriveMutation()
    ? await mutateProfileDriveRoot(tree, rootCid, { type: 'rename', from: pathString(from), to: pathString(to) })
    : await tree.moveEntry(rootCid, parentPath, name, targetPath);
  autosaveIfOwn(newRootCid);
  followInRecents(from, to);
}

// Rename entry
export async function renameEntry(oldName: string, newName: string) {
  if (!newName || oldName === newName) return;

  const rootCid = getCurrentRootCid();
  if (!rootCid) return;

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

  await renameIn(rootCid, parentPath, oldName, newName);

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
  const rootCid = getCurrentRootCid();
  if (!rootCid) return;

  const currentPath = getCurrentPathFromUrl();
  await removeIn(rootCid, currentPath, name);

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
  const rootCid = getCurrentRootCid();
  if (!rootCid) return;

  const route = parseRoute();
  if (route.path.length === 0) return; // Can't delete root

  const parentPath = route.path.slice(0, -1);
  await removeIn(rootCid, parentPath, route.path[route.path.length - 1]);

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
  const rootCid = getCurrentRootCid();
  const route = parseRoute();
  if (!rootCid || route.path.length === 0) return false;

  const oldName = route.path[route.path.length - 1];
  const parentPath = route.path.slice(0, -1);
  if (await getTree().resolvePath(rootCid, pathString([...parentPath, newName]))) return false;

  await renameIn(rootCid, parentPath, oldName, newName);
  navigate(buildRouteUrl(route.npub, route.treeName, [...parentPath, newName], undefined, route.params.get('k')));
  return true;
}

/**
 * Move an entry of the open tree from the folder at `parentPath` into the
 * folder at `targetPath`. What was open inside it stays open where it went.
 */
export async function moveEntryTo(parentPath: string[], name: string, targetPath: string[]): Promise<void> {
  const rootCid = getCurrentRootCid();
  if (!rootCid) throw new Error('Nothing is open');
  const tree = getTree();
  const target = targetPath.length === 0
    ? { cid: rootCid, type: LinkType.Dir }
    : await tree.resolvePath(rootCid, pathString(targetPath));
  if (target?.type !== LinkType.Dir) throw new Error('That folder is no longer there');
  if ((await tree.listDirectory(target.cid)).some((entry) => entry.name === name)) {
    throw new Error(`There is already something called “${name}” there`);
  }

  await moveIn(rootCid, parentPath, name, targetPath);

  const route = parseRoute();
  const from = [...parentPath, name];
  if (from.every((part, index) => route.path[index] === part)) {
    navigate(buildRouteUrl(route.npub, route.treeName, [...targetPath, name, ...route.path.slice(from.length)], undefined, route.params.get('k')));
  }
}
