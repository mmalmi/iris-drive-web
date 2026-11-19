import { encryptionMode, LinkType, toHex, type CID, type HashTree, type TreeEntry } from '@hashtree/core';
import { sha256 } from '@noble/hashes/sha2.js';
import { finalizeEvent, verifyEvent, type Event } from 'nostr-tools';
import { KIND_DRIVE_ROOT, type SharedFolder } from './protocolTypes';
import { projectSharedFolderKeys } from './protocolShareSnapshot';
import { buildDeviceNotes, deviceNoteDTag, readDeviceNote } from './deviceNotes';

import { OWNER_META, REQUEST_META, RETURNED_META } from './fileOwnershipMetadata';
export { OWNER_META, REQUEST_META, RETURNED_META } from './fileOwnershipMetadata';
export const RETURN_LABEL = 'iris-drive-file-return-v1';
const STORED_LABEL = 'iris-drive-file-return-stored-v1';
const OWNER_LABEL = 'iris-drive-file-owner-v1';
const REQUEST_LABEL = 'iris-drive-file-return-request-v1';
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
export type Ownership = { v: 1; share: string; item: string; owner: string; origin: string };
export type ReturnRequest = Omit<Ownership, 'origin'> & {
  claim: string;
  revision: string;
  path: string[];
  nonce: string;
  seen: Record<string, number>;
};
export type ReturnPhase = 'request' | 'stored';
export type Signed<T> = { event: Event; value: T };

export function fileRevision(cid: CID): string {
  if (cid.hash.length !== 32 || !cid.key) throw new Error('An encrypted file is required');
  encryptionMode(cid.key);
  return toHex(
    sha256(new TextEncoder().encode(['iris-drive-file-revision-v1', toHex(cid.hash), toHex(cid.key)].join('\n'))),
  );
}

function signed(label: string, content: object, key: Uint8Array): Event {
  return finalizeEvent(
    {
      kind: KIND_DRIVE_ROOT,
      tags: [['l', label]],
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify(content),
    },
    key,
  );
}

function keysMatch(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    Object.keys(value).length === fields.length &&
    fields.every((k) => Object.hasOwn(value, k))
  );
}

export function parseSigned(raw: unknown, label: string): Event | null {
  if (typeof raw !== 'string' || raw.length > 24576) return null;
  try {
    const event = JSON.parse(raw) as Event;
    if (
      event.kind === KIND_DRIVE_ROOT &&
      JSON.stringify(event.tags) === JSON.stringify([['l', label]]) &&
      verifyEvent(event)
    )
      return event;
  } catch {
    /* Unknown or unsigned metadata leaves the file in place. */
  }
  return null;
}

function id(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}
function hash(value: unknown): value is string {
  return typeof value === 'string' && HASH.test(value);
}
function identities(value: Record<string, unknown>): boolean {
  return value.v === 1 && id(value.share) && id(value.item) && UUID_V4.test(value.item) && id(value.owner);
}

export function returnPath(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 128 &&
    value.every(
      (part) =>
        typeof part === 'string' &&
        !!part &&
        part !== '.' &&
        part !== '..' &&
        part !== '.hashtree' &&
        !/[\\/\u0000-\u001f]/.test(part) &&
        part.length <= 255,
    )
  );
}

export function claimNewFile(share: string, owner: string, cid: CID, key: Uint8Array): string {
  return JSON.stringify(
    signed(OWNER_LABEL, { v: 1, share, item: crypto.randomUUID(), owner, origin: fileRevision(cid) }, key),
  );
}

/** A folder pasted into a share contains new files, even when its encrypted bytes are already stored. */
export async function claimCopiedDirectory(
  tree: HashTree,
  root: CID,
  share: string,
  owner: string,
  key: Uint8Array,
): Promise<CID> {
  const entries = await tree.listDirectory(root);
  if (!entries.length) return root;
  const children: TreeEntry[] = [];
  for (const entry of entries) {
    if (entry.name === '.hashtree') continue;
    const meta = { ...entry.meta };
    delete meta[REQUEST_META];
    delete meta[RETURNED_META];
    delete meta[OWNER_META];
    if (entry.type === LinkType.Dir) {
      const cid = await claimCopiedDirectory(tree, entry.cid, share, owner, key);
      children.push({ ...entry, cid, meta });
    } else {
      if (entry.type === LinkType.Blob && entry.cid.key) meta[OWNER_META] = claimNewFile(share, owner, entry.cid, key);
      children.push({ ...entry, meta });
    }
  }
  return (await tree.putDirectory(children)).cid;
}

export function parseOwnership(raw: unknown): Signed<Ownership> | null {
  const event = parseSigned(raw, OWNER_LABEL);
  if (!event) return null;
  try {
    const value = JSON.parse(event.content);
    if (!keysMatch(value, ['v', 'share', 'item', 'owner', 'origin']) || !identities(value) || !hash(value.origin))
      return null;
    return { event, value: value as Ownership };
  } catch {
    return null;
  }
}

export function readFileOwner(entry: TreeEntry, folder: SharedFolder): Signed<Ownership> | null {
  if (entry.type !== LinkType.Blob || !entry.cid.key) return null;
  const claim = parseOwnership(entry.meta?.[OWNER_META]);
  if (!claim || claim.value.share !== folder.share_id) return null;
  const signer = projectSharedFolderKeys(folder).active_facets[claim.event.pubkey];
  return signer?.purposes?.includes('app_key') && signer.profile_id === claim.value.owner ? claim : null;
}

