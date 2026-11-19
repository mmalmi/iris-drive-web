import Dexie, { type Table } from 'dexie';
import { getPublicKey, type Event } from 'nostr-tools';
import { LinkType, type CID, type TreeEntry } from '@hashtree/core';
import { getCurrentNostrIdentitySession, getSecretKey } from '../nostr/auth';
import { nostr } from '../nostr';
import { getTree } from '../store';
import { publishEvent } from '../lib/nostrPublish';
import { getTreeRootSync, waitForTreeRoot, subscribeToTreeRoot } from '../stores/treeRoot';
import { acceptedShares } from './shareLibrary';
import { freeName } from '../lib/driveClipboard';
import { changeDriveRoot } from './driveRootChange';
import { activeShareScope } from './shareScope';
import { projectNostrIdentityRoster, KIND_DRIVE_ROOT } from './protocol';
import { projectSharedFolderKeys } from './protocolShareSnapshot';
import { profileDriveProjection } from './profileDriveProjection';
import { resolveEntry, mutateProfileDriveRoot } from './profileDriveMutation';
import { publishNostrIdentityDriveRootIfAvailable } from './profileDriveRootPublish';
import { finishFileReturn, verifyMarker } from './fileReturnMarker';
import {
  OWNER_META,
  REQUEST_META,
  RETURNED_META,
  RETURN_LABEL,
  currentReturn,
  fileRevision,
  openReturnNote,
  readFileOwner,
  requestFileReturn,
  returnNotes,
  type Signed,
  type ReturnRequest,
} from './fileReturnProtocol';

const db = new Dexie('iris-drive-file-returns');
db.version(1).stores({ jobs: '[account+id],[account+state]' });
interface Job {
  account: string;
  id: string;
  event?: Event;
  outgoing: boolean;
  state: 'pending' | 'done';
}
const jobs: Table<Job, [string, string]> = db.table('jobs');
const listeners = new Set<() => void>();
function wake() {
  for (const listen of listeners) listen();
}

function active(account: string, shareId: string) {
  const session = getCurrentNostrIdentitySession();
  const key = getSecretKey();
  const share = activeShareScope(shareId);
  if (
    !key ||
    !session ||
    session.status !== 'active' ||
    session.profileId !== account ||
    session.appKeyPubkey !== getPublicKey(key) ||
    share?.record.local_profile_id !== account
  )
    throw new Error('Shared folder access has changed');
  const own = projectNostrIdentityRoster(account, session.rosterOps);
  if (!own.active_facets[session.appKeyPubkey]?.capabilities?.can_write_roots)
    throw new Error('This device cannot save changes to My Drive');
  return { share, key, session, own, facets: projectSharedFolderKeys(share.record.folder).active_facets };
}

const unknownOwner = 'This shared item must stay in its folder until its file owner can recover it.';

