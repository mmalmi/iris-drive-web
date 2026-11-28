/**
 * Entry operations - rename, delete, move entries
 */
import { navigate } from '../utils/navigate';
import { isNostrIdentityId, parseRoute } from '../utils/route';
import { autosaveIfOwn, nostrStore } from '../nostr';
import { getTree } from '../store';
import { LinkType, type CID, type HashTree, type TreeEntry } from '@hashtree/core';
import { sameCid } from '../drive/profileDrivePathKindMetadata';
import { getCurrentRootCid, getCurrentPathFromUrl, buildRouteUrl, updateRoute } from './route';
import { activeNostrIdentityRootScope, isEditableDriveRouteScope } from '../drive/profileRoute';
import { followLinkShares, putBackLinkShares } from '../drive/linkShareSync';
import {
  deleteEntriesInFolder,
  deleteProfileDriveEntries,
  moveProfileDriveEntries,
  mutateProfileDriveRoot,
  resolveEntry,
} from '../drive/profileDriveMutation';
import { moveEntriesInTree } from '../lib/moveEntries';
import { setEntriesForDriveRoute, type DriveEntryWrite } from '../drive/profileDriveRouteEntry';
import { moveRecents, putBackRecents } from '../stores/recents';
import type { TrashItem } from '../lib/driveTrash';
import { forgetDeletionHistory, latestDeletion, rememberDeletion } from './deletionHistory';
import { inTurn } from '../lib/driveWrites';
import { freeName } from '../lib/driveClipboard';
import { documentTitle, isDocumentFolderName } from '../lib/documentNames';
import { toast } from '../stores/toast';
import { changeDriveRoot } from '../drive/driveRootChange';
import { linkSubjectAt } from '../drive/linkShares';
import { acceptedShares, type AcceptedShareRecord } from '../drive/shareLibrary';
import { get } from 'svelte/store';

type EntryRoute = Pick<ReturnType<typeof parseRoute>, 'npub' | 'treeName'>;
export type FolderLocation = { scope: string; path: string[] };

function changeFolderTree(scope?: string): typeof changeOpenTree {
  return scope ? (write) => changeDriveRoot(scope, 'main', write) : changeOpenTree;
}

function isProfileDriveMutation(route: EntryRoute = parseRoute()): boolean {
  return !!route.treeName && isEditableDriveRouteScope(route.npub, nostrStore.getState());
}

function pathString(parts: string[]): string {
  return parts.filter(Boolean).join('/');
}

/**
 * Moves Recent and links along with an entry of the open tree, or drops them
 * when `to` is null, remembering the changes a deletion can undo.
 */
