import { get } from 'svelte/store';
import { toHex, type CID } from '@hashtree/core';
import { getCurrentNostrIdentitySession, nostrStore } from '../nostr';
import { getTree } from '../store';
import { getTreeRootSync, subscribeToTreeRoot } from '../stores/treeRoot';
import { hasActiveDriveRootScope } from '../stores/treeRootResolver';
import { acceptedShares } from './shareLibrary';
import { projectNostrIdentityRoster } from './protocol';
import { profileDriveProjection } from './profileDriveProjection';
import { publishNostrIdentityDriveRootIfAvailable } from './profileDriveRootPublish';
import { withDriveRootLock } from '../lib/driveRootTabs';
import {
  applyTrashListing, commitTrashDeletion, privateTrashRows, publishedTrash, recoverContents,
  trashHeads, trashMarkers, watchTrash, type TrashItem,
} from '../lib/driveTrash';
import {
  canEncodeTrashPath, insertPrivateTrash, PRIVATE_TRASH, readPrivateTrash, removePrivateTrash,
  sameTrashContent, TRASH_SECONDS, writePrivateTrash, type PrivateTrashNote,
} from './privateTrashTree';

export function isUnsharedTrashPath(account: string, path: string[]): boolean {
  const joined = path.join('/');
  return !get(acceptedShares).some(({ local_profile_id, folder }) => {
    const shared = folder.source_path;
    return local_profile_id === account && folder.owner_profile_id === account && !!shared
      && (joined === shared || joined.startsWith(shared + '/') || shared.startsWith(joined + '/'));
  });
}

function ownerSession(account: string) {
  const session = getCurrentNostrIdentitySession();
  if (session?.status !== 'active' || session.profileId !== account || nostrStore.getState().pubkey !== session.appKeyPubkey) return null;
  return hasActiveDriveRootScope(account) ? session : null;
}
export function canReadPrivateTrash(account: string): boolean { return !!ownerSession(account); }

function noteFor(row: TrashItem): PrivateTrashNote {
  return { v: 1, id: row.id, account: row.account, source_scope: row.scope, tree_name: 'main',
    path: [...row.path, row.entry.name], deleted_at: Math.floor(row.deletedAt / 1000) };
}

