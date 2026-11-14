/**
 * Publishing what linkShares.ts records: turning a link on or off, keeping
 * the published version current while Drive is open, and telling the
 * account's other devices. Nothing here waits for a relay: publishing is
 * signed here and handed to the worker, which sends it when it can.
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
import { projectNostrIdentityRoster } from './protocol';
import {
  buildLinkShareNotes,
  LINK_SHARE_LABEL,
  linkShareOf,
  linkShares,
  linkTreeName,
  mergeLinkShares,
  readLinkShareNote,
  type LinkAccess,
  type LinkShare,
} from './linkShares';
import { KIND_DRIVE_ROOT } from './protocolTypes';

const DRIVE_ID = 'main';
/** Edits come in bursts; each link is published at most this often. */
const REPUBLISH_DELAY_MS = 1500;
const RETIRED_KEY = 'iris-drive.link-shares.retired';

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

/** What the link opens: the item itself, or for a document a folder holding just it, so it opens as a document. */
async function publishedCid(profile: string, path: string): Promise<CID | null> {
  const root = getTreeRootSync(profile, DRIVE_ID);
  if (!root) return null;
  const tree = getTree();
  const entry = await tree.resolvePath(root, path);
  if (!entry || entry.type !== LinkType.Dir) return null;
  const name = path.split('/').at(-1)!;
  if (!isDocumentFolderName(name)) return entry.cid;
  return (await tree.putDirectory([{ name, cid: entry.cid, size: 0, type: LinkType.Dir }])).cid;
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

function tell(record: LinkShare): void {
  const me = account();
  if (!me) return;
  const others = [...me.devices].filter((pubkey) => pubkey !== me.pubkey);
  if (others.length === 0) return;
  for (const note of buildLinkShareNotes(me.secretKey, record, others, Math.floor(Date.now() / 1000))) {
    void publishEvent(note).catch((error) => console.warn('[links] Could not tell another device:', error));
  }
}

/**
 * Sets who can open the item at `path` of My Drive by its link. Turning it on
 * publishes the item now; the same link opens it from then on.
 */
export async function setLinkAccess(path: string[], access: LinkAccess | 'off'): Promise<LinkShare | null> {
  const me = account();
  if (!me) throw new Error('Sign in to share by link');
  const records = get(linkShares);
  const current = linkShareOf(path, me.profile, records);
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
  const cid = await publishedCid(me.profile, path.join('/'));
  if (!cid) throw new Error('This is not in My Drive any more');
  const draft: LinkShare = {
    profile: me.profile,
    path: path.join('/'),
    npub: me.npub,
    tree: mine?.tree ?? linkTreeName(path, me.npub, records),
    key: access === 'link' ? (mine?.key ?? '') : '',
    access,
    at: Date.now(),
  };
  const record: LinkShare = { ...draft, key: await publish(draft, cid) };
  linkShares.update((items) => mergeLinkShares(items, [record]));
  tell(record);
  return record;
}

/**
 * While Drive is open: publish each new version of the items this device
 * shares by link, unpublish the ones turned off on another device, and take
 * in what the account's other devices say.
 */
export function watchLinkShares(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopRoot: (() => void) | null = null;
  let watchedRoot = '';
  let stopNotes: (() => void) | null = null;
  let notesFor = '';
  let toldOthers = '';

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
        const cid = await publishedCid(me.profile, record.path);
        if (!cid || published.get(record.tree) === `${record.access}:${toHex(cid.hash)}`) continue;
        await publish(record, cid);
      } catch (error) {
        console.warn('[links] Could not publish a new version:', error);
      }
    }
  };
  const soon = () => {
    if (!timer) timer = setTimeout(() => void republish(), REPUBLISH_DELAY_MS);
  };

  const refresh = (recordsChanged: boolean) => {
    const me = account();
    const records = get(linkShares);
    // Keep the Drive root watched while this device publishes a link.
    const rootFor = me && records.some((record) => record.profile === me.profile && record.npub === me.npub) ? me.profile : '';
    if (rootFor !== watchedRoot) {
      stopRoot?.();
      stopRoot = rootFor ? subscribeToTreeRoot(rootFor, DRIVE_ID, soon) : null;
      watchedRoot = rootFor;
    }
    if (rootFor && recordsChanged) soon();

    const notesKey = me ? `${me.profile}:${me.pubkey}` : '';
    if (notesKey !== notesFor) {
      stopNotes?.();
      stopNotes = null;
      notesFor = notesKey;
      if (me) {
        const sub = nostr.subscribe({ kinds: [KIND_DRIVE_ROOT], '#l': [LINK_SHARE_LABEL], '#p': [me.pubkey] }, { closeAfterHistory: false });
        sub.on('event', (event: Event) => {
          const now = account();
          const record = now && readLinkShareNote(event, now.secretKey, { profile: now.profile, devices: now.devices });
          if (record) linkShares.update((items) => mergeLinkShares(items, [record]));
        });
        stopNotes = () => sub.stop();
      }
    }
    // A device added since a link was made learns of it the next time this one opens Drive.
    const devicesKey = me ? `${notesKey}:${[...me.devices].sort().join(',')}` : '';
    if (me && devicesKey !== toldOthers) {
      toldOthers = devicesKey;
      for (const record of records) if (record.profile === me.profile && record.npub === me.npub) tell(record);
    }
  };

  const stopRecords = linkShares.subscribe(() => refresh(true));
  const stopSession = nostrStore.subscribe(() => refresh(false));
  return () => {
    stopRecords();
    stopSession();
    stopRoot?.();
    stopNotes?.();
    if (timer) clearTimeout(timer);
  };
}
