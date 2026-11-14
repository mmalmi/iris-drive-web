/**
 * Where a form's inbox key and responses are kept: a hidden folder at the top
 * of the My Drive of whoever made the form, never inside the form itself.
 *
 * My Drive's top level cannot be shared, by link or with people, so the key
 * and the responses reach only that account's own devices, wherever the form
 * is and whoever else can open or edit it. The folder syncs between those
 * devices like any other, and every file in it is written once under a name
 * of its own, which the Drive merges cleanly.
 *
 *   .iris-forms/<inbox pubkey>/key.json
 *   .iris-forms/<inbox pubkey>/responses/<response id>.json
 */
import { LinkType, toHex, type CID, type TreeEntry } from '@hashtree/core';
import { getTree } from '../../store';
import { nostrStore, saveOwnTreeRoot } from '../../nostr';
import { getTreeRootSync, subscribeToTreeRoot } from '../../stores';
import { activeNostrIdentityRootScope } from '../../drive/profileRoute';
import { setEntryForDriveRoute } from '../../drive/profileDriveRouteEntry';
import { flushPendingPublishes } from '../../treeRootCache';
import { withDriveRootLock } from '../driveRootTabs';
import { inTurn } from '../driveWrites';

export const FORMS_FOLDER = '.iris-forms';
const TREE = 'main';

function sameCid(left: CID | null, right: CID | null): boolean {
  if (!left || !right) return left === right;
  return toHex(left.hash) === toHex(right.hash) && (left.key ? toHex(left.key) : '') === (right.key ? toHex(right.key) : '');
}

/** The signed-in account's My Drive, or null. */
function ownScope(): string | null {
  const state = nostrStore.getState();
  return state.pubkey ? activeNostrIdentityRootScope(state) : null;
}

/** Whether this device can keep a form's key and responses now: signed in, with My Drive loaded. */
export function canKeepForms(): boolean {
  const scope = ownScope();
  return !!scope && !!getTreeRootSync(scope, TREE);
}

/** The entries of a folder under `.iris-forms`, read from this device's copy; empty when there is none. */
export async function listFormFolder(path: string[]): Promise<TreeEntry[]> {
  const scope = ownScope();
  const root = scope ? getTreeRootSync(scope, TREE) : null;
  if (!root) return [];
  try {
    const tree = getTree();
    const folder = await tree.resolvePath(root, [FORMS_FOLDER, ...path]);
    return folder?.type === LinkType.Dir ? await tree.listDirectory(folder.cid) : [];
  } catch {
    return [];
  }
}

export async function readFormFile(entry: TreeEntry): Promise<Uint8Array | null> {
  try {
    return await getTree().readFile(entry.cid);
  } catch {
    return null;
  }
}

/** Calls back whenever this account's My Drive changes. */
export function onOwnDriveChange(callback: () => void): () => void {
  const scope = ownScope();
  if (!scope) return () => {};
  return subscribeToTreeRoot(scope, TREE, () => callback());
}

/**
 * Adds files under `.iris-forms` in one change of My Drive. Never writes over
 * a Drive this device has not loaded: that would replace it.
 */
export async function writeFormFiles(files: Array<{ path: string[]; data: Uint8Array }>): Promise<void> {
  const scope = ownScope();
  if (!scope) throw new Error('Sign in to keep responses');
  const tree = getTree();
  const stored = await Promise.all(files.map(async (file) => ({ path: [FORMS_FOLDER, ...file.path], ...(await tree.putFile(file.data)) })));
  await inTurn(() => withDriveRootLock(scope, TREE, async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const base = getTreeRootSync(scope, TREE);
      if (!base) throw new Error('My Drive has not loaded yet');
      let root = base;
      for (const file of stored) {
        root = await setEntryForDriveRoute(
          tree,
          root,
          file.path.slice(0, -1),
          file.path[file.path.length - 1]!,
          { cid: file.cid, size: file.size, type: LinkType.Blob },
          { npub: scope, treeName: TREE },
          nostrStore.getState(),
        );
      }
      // Another write landed while this one was prepared: redo it on the newer Drive.
      if (!sameCid(getTreeRootSync(scope, TREE), base)) continue;
      if (!saveOwnTreeRoot(scope, TREE, root)) throw new Error('My Drive cannot be changed here');
      void flushPendingPublishes().catch(() => {});
      return;
    }
    throw new Error('My Drive kept changing while saving');
  }));
}