/** Reserve all requests before committing the batch. If interrupted, a request can act only on its exact saved entry. */
export async function removeSharedFiles(
  account: string,
  scope: string,
  parent: string[],
  names: string[],
): Promise<void> {
  const tree = getTree();
  const { canEncodeTrashPath } = await import('./privateTrashTree');
  await changeDriveRoot(
    scope,
    'main',
    async (root) => {
      const { share, key } = active(account, scope);
      if (!share.canWrite) throw new Error('You need edit access to this folder');
      const versions = profileDriveProjection.heldVersions(scope, 'main', new Set(share.writers));
      const seen = Object.fromEntries(
        Object.entries(versions)
          .filter(([, head]) => head.seq > 0)
          .map(([writer, head]) => [writer, head.seq]),
      );
      const requests: { path: string[]; entry: TreeEntry; request: Event }[] = [];
      for (const name of new Set(names)) {
        const path = [...parent, name];
        if (!canEncodeTrashPath([name])) throw new Error('This file name cannot be returned on every device');
        const entry = await resolveEntry(tree, root, path);
        if (!entry) throw new Error('The selection changed before it could be removed');
        const claim = readFileOwner(entry, share.record.folder);
        if (!claim) throw new Error(unknownOwner);
        const pending = currentReturn(share.record.folder, path, entry);
        if (pending && pending.event.pubkey !== getPublicKey(key)) continue;
        requests.push({ path, entry, request: pending?.event ?? requestFileReturn(claim, entry.cid, path, key, seen) });
      }
      const latest = active(account, scope);
      if (!latest.share.canWrite) throw new Error('Shared folder access has changed');
      let next = root;
      for (const { entry, path, request } of requests) {
        if (entry.meta?.[REQUEST_META] === JSON.stringify(request)) continue;
        next = await tree.setEntry(next, parent, path.at(-1)!, entry.cid, entry.size, entry.type, {
          ...entry.meta,
          [REQUEST_META]: JSON.stringify(request),
        });
      }
      await jobs.bulkPut(
        requests.map(({ request }) => ({
          account,
          id: request.id,
          event: request,
          outgoing: true,
          state: 'pending' as const,
        })),
      );
      if (active(account, scope).session.appKeyPubkey !== latest.session.appKeyPubkey)
        throw new Error('The active device changed');
      return next;
    },
    { verifyRestore: true },
  );
  wake();
}

async function pinFile(entry: TreeEntry) {
  const tree = getTree();
  let total = 0;
  for await (const data of tree.readFileStream(entry.cid)) total += data.byteLength;
  if (total !== entry.size) throw new Error('The returned file could not be read in full');
  const store = tree.getStore();
  // The worker takes ownership of the upload buffer. The traversal still needs
  // its original encrypted bytes after yield to discover child blocks.
  for await (const block of tree.walkBlocks(entry.cid)) await store.put(block.hash, block.data.slice());
}

/** Save in the personal root, reusing the encrypted bytes. Retries identify the original return even when names collide. */
async function storeForOwner(
  account: string,
  entry: TreeEntry,
  request: Signed<ReturnRequest>,
  stillAuthorized: () => void,
  ownRemoval: boolean,
) {
  const { canEncodeTrashPath } = await import('./privateTrashTree');
  if (!canEncodeTrashPath([entry.name])) throw new Error('This file name cannot be returned on every device');
  const meta = { ...entry.meta };
  delete meta[OWNER_META];
  delete meta[REQUEST_META];
  delete meta[RETURNED_META];
  await pinFile(entry);
  stillAuthorized();
  if (ownRemoval) {
    const { confirmOwnerTrashItem } = await import('./privateTrashSync');
    await confirmOwnerTrashItem(account, {
      id: request.value.nonce,
      account,
      scope: account,
      treeName: 'main',
      path: [],
      entry: { ...entry, meta },
      deletedAt: request.event.created_at * 1000,
      ready: false,
      sync: 'prepared',
    });
    return;
  }
  const tree = getTree();
  await waitForTreeRoot(account, 'main', 12000);
  await changeDriveRoot(
    account,
    'main',
    async (root) => {
      stillAuthorized();
      const entries = await tree.listDirectory(root);
      const existing = entries.find((row) => row.meta?.[RETURNED_META] === request.event.id);
      if (existing) {
        if (existing.type !== LinkType.Blob || fileRevision(existing.cid) !== request.value.revision)
          throw new Error('The returned file has since changed');
        return null;
      }
      const name = freeName(entry.name, new Set(entries.map((row) => row.name)));
      const { isUnsharedTrashPath } = await import('./privateTrashSync');
      if (!isUnsharedTrashPath(account, [name])) throw new Error('The return destination is shared');
      return mutateProfileDriveRoot(tree, root, {
        type: 'set-entry',
        path: name,
        entry: { ...entry, meta: { ...meta, [RETURNED_META]: request.event.id } },
      });
    },
    { verifyRestore: true },
  );
  stillAuthorized();
  const root = getTreeRootSync(account, 'main');
  if (
    !root ||
    !(await tree.listDirectory(root)).some(
      (row) =>
        row.meta?.[RETURNED_META] === request.event.id &&
        row.type === LinkType.Blob &&
        fileRevision(row.cid) === request.value.revision,
    )
  )
    throw new Error('Waiting for the returned file in My Drive');
  if (!(await publishNostrIdentityDriveRootIfAvailable('main', root, { rootScopeId: account, confirmStored: true })))
    throw new Error('Waiting for My Drive to sync');
}