export function requestFileReturn(
  claim: Signed<Ownership>,
  cid: CID,
  path: string[],
  key: Uint8Array,
  seen: Record<string, number>,
): Event {
  if (!returnPath(path)) throw new Error('This file name cannot be returned safely');
  const { share, item, owner } = claim.value;
  return signed(
    REQUEST_LABEL,
    {
      v: 1,
      share,
      item,
      owner,
      claim: claim.event.id,
      revision: fileRevision(cid),
      path,
      nonce: crypto.randomUUID(),
      seen,
    },
    key,
  );
}

export function parseRequest(raw: unknown): Signed<ReturnRequest> | null {
  const event = parseSigned(raw, REQUEST_LABEL);
  if (!event) return null;
  try {
    const value = JSON.parse(event.content);
    if (
      !keysMatch(value, ['v', 'share', 'item', 'owner', 'claim', 'revision', 'path', 'nonce', 'seen']) ||
      !identities(value) ||
      !value.seen ||
      typeof value.seen !== 'object' ||
      Array.isArray(value.seen) ||
      Object.entries(value.seen).some(
        ([pubkey, seq]) => !hash(pubkey) || !Number.isSafeInteger(seq) || Number(seq) <= 0,
      ) ||
      !hash(value.claim) ||
      !hash(value.revision) ||
      !id(value.nonce) ||
      !UUID_V4.test(value.nonce) ||
      !returnPath(value.path)
    )
      return null;
    return { event, value: value as ReturnRequest };
  } catch {
    return null;
  }
}

/** Check the current entry under the write lock. A rename, edit, or new request invalidates the old operation. */
export function currentReturn(
  folder: SharedFolder,
  path: string[],
  entry: TreeEntry,
  requestId?: string,
): Signed<ReturnRequest> | null {
  const request = parseRequest(entry.meta?.[REQUEST_META]);
  const claim = readFileOwner(entry, folder);
  if (!request || !claim || (requestId && request.event.id !== requestId)) return null;
  const { value } = request;
  const writer = projectSharedFolderKeys(folder).active_facets[request.event.pubkey];
  if (
    !writer?.capabilities?.can_write_roots ||
    !writer.profile_id ||
    value.share !== folder.share_id ||
    value.item !== claim.value.item ||
    value.owner !== claim.value.owner ||
    value.claim !== claim.event.id ||
    value.revision !== fileRevision(entry.cid) ||
    JSON.stringify(path) !== JSON.stringify(value.path)
  )
    return null;
  return request;
}

function about(request: Signed<ReturnRequest>, phase: ReturnPhase): string[] {
  return [request.value.share, request.value.item, request.event.id, phase];
}

export function storedReceipt(request: Signed<ReturnRequest>, key: Uint8Array): Event {
  const { share, item, owner, claim, revision } = request.value;
  return signed(STORED_LABEL, { v: 1, share, item, owner, claim, request: request.event.id, revision }, key);
}

export function receiptFor(raw: unknown, request: Signed<ReturnRequest>): Event | null {
  const receipt = parseSigned(JSON.stringify(raw), STORED_LABEL);
  if (!receipt) return null;
  try {
    const proof = JSON.parse(receipt.content);
    if (
      !keysMatch(proof, ['v', 'share', 'item', 'owner', 'claim', 'request', 'revision']) ||
      proof.v !== 1 ||
      proof.request !== request.event.id
    )
      return null;
    const value = request.value;
    return proof.share === value.share &&
      proof.item === value.item &&
      proof.owner === value.owner &&
      proof.claim === value.claim &&
      proof.revision === value.revision
      ? receipt
      : null;
  } catch {
    return null;
  }
}

export function returnNotes(
  request: Signed<ReturnRequest>,
  phase: ReturnPhase,
  key: Uint8Array,
  recipients: string[],
  receipt?: Event,
): Event[] {
  const payload =
    phase === 'stored'
      ? { v: 1, phase, request: request.event, receipt: receipt ?? storedReceipt(request, key) }
      : { v: 1, phase, request: request.event };
  return buildDeviceNotes(key, RETURN_LABEL, about(request, phase), payload, recipients, Math.floor(Date.now() / 1000));
}

export function openReturnNote(
  event: Event,
  key: Uint8Array,
): { request: Signed<ReturnRequest>; phase: ReturnPhase; receipt?: Event } | null {
  try {
    if (event.content.length > 65536 || !verifyEvent(event)) return null;
    const note = readDeviceNote(event, RETURN_LABEL, key);
    const value = note?.payload;
    if (!value || typeof value !== 'object') return null;
    const phase = (value as Record<string, unknown>).phase;
    if (phase !== 'request' && phase !== 'stored') return null;
    if (
      !keysMatch(value, phase === 'stored' ? ['v', 'phase', 'request', 'receipt'] : ['v', 'phase', 'request']) ||
      value.v !== 1
    )
      return null;
    const request = parseRequest(JSON.stringify(value.request));
    const recipient = event.tags.find(([tag]) => tag === 'p')?.[1];
    if (
      !request ||
      !recipient ||
      note?.dTag !== deviceNoteDTag(RETURN_LABEL, about(request, phase), recipient) ||
      event.tags.length !== 3 ||
      event.tags.some((tag) => tag.length !== 2)
    )
      return null;
    if (phase === 'request') return event.pubkey === request.event.pubkey ? { request, phase } : null;
    const receipt = receiptFor(value.receipt, request);
    return receipt && receipt.pubkey === event.pubkey ? { request, phase, receipt } : null;
  } catch {
    return null;
  }
}