function followInRecents(from: string[], to: string[] | null, route: EntryRoute = parseRoute()) {
  if (!route.npub || !route.treeName) return { recents: [], links: [] };
  const at = (parts: string[]) => `/${route.npub}/${route.treeName}/${pathString(parts)}`;
  const recents = moveRecents(at(from), to ? at(to) : null);
  const profile = activeNostrIdentityRootScope(nostrStore.getState());
  const records = get(acceptedShares);
  const subject = route.treeName === 'main' ? linkSubjectAt({ scope: route.npub, path: from }, profile, records) : null;
  const next = to ? linkSubjectAt({ scope: route.npub, path: to }, profile, records) : null;
  const links = subject ? followLinkShares(subject.path, next?.path ?? null, subject.share) : [];
  return { recents, links };
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
function renameIn(root: CID, parentPath: string[], oldName: string, newName: string, route: EntryRoute = parseRoute()): Promise<CID> {
  const tree = getTree();
  return isProfileDriveMutation(route)
    ? mutateProfileDriveRoot(tree, root, {
      type: 'rename',
      from: pathString([...parentPath, oldName]),
      to: pathString([...parentPath, newName]),
    })
    : tree.renameEntry(root, parentPath, oldName, newName);
}

// Rename entry
export async function renameEntry(oldName: string, newName: string, folderPath?: string[]) {
  if (!newName || oldName === newName) return;

  const route = parseRoute();
  const urlPath = route.path;

  // Check if we're renaming the current directory (we're inside it)
  const lastSegment = urlPath.length > 0 ? urlPath[urlPath.length - 1] : null;
  const isRenamingCurrentDir = !folderPath && lastSegment === oldName && !/\.[a-zA-Z0-9]+$/.test(oldName);

  let parentPath: string[];
  if (isRenamingCurrentDir) {
    // Renaming current directory - parent is everything except last segment
    parentPath = urlPath.slice(0, -1);
  } else {
    // Renaming item within current directory
    parentPath = folderPath ?? getCurrentPathFromUrl();
  }

  if (!await changeOpenTree(async root => {
    const account = trashAccount();
    if (account && route.npub !== account && isProfileDriveMutation(route)
      && await resolveEntry(getTree(), root, [...parentPath, newName])) throw new Error('That name is already used in this shared folder');
    return renameIn(root, parentPath, oldName, newName);
  })) return;
  followInRecents([...parentPath, oldName], [...parentPath, newName]);

  // Update URL if renamed file/dir was selected or we're inside it
  if (isRenamingCurrentDir) {
    // Navigate to the renamed directory
    const newPath = [...parentPath, newName];
    const url = buildRouteUrl(route.npub, route.treeName, newPath, undefined, route.params.get('k'));
    navigate(url);
  } else if (lastSegment === oldName && (!folderPath || folderPath.length < urlPath.length)) {
    updateRoute(newName);
  }
}

async function folderAt(tree: HashTree, root: CID, path: string[]): Promise<CID | null> {
  return path.length ? (await tree.resolvePath(root, pathString(path)))?.cid ?? null : root;
}

function trashAccount(state = nostrStore.getState()): string | null {
  return state.isLoggedIn ? activeNostrIdentityRootScope(state) ?? state.npub : null;
}

export function hasTrashAccess(account: string, scope: string, state = nostrStore.getState(), shares?: AcceptedShareRecord[]): boolean {
  return trashAccount(state) === account && (state.npub === scope || isEditableDriveRouteScope(scope, state, shares));
}

function requireTrashAccess(account: string, scope: string): void {
  if (!hasTrashAccess(account, scope)) {
    throw new Error('You need edit access to the original Drive');
  }
}

function sameEntry(a: Pick<TreeEntry, 'cid' | 'type'>, b: Pick<TreeEntry, 'cid' | 'type'>): boolean {
  return a.type === b.type && sameCid(a.cid, b.cid);
}

/** Archive everything before unlinking it, including files inside deleted folders. */
export async function deleteEntries(names: string[], parentPath: string[] = getCurrentPathFromUrl(), albumScope?: string): Promise<void> {
  const route = albumScope ? { npub: albumScope, treeName: 'main' } : parseRoute();
  const account = trashAccount();
  const scope = route.npub ?? nostrStore.getState().npub;
  const treeName = route.treeName;
  if (!account || !scope || !treeName) throw new Error('Sign in to move items to Trash');
  requireTrashAccess(account, scope);
  const profile = isNostrIdentityId(account);
  const privateSync = profile ? await import('../drive/privateTrashSync') : null;
  const { canEncodeTrashPath } = await import('../drive/privateTrashTree');
  if (profile && treeName === 'main') {
    const { ownedShareAtPath } = await import('../drive/sharePeople');
    const mount = scope === account ? ownedShareAtPath(parentPath, account, get(acceptedShares)) : null;
    if (scope !== account || mount) {
      const { removeSharedFiles } = await import('../drive/sharedFileReturn');
      await removeSharedFiles(account, mount?.record.share_id ?? scope, mount?.rest ?? parentPath, names);
      toast.info('Removal requested. The file stays here until its owner has a copy.');
      return;
    }
  }
  const checkSource = () => {
    if (privateSync && treeName === 'main' && (scope !== account
      || names.some(name => !privateSync.isUnsharedTrashPath(account, [...parentPath, name])))) {
      throw new Error('This shared item must stay in its folder until its file owner can recover it.');
    }
  };
  checkSource();
  const { archiveTrash, commitTrashDeletion, forgetTrash } = await import('../lib/driveTrash');
  const tree = getTree();
  const records: TrashItem[] = [];
  let archived = false;
  try {
    await changeDriveRoot(scope, treeName, async root => {
      requireTrashAccess(account, scope);
      const folder = await folderAt(tree, root, parentPath);
      if (!folder) throw new Error('The original folder no longer exists');
      const here = new Map((await tree.listDirectory(folder)).map(entry => [entry.name, entry]));
      if (!archived) {
        for (const name of new Set(names)) {
          const entry = here.get(name);
          if (albumScope && entry?.type !== LinkType.Dir) throw new Error('This folder no longer exists');
          const sync = entry && privateSync && treeName === 'main' && scope === account
            && canEncodeTrashPath([...parentPath, name]) ? 'prepared' : undefined;
          if (sync && !privateSync?.canReadPrivateTrash(account)) throw new Error('This device no longer has access to Trash');
          if (entry) records.push({ id: crypto.randomUUID(), account, scope, treeName, path: parentPath.slice(), entry,
            deletedAt: Date.now(), ready: false, sync });
        }
        if (!records.length) return null;
        try {
          await archiveTrash(tree, records);
        } catch {
          throw new Error('Could not save these items in Trash. Check storage space and file availability.');
        }
        archived = true;
      }
      for (const { entry } of records) {
        const current = here.get(entry.name);
        if (!current || !sameEntry(current, entry)) throw new Error('The selection changed before it could be deleted');
      }
      const deletedNames = records.map(({ entry }) => entry.name);
      const next = isProfileDriveMutation(route)
        ? await deleteProfileDriveEntries(tree, root, parentPath, deletedNames)
        : (await deleteEntriesInFolder(tree, root, parentPath, deletedNames)).root;
      checkSource();
      requireTrashAccess(account, scope);
      return next;
    });
  } catch (error) {
    if (archived) await forgetTrash(records.map(record => record.id));
    throw error;
  }
  if (records.some(record => record.sync)) await commitTrashDeletion(records.map(row => row.id));
  if (!records.length || account !== trashAccount()) return;
  const deleted = records.map(({ id, entry }) => {
    const original = [...parentPath, entry.name];
    return { id, original, ...followInRecents(original, null, route) };
  });
  const current = parseRoute();
  const open = current.path.at(-1);
  if (!albumScope && current.npub === route.npub && current.treeName === treeName && open
      && records.some(({ entry }) => entry.name === open) && pathString(current.path.slice(0, -1)) === pathString(parentPath)) {
    navigate(buildRouteUrl(current.npub, current.treeName, parentPath, undefined, current.params.get('k')));
  }

  const one = records.length === 1 ? records[0]!.entry.name : null;
  const said = one ? `Deleted “${isDocumentFolderName(one) ? documentTitle(one) : one}”` : `Deleted ${records.length} items`;
  rememberDeletion(account, deleted, said, undoLastDeletion);
}

let undoQueue = Promise.resolve();

/** Undo the newest outstanding deletion in this tab, one keyboard press at a time. */
export function undoLastDeletion(): boolean {
  const account = trashAccount();
  if (!account || !latestDeletion(account)) return false;
  undoQueue = undoQueue.then(async () => {
    while (account === trashAccount()) {
      const batch = latestDeletion(account);
      if (!batch) break;
      const ids = batch.map(item => item.id);
      const restored = await restoreTrashItems(account, ids, true);
      if (account !== trashAccount()) return;
      for (const item of batch) {
        if (JSON.stringify(restored.get(item.id)) !== JSON.stringify(item.original)) continue;
        putBackRecents(item.recents);
        putBackLinkShares(item.links);
      }
      if (restored.size) break;
    }
  }).catch(error => {
    if (account === trashAccount()) toast.error(error instanceof Error ? error.message : 'Could not undo the deletion');
  });
  return true;
}

/** Restore one selection to its original Drive, including after leaving that folder or restarting. */
export async function restoreTrashItems(account: string, ids: string[], skipMissing = false): Promise<Map<string, string[]>> {
  const { getTrash, recoverContents, rememberDestinations, forgetTrash } = await import('../lib/driveTrash');
  const selected = await Promise.all(ids.map(id => getTrash(id, account)));
  const first = selected.find(Boolean);
  if (!first) {
    if (!skipMissing) throw new Error('This item is no longer in Trash');
    forgetDeletionHistory(ids);
    return new Map();
  }
  const { scope, treeName } = first;
  requireTrashAccess(account, scope);
  const privateSync = selected.some(row => row?.sync) ? await import('../drive/privateTrashSync') : null;
  if (privateSync) {
    if (!privateSync.canReadPrivateTrash(account)) throw new Error('This device no longer has access to Trash');
    const { getTreeRootSync, waitForTreeRoot } = await import('../stores/treeRoot');
    if (!getTreeRootSync(scope, treeName) && !await waitForTreeRoot(scope, treeName, 20000)) {
      throw new Error('My Drive is still loading. Try Restore again.');
    }
  }
  const tree = getTree();
  const restored = new Map<string, string[]>();
  await changeDriveRoot(scope, treeName, async root => {
    requireTrashAccess(account, scope);
    restored.clear();
    const writes: DriveEntryWrite[] = [];
    let next = root;
    const parentListings = new Map<string, { siblings: Map<string, TreeEntry>; taken: Set<string> }>();
    const flush = async () => {
      if (!writes.length) return;
      next = await setEntriesForDriveRoute(tree, next, writes, { npub: scope, treeName }, nostrStore.getState());
      writes.length = 0;
      parentListings.clear();
    };
    const contains = (parent: string[], child: string[]) => parent.length <= child.length
      && parent.every((part, index) => part === child[index]);
    const readParent = async (parent: string[]) => {
      const key = parent.join('\0');
      let cached = parentListings.get(key);
      if (!cached) {
        const folder = await folderAt(tree, next, parent);
        const list = folder ? await tree.listDirectory(folder) : [];
        cached = {
          siblings: new Map(list.map((item) => [item.name, item])),
          taken: new Set(list.map((item) => item.name)),
        };
        parentListings.set(key, cached);
      }
      return cached;
    };
    for (const id of ids) {
      const record = await getTrash(id, account);
      if (!record) continue;
      if (record.sync && privateSync) {
        if (!privateSync.isUnsharedTrashPath(account, [...record.path, record.entry.name])) throw new Error('The original folder is now shared');
      }
      if (record.scope !== scope || record.treeName !== treeName) throw new Error('The selection belongs to several Drives');
      await recoverContents(tree, record);
      const { entry } = record;
      // Restoring a folder and one of its former children must see earlier
      // restored contents when resolving collisions and blocked parents.
      if (writes.some(write => contains([...write.parentPath, write.name], record.path)
        || contains([...record.path, entry.name], write.parentPath))) await flush();
      // A saved tree and its Trash row are in different stores. If the tab closed
      // between those commits, finish the pending restore without adding a second copy.
      if (record.destination) {
        const existing = await tree.resolvePath(next, record.destination);
        if (existing && sameEntry(existing, entry)) {
          restored.set(id, record.destination);
          continue;
        }
      }
      let parent = record.path;
      // Recreate missing parents. If a file took a parent's name, keep that file
      // and restore to the nearest containing folder instead.
      for (let depth = 1; depth <= parent.length; depth++) {
        const ancestor = await tree.resolvePath(next, parent.slice(0, depth));
        if (!ancestor) break;
        if (ancestor.type !== LinkType.Dir) {
          parent = parent.slice(0, depth - 1);
          break;
        }
      }
      const { siblings, taken } = await readParent(parent);
      const original = siblings.get(entry.name);
      // The signed Trash and My Drive roots can arrive in either order. If the
      // original bytes are already at their path, affirm that entry in this
      // restore instead of manufacturing a second, suffixed copy.
      const identical = record.sync === 'remote' && !!original && sameEntry(original, entry)
        && parent.length === record.path.length;
      const name = identical ? entry.name : freeName(entry.name, taken, entry.type !== LinkType.Dir || isDocumentFolderName(entry.name));
      taken.add(name);
      const destination = [...parent, name];
      writes.push({ parentPath: parent, name, entry, preserveModifiedAt: identical });
      restored.set(id, destination);
    }
    await flush();
    requireTrashAccess(account, scope);
    if (privateSync && (!privateSync.canReadPrivateTrash(account)
      || [...restored.values()].some(path => !privateSync.isUnsharedTrashPath(account, path)))) {
      throw new Error('Access to the restore destination changed');
    }
    await rememberDestinations(account, restored);
    return next === root ? null : next;
  }, { verifyRestore: !!privateSync });
  await forgetTrash([...restored.keys()], true);
  forgetDeletionHistory(ids);
  return restored;
}

/** Deletes an item of the open folder; see deleteEntries. */
export function deleteEntry(name: string, parentPath?: string[]): Promise<void> {
  return deleteEntries([name], parentPath);
}

/** Deletes the folder the page shows, and goes to the one it was in; see deleteEntries. */
export async function deleteCurrentFolder(): Promise<void> {
  const route = parseRoute();
  if (route.path.length === 0) return; // Can't delete root
  const parentPath = route.path.slice(0, -1);
  await deleteEntries([route.path.at(-1)!], parentPath);
}

/**
 * Gives the folder the page shows another name and goes on showing it under
 * that name. Resolves false, changing nothing, when something in the same
 * place already has the name.
 */
export async function renameCurrentFolder(newName: string, folder?: FolderLocation): Promise<boolean> {
  const current = parseRoute();
  const route = folder ? { npub: folder.scope, treeName: 'main', path: folder.path } : current;
  if (route.path.length === 0) return false;

  const oldName = route.path[route.path.length - 1];
  const parentPath = route.path.slice(0, -1);
  const change = changeFolderTree(folder?.scope);
  const renamed = await change(async (root) => {
    if (await getTree().resolvePath(root, pathString([...parentPath, newName]))) return null;
    if (folder && (await getTree().resolvePath(root, route.path))?.type !== LinkType.Dir) throw new Error('This folder no longer exists');
    return renameIn(root, parentPath, oldName, newName, route);
  });
  if (!renamed) return false;
  followInRecents([...parentPath, oldName], [...parentPath, newName], route);
  if (!folder) navigate(buildRouteUrl(current.npub, current.treeName, [...parentPath, newName], undefined, current.params.get('k')));
  return true;
}

/**
 * Move a selection in one queued change and save. What was open inside it
 * stays open under its final name.
 */
export async function moveEntriesTo(
  parentPath: string[], names: string[], targetPath: string[], expected?: ReadonlyMap<string, string>,
): Promise<Map<string, string>> {
  const destinations = new Map<string, string>();
  if (!names.length) return destinations;
  const started = parseRoute();
  const tree = getTree();
  const account = nostrStore.getState().pubkey;
  const { npub: scope, treeName } = started;
  const change = expected && scope && treeName
    ? (work: Parameters<typeof changeOpenTree>[0]) => changeDriveRoot(scope, treeName, work)
    : changeOpenTree;
  const saved = await change(async root => {
    destinations.clear();
    const move = isProfileDriveMutation(started) ? moveProfileDriveEntries : moveEntriesInTree;
    const result = await move(tree, root, parentPath, names, targetPath, expected);
    for (const { entry, destinationName } of result.items) {
      destinations.set(entry.name, destinationName);
    }
    if (expected && account !== nostrStore.getState().pubkey) throw new Error('The active profile changed');
    return result.root;
  });
  if (!saved) throw new Error('Nothing is open');
  for (const [name, destination] of destinations) {
    followInRecents([...parentPath, name], [...targetPath, destination], started);
  }

  const route = parseRoute();
  const destination = destinations.get(route.path[parentPath.length]);
  if (destination && route.npub === started.npub && route.treeName === started.treeName
      && parentPath.every((part, i) => route.path[i] === part)) {
    const path = [...targetPath, destination, ...route.path.slice(parentPath.length + 1)];
    navigate(buildRouteUrl(route.npub, route.treeName, path, undefined, route.params.get('k')));
  }
  return destinations;
}

/** Move one entry using the same validation and save as a selection. */
export async function moveEntryTo(parentPath: string[], name: string, targetPath: string[]): Promise<void> {
  await moveEntriesTo(parentPath, [name], targetPath);
}
