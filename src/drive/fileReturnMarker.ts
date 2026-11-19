import { LinkType, type CID, type HashTree, type TreeEntry } from '@hashtree/core';
import type { Event } from 'nostr-tools';
import type { ProfileDriveSnapshot } from './profileDriveProjection';
import type { DirectoryBuilder } from './directoryBuilder';
import type { SharedFolder } from './protocolTypes';
import { projectSharedFolderKeys } from './protocolShareSnapshot';
import {
  fileRevision,
  OWNER_META,
  parseRequest,
  parseOwnership,
  receiptFor,
  type ReturnRequest,
  type Signed,
} from './fileReturnProtocol';

export const RETURN_MARKERS = 'file-returns-v1';
export interface ReturnMarker {
  v: 1;
  claim: Event;
  request: Event;
  receipt: Event;
}

interface VerifiedReturn {
  request: Signed<ReturnRequest>;
  ownerKey: string;
  receiptKey: string;
}

function verifySignatures(marker: ReturnMarker): VerifiedReturn | null {
  if (marker?.v !== 1 || Object.keys(marker).length !== 4) return null;
  const request = parseRequest(JSON.stringify(marker.request));
  if (!request || request.value.claim !== marker.claim?.id) return null;
  const claim = parseOwnership(JSON.stringify(marker.claim));
  const receipt = receiptFor(marker.receipt, request);
  if (
    !claim ||
    !receipt ||
    claim.value.share !== request.value.share ||
    claim.value.owner !== request.value.owner ||
    claim.value.item !== request.value.item
  )
    return null;
  return { request, ownerKey: claim.event.pubkey, receiptKey: receipt.pubkey };
}

function authorized(proof: VerifiedReturn, share: string, roster: ReturnType<typeof projectSharedFolderKeys>): boolean {
  const identity = (key: string) => roster.active_facets[key]?.profile_id ?? roster.tombstones[key]?.profile_id;
  const { event, value } = proof.request;
  return (
    value.share === share &&
    identity(proof.ownerKey) === value.owner &&
    identity(proof.receiptKey) === value.owner &&
    !!identity(event.pubkey)
  );
}

/** Authenticate the receipt itself even after one of the previously authorized devices leaves. */
export function verifyMarker(marker: ReturnMarker, folder: SharedFolder): ReturnRequest | null {
  const proof = verifySignatures(marker);
  return proof && authorized(proof, folder.share_id, projectSharedFolderKeys(folder)) ? proof.request.value : null;
}

// Only immutable signature checks are reusable. Each projection checks the current roster again.
const cacheByFolder = new WeakMap<SharedFolder, { proofs: Map<string, VerifiedReturn>; claims: Map<string, string> }>();
function remember<T>(map: Map<string, T>, key: string, value: T) {
  if (map.size >= 512) map.delete(map.keys().next().value!);
  map.set(key, value);
}

function returnedRevision(
  entry: TreeEntry,
  writer: string,
  sequence: number,
  records: ReturnRequest[],
  claims: Map<string, string>,
): boolean {
  const raw = entry.meta?.[OWNER_META];
  if (typeof raw !== 'string' || !entry.cid.key) return false;
  let id = claims.get(raw);
  if (!id) {
    const claim = parseOwnership(raw);
    if (!claim) return false;
    id = claim.event.id;
    remember(claims, raw, id);
  }
  const revision = fileRevision(entry.cid);
  return records.some(
    (record) =>
      record.claim === id && (record.revision === revision || (sequence > 0 && sequence <= (record.seen[writer] ?? 0))),
  );
}

/** Write a conditional removal beside the directory, preserving the remaining metadata on the root. */
export async function finishFileReturn(tree: HashTree, root: CID, path: string[], marker: ReturnMarker): Promise<CID> {
  let next = await tree.removeEntry(root, path.slice(0, -1), path.at(-1)!);
  for (const parts of [['.hashtree'], ['.hashtree', RETURN_MARKERS]]) {
    const dir = await tree.resolvePath(next, parts);
    if (dir && dir.type !== LinkType.Dir) throw new Error('Shared folder metadata could not be read');
    if (!dir)
      next = await tree.setEntry(
        next,
        parts.slice(0, -1),
        parts.at(-1)!,
        (await tree.putDirectory([])).cid,
        0,
        LinkType.Dir,
      );
  }
  const file = await tree.putFile(new TextEncoder().encode(JSON.stringify(marker)));
  return tree.setEntry(
    next,
    ['.hashtree', RETURN_MARKERS],
    marker.request.id + '.json',
    file.cid,
    file.size,
    LinkType.Blob,
  );
}