async function processJob(job: Job & { event: Event }, sessionKey: string) {
  const key = getSecretKey();
  if (!key || getPublicKey(key) !== sessionKey) return false;
  const { parseRequest } = await import('./fileReturnProtocol');
  const note = job.outgoing ? null : openReturnNote(job.event, key);
  const request = job.outgoing ? parseRequest(JSON.stringify(job.event)) : note?.request;
  if (!request) return true;
  const { share: shareId, owner, path } = request.value;
  const context = () => {
    const now = active(job.account, shareId);
    if (now.session.appKeyPubkey !== sessionKey) throw new Error('The active device changed');
    return now;
  };
  const { share, facets } = context();
  if (!facets[request.event.pubkey]?.capabilities?.can_write_roots) return true;
  if (job.outgoing && request.event.pubkey !== sessionKey) return false;
  if (note?.phase === 'request' && owner !== job.account) return true;
  if (note?.phase === 'stored' && (!share.canWrite || facets[job.event.pubkey]?.profile_id !== owner)) return true;
  const tree = getTree();
  const getPending = async (root: CID) => {
    const entry = await resolveEntry(tree, root, path);
    return entry && currentReturn(context().share.record.folder, path, entry, request.event.id) ? entry : null;
  };
  const root = getTreeRootSync(shareId, 'main') ?? (await waitForTreeRoot(shareId, 'main', 5000));
  if (!root) return false;
  const entry = await getPending(root);
  if (!entry) {
    const finished = await tree.resolvePath(root, ['.hashtree', 'file-returns-v1', request.event.id + '.json']);
    return !!finished;
  }
  if (job.outgoing) {
    const recipients = Object.keys(facets).filter((pub) => facets[pub].profile_id === owner);
    if (!recipients.length) return false;
    for (const message of returnNotes(request, 'request', key, recipients)) await publishEvent(message);
    return true;
  }
  const claim = readFileOwner(entry, share.record.folder)!;
  if (note?.phase === 'request') {
    const verifyOwner = () => {
      const now = context();
      if (
        now.facets[request.event.pubkey]?.capabilities?.can_write_roots !== true ||
        !now.own.active_facets[claim.event.pubkey]?.purposes?.includes('app_key') ||
        !now.facets[claim.event.pubkey]
      )
        throw new Error('File ownership or edit access changed');
    };
    verifyOwner();
    const source = profileDriveProjection.contributionRoot(shareId, 'main', request.event.pubkey, request.value.seen);
    if (!source || !(await getPending(source))) throw new Error('Waiting for the editor’s signed file version');
    await storeForOwner(job.account, entry, request, verifyOwner, facets[request.event.pubkey].profile_id === owner);
    const current = getTreeRootSync(shareId, 'main');
    if (!current || !(await getPending(current))) return false;
    verifyOwner();
    for (const message of returnNotes(request, 'stored', key, context().share.writers)) await publishEvent(message);
    return true;
  }
  if (!note?.receipt) return true;
  const marker = { v: 1 as const, claim: claim.event, request: request.event, receipt: note.receipt };
  await changeDriveRoot(
    shareId,
    'main',
    async (current) => {
      const now = context();
      if (
        !now.share.canWrite ||
        now.facets[note.receipt!.pubkey]?.profile_id !== owner ||
        !verifyMarker(marker, now.share.record.folder)
      )
        throw new Error('Owner confirmation is unavailable');
      if (!(await getPending(current))) return null;
      return finishFileReturn(tree, current, path, marker);
    },
    { verifyRestore: true },
  );
  return true;
}

