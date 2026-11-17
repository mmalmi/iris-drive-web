/**
 * Publishing what linkShares.ts records: turning a link on or off, keeping
 * the published version current while Drive is open, and telling the
 * account's other devices and the people a folder is shared with. Nothing
 * here waits for a relay: publishing is signed here and handed to the worker,
 * which sends it when it can.
 */
import { get } from 'svelte/store';
import { fromHex, LinkType, toHex, type CID } from '@hashtree/core';
import type { Event } from 'nostr-tools';
import { nostr, nostrStore } from '../nostr';
import { getCurrentNostrIdentitySession, getSecretKey } from '../nostr/auth';
import { getRefResolver } from '../refResolver';
import { publishEvent } from '../lib/nostrPublish';
import { isDocumentFolderName } from '../lib/documentNames';
import { getTree } from '../store';
import { getTreeRootSync, subscribeToTreeRoot } from '../stores/treeRoot';
import { getWorkerAdapter } from '../workerAdapter';
import { projectNostrIdentityRoster, sharedFolderKeyRecipientPubkeys } from './protocol';
import { acceptedShares } from './shareLibrary';
import {
  buildLinkShareNotes,
  canSetLinkAccess,
  buildShareLinkNotes,
  LINK_SHARE_LABEL,
  linkShareOf,
  linkShares,
  linkSource,
  linkTreeName,
  mergeLinkShares,
  readLinkShareNote,
  readShareLinkNote,
  SHARE_LINK_LABEL,
  type LinkAccess,
  type LinkShare,
  type LinkSubject,
} from './linkShares';
import { KIND_DRIVE_ROOT } from './protocolTypes';

const DRIVE_ID = 'main';
/** Edits come in bursts; each link is published at most this often. */
const REPUBLISH_DELAY_MS = 1500;
const RETIRED_KEY = 'iris-drive.link-shares.retired';
/** Notes from a shared folder this device has not taken in yet, kept until it has. */
const MAX_WAITING_NOTES = 50;

function account() {
  const session = getCurrentNostrIdentitySession();
  const secretKey = getSecretKey();
  const { npub, pubkey } = nostrStore.getState();
  if (!session || session.status !== 'active' || !secretKey || !npub || pubkey !== session.appKeyPubkey) return null;
  const roster = projectNostrIdentityRoster(session.profileId, session.rosterOps ?? []);
  const devices = new Set(Object.values(roster.active_facets)
    .filter((facet) => facet.purposes?.includes('app_key'))
    .map((facet) => facet.pubkey));
  return { profile: session.profileId, npub, pubkey, secretKey, devices };
}
type Account = NonNullable<ReturnType<typeof account>>;

/**
 * What the link opens: a folder itself, and a document or a single file in a
 * folder holding just it, so the link opens it as itself.
 */
async function contentAt(root: CID, path: string[]): Promise<{ cid: CID; file: boolean } | null> {
  const name = path.at(-1);
  if (!name) return { cid: root, file: false };
  const tree = getTree();
  const entry = await tree.resolvePath(root, path);
  if (!entry) return null;
  if (entry.type === LinkType.Dir) {
    if (!isDocumentFolderName(name)) return { cid: entry.cid, file: false };
    return { cid: (await tree.putDirectory([{ name, cid: entry.cid, size: 0, type: LinkType.Dir }])).cid, file: false };
  }
  const parent = path.length > 1 ? await tree.resolvePath(root, path.slice(0, -1)) : { cid: root };
  const listed = parent ? (await tree.listDirectory(parent.cid)).find((item) => item.name === name) : undefined;
  const { cid } = await tree.putDirectory([{
    name,
    cid: entry.cid,
    size: listed?.size ?? 0,
    type: entry.type,
    ...(listed?.meta ? { meta: listed.meta } : {}),
  }]);
  return { cid, file: true };
}

/** The newest version of a link's item: from the shared folder it is in, or from My Drive. */
async function publishedContent(record: Pick<LinkShare, 'profile' | 'path' | 'share'>): Promise<{ cid: CID; file: boolean } | null> {
  const source = linkSource(record, get(acceptedShares));
  const root = getTreeRootSync(source.scope, DRIVE_ID);
  return root ? contentAt(root, source.path) : null;
}