async function synchronize(account: string, alive: () => boolean, signal: AbortSignal, handoff = false, confirmId?: string): Promise<void> {
  let confirmed = false;
  const session = ownerSession(account);
  if (!session || !alive()) {
    if (confirmId) throw new Error('The active profile changed');
    return;
  }
  const writer = session.appKeyPubkey;
  const current = () => alive() && ownerSession(account)?.appKeyPubkey === writer;
  const tree = getTree();
  // A tab may have closed after saving My Drive and before committing its Trash rows.
  const prepared = (await privateTrashRows(account)).filter(row => row.sync === 'prepared' && row.ready);
  if (prepared.length) await withDriveRootLock(account, 'main', async () => {
    const main = getTreeRootSync(account, 'main');
    if (!main || !current()) return;
    for (const row of prepared) {
      const path = [...row.path, row.entry.name];
      if (isUnsharedTrashPath(account, path) && !await tree.resolvePath(main, path, signal) && current()) await commitTrashDeletion([row.id]);
    }
  });
  await withDriveRootLock(account, PRIVATE_TRASH, async () => {
    if (!current()) return;
    const roster = projectNostrIdentityRoster(account, session.rosterOps);
    const heads = new Map<string, CID>();
    const addHead = (cid?: CID | null) => { if (cid?.key) heads.set(toHex(cid.hash) + toHex(cid.key), cid); };
    for (const [pubkey, facet] of Object.entries(roster.active_facets)) {
      if (facet.purposes?.includes('app_key') && facet.capabilities?.can_write_roots)
        addHead(profileDriveProjection.contributionRoot(account, PRIVATE_TRASH, pubkey));
    }
    // This browser's persisted contribution includes updates accepted for sending before a reload.
    const saved = await trashHeads.get([account, writer]);
    addHead(saved?.root);
    // A previously used signing key must recover its own contribution before it can replace it.
    if (!saved && !profileDriveProjection.contributionRoot(account, PRIVATE_TRASH, writer)
      && Number(localStorage.getItem(`iris:drive-root-seq:${account}:trash:${writer}`)) > 0) {
      throw new Error('Waiting for this device’s earlier Trash');
    }
    const view = await readPrivateTrash(tree, account, [...heads.values()], signal);
    if (!current()) return;
    const now = Math.floor(Date.now() / 1000);
    const remoteRows = Array.from(view.items.values(), ({ note, entry }): TrashItem => ({
      id: note.id, account, scope: account, treeName: 'main', path: note.path.slice(0, -1), deletedAt: note.deleted_at * 1000,
      entry, ready: true, sync: 'remote',
    }));
    await applyTrashListing(account, remoteRows, new Map(Array.from(view.removed, ([id, marker]) => [id, marker.at])));
    const local = (await privateTrashRows(account)).filter(row => row.sync === 'outgoing');
    const markers = await trashMarkers.where('account').equals(account).toArray();
    const removedIds = new Set(markers.map(marker => marker.id));
    let changed = handoff && heads.size > 0;
    for (const row of local) {
      const note = noteFor(row);
      if (view.removed.has(row.id) || removedIds.has(row.id)) continue;
      if (!canEncodeTrashPath(note.path)) throw new Error('Invalid Trash path');
      const previous = view.items.get(row.id);
      if (previous) {
        if (!sameTrashContent(previous.entry, row.entry) || JSON.stringify(previous.note.path) !== JSON.stringify(note.path)
          || previous.note.deleted_at !== note.deleted_at) throw new Error('Conflicting saved Trash items');
      } else {
        await recoverContents(tree, row);
        await insertPrivateTrash(tree, view, note, row.entry);
        changed = true;
      }
    }
    for (const marker of markers) {
      if (!view.removed.has(marker.id)) { await removePrivateTrash(tree, view, marker.id, marker.at); changed = true; }
    }
    for (const { note } of view.items.values()) {
      if (now >= note.deleted_at + TRASH_SECONDS) { await removePrivateTrash(tree, view, note.id, now); changed = true; }
    }
    if (confirmId && (!view.items.has(confirmId) || view.removed.has(confirmId))) {
      throw new Error('The saved Trash item is no longer available');
    }
    const pending = markers.filter(mark => mark.pending);
    // If our signed head still advertises a consumed payload, compact it too.
    const own = profileDriveProjection.contributionRoot(account, PRIVATE_TRASH, writer) ?? saved?.root;
    if (!changed && !local.length && !pending.length && own && view.removed.size) {
      changed = (await tree.listDirectory(own, signal)).some(slot => view.removed.has(slot.name));
    }
    if (!current() || (!changed && !local.length && !pending.length)) return;
    const root = await writePrivateTrash(tree, view);
    if (!current()) return;
    await trashHeads.put({ account, writer, root });
    if (!await publishNostrIdentityDriveRootIfAvailable(PRIVATE_TRASH, root, { rootScopeId: account, awaitRelay: handoff, confirmStored: !!confirmId })) {
      throw new Error('Private Trash is waiting to sync');
    }
    confirmed = true;
    await publishedTrash(account, local, pending);
  });
  if (confirmId && !confirmed) throw new Error('Waiting for private Trash to sync');
}

export async function handPrivateTrashToDevice(account: string): Promise<void> {
  await synchronize(account, () => true, AbortSignal.timeout(20000), true);
}

export async function confirmOwnerTrashItem(account: string, item: TrashItem): Promise<void> {
  const { archiveTrash, getTrash } = await import('../lib/driveTrash');
  if (await trashMarkers.get([account, item.id])) throw new Error('This Trash item was already restored or removed');
  const previous = (await privateTrashRows(account)).find(row => row.id === item.id);
  if (previous && (!sameTrashContent(previous.entry, item.entry) || previous.deletedAt !== item.deletedAt)) {
    throw new Error('The saved file has changed');
  }
  if (!previous) await archiveTrash(getTree(), [item]);
  if (!ownerSession(account)) throw new Error('The active profile changed');
  await commitTrashDeletion([item.id]);
  await synchronize(account, () => !!ownerSession(account), AbortSignal.timeout(30000), true, item.id);
  if (!await getTrash(item.id, account)) throw new Error('The saved Trash item is unavailable');
}

/** Account changes cancel outstanding reads. Retry pending work on reconnect, change, and while the tab is open. */
export function watchPrivateTrash(account: string): () => void {
  let stopped = false;
  let retry = false;
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout>;
  const controller = new AbortController();
  const run = async () => {
    if (stopped || running) return;
    running = true;
    again = false;
    try {
      await synchronize(account, () => !stopped, AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]));
      retry = false;
    } catch { retry = true; }
    finally { running = false; if (again && !stopped) schedule(); }
  };
  const schedule = () => {
    if (stopped) return;
    if (running) { again = true; return; }
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 100);
  };
  const root = subscribeToTreeRoot(account, PRIVATE_TRASH, schedule);
  const local = watchTrash(schedule);
  const interval = setInterval(() => { if (retry) schedule(); }, 30000);
  window.addEventListener('online', schedule);
  schedule();
  return () => { stopped = true; controller.abort(); clearTimeout(timer); clearInterval(interval); local(); root(); window.removeEventListener('online', schedule); };
}