/** A later rename or upload can start from a logical root made before another device finished a return. */
export async function retainFileReturns(tree: HashTree, root: CID, previous: CID): Promise<CID> {
  const path = ['.hashtree', RETURN_MARKERS];
  const prior = await tree.resolvePath(previous, path);
  if (prior?.type !== LinkType.Dir) return root;
  const current = await tree.resolvePath(root, path);
  if (current && current.type !== LinkType.Dir) throw new Error('Invalid shared file history');
  if (current && fileRevision(current.cid) === fileRevision(prior.cid)) return root;
  let dir = prior.cid;
  if (current) {
    const existing = await tree.listDirectory(current.cid);
    const names = new Set(existing.map((entry) => entry.name));
    const missing = (await tree.listDirectory(prior.cid)).filter((entry) => !names.has(entry.name));
    if (!missing.length) return root;
    dir = (await tree.putDirectory([...existing, ...missing])).cid;
  }
  let next = root;
  if (!(await tree.resolvePath(next, ['.hashtree']))) {
    next = await tree.setEntry(next, [], '.hashtree', (await tree.putDirectory([])).cid, 0, LinkType.Dir);
  }
  return tree.setEntry(next, ['.hashtree'], RETURN_MARKERS, dir, 0, LinkType.Dir);
}

export async function applyFileReturns(
  tree: HashTree,
  snapshots: ProfileDriveSnapshot[],
  folder: SharedFolder,
  builder: DirectoryBuilder,
  signal?: AbortSignal,
): Promise<void> {
  const records = new Map<string, ReturnRequest[]>();
  const retained = new Set<string>();
  const roster = projectSharedFolderKeys(folder);
  const cache = cacheByFolder.get(folder) ?? {
    proofs: new Map<string, VerifiedReturn>(),
    claims: new Map<string, string>(),
  };
  cacheByFolder.set(folder, cache);
  for (const snapshot of snapshots) {
    if (!snapshot.returnDirectory) continue;
    for (const slot of await tree.listDirectory(snapshot.returnDirectory, signal)) {
      if (
        retained.has(slot.name) ||
        !/^[0-9a-f]{64}\.json$/.test(slot.name) ||
        slot.type !== LinkType.Blob ||
        !slot.cid.key ||
        slot.size > 65536
      )
        continue;
      signal?.throwIfAborted();
      const identity = fileRevision(slot.cid);
      let proof = cache.proofs.get(identity);
      if (!proof) {
        const raw = await tree.readFile(slot.cid, { maxBytes: 65536 });
        signal?.throwIfAborted();
        if (!raw) throw new Error('The shared file return record is unavailable');
        let marker: ReturnMarker;
        try {
          marker = JSON.parse(new TextDecoder().decode(raw));
        } catch {
          continue;
        }
        const checked = verifySignatures(marker);
        if (!checked) continue;
        remember(cache.proofs, identity, checked);
        proof = checked;
      }
      if (slot.name !== proof.request.event.id + '.json' || !authorized(proof, folder.share_id, roster)) continue;
      const value = proof.request.value;
      retained.add(slot.name);
      builder.directory(['.hashtree', RETURN_MARKERS]).setLeaf(slot.name, slot);
      const path = value.path.join('/');
      const versions = records.get(path) ?? [];
      versions.push(value);
      records.set(path, versions);
    }
  }
  if (!records.size) return;
  for (const snapshot of snapshots) {
    snapshot.files = snapshot.files.filter((file) => {
      const versions = records.get(file.path);
      return (
        !versions ||
        !returnedRevision(
          file.entry,
          snapshot.source.event.pubkey,
          snapshot.source.parsed.app_key_seq,
          versions,
          cache.claims,
        )
      );
    });
  }
}