const published = new Map<string, string>();

async function publish(record: LinkShare, cid: CID): Promise<string> {
  const result = await getRefResolver().publish?.(`${record.npub}/${record.tree}`, cid, {
    visibility: record.access === 'public' ? 'public' : 'link-visible',
    linkKey: record.access === 'link' && record.key ? fromHex(record.key) : undefined,
  });
  if (!result?.success) throw new Error('Could not publish the link');
  published.set(record.tree, `${record.access}:${toHex(cid.hash)}`);
  void getWorkerAdapter()?.pushToBlossom(cid.hash, cid.key, record.tree).catch(() => undefined);
  return record.access === 'link' ? (record.key || (result.linkKey ? toHex(result.linkKey) : '')) : '';
}

function retired(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(RETIRED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}

/**
 * Stops the link opening anything: the tree's newest version becomes an
 * empty folder under a key nobody has, so a new open is told the link no
 * longer works. (A removed tree would leave visitors waiting: readers pass
 * over removals.)
 */
async function unpublish(record: LinkShare): Promise<void> {
  const { cid } = await getTree().putDirectory([]);
  await getRefResolver().publish?.(`${record.npub}/${record.tree}`, cid, { visibility: 'link-visible' });
  published.delete(record.tree);
  const done = retired();
  done.add(`${record.tree}@${record.at}`);
  try {
    localStorage.setItem(RETIRED_KEY, JSON.stringify([...done]));
  } catch {
    // It is unpublished again next time.
  }
}

function send(notes: Event[]): void {
  for (const note of notes) void publishEvent(note).catch((error) => console.warn('[links] Could not send a note:', error));
}

/**
 * The shared folder a link's item is in and the devices of the people in it,
 * other than this account's; null when it is not in one.
 */
function membersOf(record: LinkShare, me: Account): { share: string; inner: string[]; devices: string[] } | null {
  const shares = get(acceptedShares);
  const source = linkSource(record, shares);
  const share = shares.find((item) => item.share_id === source.scope && item.local_profile_id === me.profile);
  if (!share) return null;
  const devices = sharedFolderKeyRecipientPubkeys(share.folder).filter((pubkey) => !me.devices.has(pubkey));
  return { share: share.share_id, inner: source.path, devices };
}

/** Tells the people a link's item is shared with whether it opens by link; only the device that publishes it does. */
function tellMembers(record: LinkShare, me: Account): void {
  const members = record.npub === me.npub ? membersOf(record, me) : null;
  if (!members || members.devices.length === 0) return;
  send(buildShareLinkNotes(me.secretKey, record, members, members.devices, Math.floor(Date.now() / 1000)));
}

function tell(record: LinkShare): void {
  const me = account();
  if (!me) return;
  const others = [...me.devices].filter((pubkey) => pubkey !== me.pubkey);
  if (others.length > 0) send(buildLinkShareNotes(me.secretKey, record, others, Math.floor(Date.now() / 1000)));
  tellMembers(record, me);
}

/**
 * Sets who can open an item by its link (see linkSubjectAt). Turning it on
 * publishes the item now; the same link opens it from then on. `name` names
 * the link of a whole shared folder.
 */
export async function setLinkAccess(subject: LinkSubject, access: LinkAccess | 'off', name?: string): Promise<LinkShare | null> {
  const me = account();
  if (!me) throw new Error('Sign in to share by link');
  const records = get(linkShares);
  // Another account's admin keeps their own link to a shared folder; this account changes its own.
  const current = linkShareOf(subject.path, me.profile, records.filter((record) => record.profile === me.profile), subject.share);
  if (access === 'off') {
    if (!current || current.access === 'off') return current;
    const record: LinkShare = { ...current, access: 'off', at: Date.now() };
    linkShares.update((items) => mergeLinkShares(items, [record]));
    if (record.npub === me.npub) await unpublish(record);
    tell(record);
    return record;
  }
  // A link this device made before comes back the same; another device's link stays that device's to keep current.
  const mine = current?.npub === me.npub ? current : null;
  const item = { profile: me.profile, path: subject.path.join('/'), ...(subject.share ? { share: subject.share } : {}) };
  const content = await publishedContent(item);
  if (!content) {
    const inShare = linkSource(item, get(acceptedShares)).scope !== me.profile;
    throw new Error(inShare ? 'This is not in the shared folder any more' : 'This is not in My Drive any more');
  }
  const draft: LinkShare = {
    ...item,
    ...(content.file ? { file: true } : {}),
    npub: me.npub,
    tree: mine?.tree ?? linkTreeName(subject, me.npub, records, name),
    key: access === 'link' ? (mine?.key ?? '') : '',
    access,
    at: Date.now(),
  };
  const record: LinkShare = { ...draft, key: await publish(draft, content.cid) };
  linkShares.update((items) => mergeLinkShares(items, [record]));
  tell(record);
  return record;
}

/** Enough to undo this deletion's permission change. The key stays in the account's link store. */
export type DeletedLinkAccess = Pick<LinkShare, 'profile' | 'npub' | 'tree' | 'path' | 'share' | 'access'> & { disabledAt: number };

/**
 * Keeps links with their items: one renamed or moved in My Drive on this
 * device takes its link along, and one deleted has its link turned off.
 */
export function followLinkShares(from: string[], to: string[] | null, share?: string): DeletedLinkAccess[] {
  const me = account();
  if (!me) return [];
  const at = from.join('/');
  const now = Date.now();
  const before = get(linkShares)
    .filter((record) => record.profile === me.profile && record.share === share && record.access !== 'off'
      && (record.path === at || record.path.startsWith(`${at}/`)));
  if (before.length === 0) return [];
  const moved = before.map((record): LinkShare => (to
    ? { ...record, path: to.join('/') + record.path.slice(at.length), at: now }
    : { ...record, access: 'off', at: Math.max(now, record.at + 1) }));
  linkShares.update((items) => mergeLinkShares(items, moved));
  for (const record of moved) {
    if (record.access === 'off' && record.npub === me.npub) void unpublish(record).catch(() => undefined);
    tell(record);
  }
  return to ? [] : before.map(({ profile, npub, tree, path, share, access }, i) =>
    ({ profile, npub, tree, path, share, access, disabledAt: moved[i].at }));
}

/** Undo may re-enable only the exact access decision this deletion disabled. */
export function putBackLinkShares(records: DeletedLinkAccess[]): void {
  if (!records.length) return;
  const me = account();
  if (!me) return;
  const shares = get(acceptedShares);
  const current = get(linkShares);
  const back: LinkShare[] = [];
  for (const item of records) {
    if (item.profile !== me.profile || (item.access !== 'link' && item.access !== 'public')) continue;
    const disabled = current.find(record => record.profile === item.profile && record.npub === item.npub && record.tree === item.tree);
    if (disabled?.access !== 'off' || disabled.at !== item.disabledAt || disabled.path !== item.path || disabled.share !== item.share) continue;
    const latest = linkShareOf(item.path.split('/').filter(Boolean), me.profile, current, item.share);
    if (latest !== disabled || !canSetLinkAccess(linkSource(disabled, shares), me.profile, me.pubkey, shares)) continue;
    back.push({ ...disabled, access: item.access, at: Math.max(Date.now(), disabled.at + 1) });
  }
  if (!back.length) return;
  linkShares.update((items) => mergeLinkShares(items, back));
  for (const record of back) tell(record);
}

/**
 * While Drive is open: publish each new version of the items this device
 * shares by link, from My Drive or from the shared folder they are in,
 * whoever changed them; unpublish the ones turned off on another device; and
 * take in what the account's other devices and shared folders' admins say.
 */
export function watchLinkShares(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const roots = new Map<string, () => void>();
  let stopNotes: (() => void) | null = null;
  let notesFor = '';
  let toldOthers = '';
  const toldMembers = new Map<string, string>();
  let waiting: Event[] = [];

  const republish = async () => {
    timer = null;
    const me = account();
    if (!me) return;
    const done = retired();
    for (const record of get(linkShares)) {
      if (record.profile !== me.profile || record.npub !== me.npub) continue;
      if (record.access === 'off') {
        if (!done.has(`${record.tree}@${record.at}`)) await unpublish(record).catch(() => undefined);
        continue;
      }
      try {
        const content = await publishedContent(record);
        if (!content || published.get(record.tree) === `${record.access}:${toHex(content.cid.hash)}`) continue;
        await publish(record, content.cid);
      } catch (error) {
        console.warn('[links] Could not publish a new version:', error);
      }
    }
  };
  const soon = () => {
    if (!timer) timer = setTimeout(() => void republish(), REPUBLISH_DELAY_MS);
  };

  /** A note this device can read: from its own account, or from an admin of a shared folder it is in. */
  const takeIn = (event: Event): boolean => {
    const me = account();
    if (!me) return true;
    const own = readLinkShareNote(event, me.secretKey, { profile: me.profile, devices: me.devices });
    const record = own ?? readShareLinkNote(event, me.secretKey, me.profile, get(acceptedShares));
    if (record) {
      // Only news is stored: storing wakes refresh, which reads waiting notes again.
      const items = get(linkShares);
      const merged = mergeLinkShares(items, [record]);
      if (merged !== items) linkShares.set(merged);
    }
    return !!record || event.tags.some(([name, value]) => name === 'l' && value === LINK_SHARE_LABEL);
  };

  const refresh = (recordsChanged: boolean) => {
    const me = account();
    const records = get(linkShares);
    const shares = get(acceptedShares);
    const mine = me ? records.filter((record) => record.profile === me.profile && record.npub === me.npub) : [];

    // Watch where the items this device publishes are: My Drive, and each shared folder one of them is in now.
    const scopes = new Set<string>();
    if (me && mine.length > 0) scopes.add(me.profile);
    for (const record of mine) if (record.access !== 'off') scopes.add(linkSource(record, shares).scope);
    for (const [scope, stop] of roots) {
      if (!scopes.has(scope)) {
        stop();
        roots.delete(scope);
      }
    }
    for (const scope of scopes) if (!roots.has(scope)) roots.set(scope, subscribeToTreeRoot(scope, DRIVE_ID, soon));
    if (mine.length > 0 && recordsChanged) soon();

    const notesKey = me ? `${me.profile}:${me.pubkey}` : '';
    if (notesKey !== notesFor) {
      stopNotes?.();
      stopNotes = null;
      notesFor = notesKey;
      waiting = [];
      if (me) {
        const sub = nostr.subscribe(
          { kinds: [KIND_DRIVE_ROOT], '#l': [LINK_SHARE_LABEL, SHARE_LINK_LABEL], '#p': [me.pubkey] },
          { closeAfterHistory: false },
        );
        sub.on('event', (event: Event) => {
          // One about a shared folder this device has not taken in yet is read again once it has.
          if (!takeIn(event)) waiting = [...waiting, event].slice(-MAX_WAITING_NOTES);
        });
        stopNotes = () => sub.stop();
      }
    }
    if (waiting.length > 0) {
      const pending = waiting;
      waiting = [];
      waiting = [...waiting, ...pending.filter((event) => !takeIn(event))];
    }

    if (!me) return;
    // A device added since a link was made learns of it the next time this one opens Drive.
    const devicesKey = `${notesKey}:${[...me.devices].sort().join(',')}`;
    if (devicesKey !== toldOthers) {
      toldOthers = devicesKey;
      for (const record of records) if (record.profile === me.profile && record.npub === me.npub) tell(record);
      for (const record of mine) toldMembers.set(record.tree, `${record.at}:${membersOf(record, me)?.devices.join(',') ?? ''}`);
    }
    // So do people who join a shared folder, and those of a folder shared after its link was made.
    for (const record of mine) {
      const told = `${record.at}:${membersOf(record, me)?.devices.join(',') ?? ''}`;
      if (toldMembers.get(record.tree) === told) continue;
      toldMembers.set(record.tree, told);
      tellMembers(record, me);
    }
  };

  const stopRecords = linkShares.subscribe(() => refresh(true));
  const stopShares = acceptedShares.subscribe(() => refresh(true));
  const stopSession = nostrStore.subscribe(() => refresh(false));
  return () => {
    stopRecords();
    stopShares();
    stopSession();
    for (const stop of roots.values()) stop();
    stopNotes?.();
    if (timer) clearTimeout(timer);
  };
}