/** Durable incoming and outgoing operations are replayed on reconnect, even if the page closed partway through. */
export function watchFileReturns(account: string): () => void {
  const key = getSecretKey();
  if (!key) return () => {};
  const pubkey = getPublicKey(key);
  let stopped = false;
  let running = false;
  let repeat = false;
  const failures = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout>;
  const roots = new Map<string, () => void>();
  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const pending = await jobs.where('[account+state]').equals([account, 'pending']).toArray();
      let retry = false;
      const watching = new Set<string>();
      for (const job of pending) {
        if (stopped) break;
        if (!job.event) continue;
        try {
          const request = job.outgoing ? JSON.parse(job.event.content) : openReturnNote(job.event, key)?.request.value;
          if (!request?.share || !activeShareScope(request.share)) continue;
          watching.add(request.share);
          if (!roots.has(request.share)) roots.set(request.share, subscribeToTreeRoot(request.share, 'main', schedule));
          if (await processJob({ ...job, event: job.event }, pubkey)) {
            failures.delete(job.id);
            await jobs.put({ account, id: job.id, state: 'done', outgoing: job.outgoing });
          } else {
            retry = true;
          }
        } catch (error) {
          retry = true;
          const reason = error instanceof Error ? error.message : 'Waiting for Drive';
          if (import.meta.env.DEV && failures.get(job.id) !== reason) console.debug('[file return]', reason);
          failures.set(job.id, reason);
        }
      }
      for (const [share, stop] of roots)
        if (!watching.has(share)) {
          stop();
          roots.delete(share);
        }
      if (retry && !stopped) timer = setTimeout(() => void run(), 10000);
    } finally {
      running = false;
      if (repeat) {
        repeat = false;
        schedule();
      }
    }
  };
  function schedule() {
    if (stopped) return;
    if (running) {
      repeat = true;
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => void run(), 100);
  }
  const receive = async (event: Event) => {
    if (stopped) return;
    const note = openReturnNote(event, key);
    if (!note) return;
    const share = activeShareScope(note.request.value.share);
    const facets = share && projectSharedFolderKeys(share.record.folder).active_facets;
    if (
      !facets?.[note.request.event.pubkey]?.capabilities?.can_write_roots ||
      (note.phase === 'stored'
        ? facets[event.pubkey]?.profile_id !== note.request.value.owner
        : note.request.value.owner !== account)
    )
      return;
    const id = note.phase + ':' + note.request.event.id;
    await db.transaction('rw', jobs, async () => {
      if (!(await jobs.get([account, id]))) await jobs.add({ account, id, event, outgoing: false, state: 'pending' });
    });
    schedule();
  };
  let roster = '';
  let subscription: ReturnType<typeof nostr.subscribe> | undefined;
  const stopMembership = acceptedShares.subscribe((records) => {
    const membership = records
      .filter((record) => record.local_profile_id === account)
      .map((record) => {
        const facets = projectSharedFolderKeys(record.folder).active_facets;
        return [
          record.share_id,
          Object.entries(facets)
            .map(([pub, facet]) => [pub, facet.profile_id, facet.capabilities?.can_write_roots])
            .sort(),
        ];
      });
    const next = JSON.stringify(membership);
    if (next === roster) return;
    roster = next;
    subscription?.stop();
    if (membership.length) {
      subscription = nostr.subscribe(
        { kinds: [KIND_DRIVE_ROOT], '#l': [RETURN_LABEL], '#p': [pubkey] },
        { closeAfterHistory: false },
      );
      subscription.on('event', receive);
    }
    schedule();
  });
  listeners.add(schedule);
  window.addEventListener('online', schedule);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    listeners.delete(schedule);
    stopMembership();
    subscription?.stop();
    for (const stop of roots.values()) stop();
    window.removeEventListener('online', schedule);
  };
}
