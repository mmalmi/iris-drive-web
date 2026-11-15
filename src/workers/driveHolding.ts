/**
 * How much of a Drive this device holds: the size of every file in it, as its
 * folders list them, and how much of each file's content is stored here.
 *
 * Folders are read, from elsewhere when this device lacks one: they are small
 * and needed to show the Drive anyway. A file's content is never fetched or
 * read; a part counts as held only when it is stored here already. Sizes are
 * the files' own, as the native app counts them, not what their encrypted
 * parts take.
 *
 * A folder's hash fixes what is in it, so what was counted for it is kept and
 * used again while it is younger than `maxAgeMs`: after an edit only the
 * folders on the changed path are counted again, also inside a folder of a
 * million files, which is stored split into parts of its own. Only what is
 * held can change under an unchanged hash, as content is fetched or removed;
 * a measurement with `maxAgeMs: 0` counts everything again.
 */
import { DEFAULT_CHUNK_SIZE, LinkType, toHex, type CID, type Link, type TreeNode } from '@hashtree/core';

export interface HoldingParts {
  /** Whether this device stores the part; never asks elsewhere. */
  has(hash: Uint8Array): Promise<boolean>;
  /** The links a folder or a file's list of pieces holds; null for content. Throws when it cannot be found. */
  node(cid: CID): Promise<TreeNode | null>;
}

export interface Tally {
  files: number;
  bytes: number;
  /** Files whose whole content is here. */
  heldFiles: number;
  heldBytes: number;
}

export interface FolderHolding {
  /** Names from the top of the Drive down. */
  path: string[];
  bytes: number;
  held: number;
}

export interface DriveHolding extends Tally {
  /** Files at the top of the Drive, in no folder. */
  loose: Tally;
  /**
   * The folders that make up a real share of the Drive, each with what is
   * inside it, subfolders included: a folder before its subfolders, larger
   * ones first.
   */
  folders: FolderHolding[];
  /** Folders that could not be read: their files are not counted. */
  unreadFolders: number;
}

interface FolderTally extends Tally {
  loose: Tally;
  /** Folders directly inside, by name, as the hashes of their parts. */
  subfolders: Array<[name: string, hash: string]>;
  unreadFolders: number;
  at: number;
}

/** Where the Drive keeps its own records, not files. */
const META = '.hashtree';
const CONCURRENCY = 8;
/** A folder is listed when it holds at least this share of the Drive… */
export const FOLDER_SHARE = 0.02;
/** …down to this many levels, and at most this many folders. */
export const FOLDER_DEPTH = 4;
export const MAX_FOLDERS = 48;
const MAX_REMEMBERED = 200_000;

const remembered = new Map<string, FolderTally>();

const empty = (): Tally => ({ files: 0, bytes: 0, heldFiles: 0, heldBytes: 0 });

function add(into: Tally, tally: Tally): void {
  into.files += tally.files;
  into.bytes += tally.bytes;
  into.heldFiles += tally.heldFiles;
  into.heldBytes += tally.heldBytes;
}

function limiter(max: number): <T>(run: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (run) => {
    while (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await run();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

const cidOf = (link: Link): CID => (link.key ? { hash: link.hash, key: link.key } : { hash: link.hash });

/** A large folder split into `_chunk_<n>` parts, as older writers did. */
function isLegacyFanout(links: Link[]): boolean {
  return links.length > 0 && links.every((link) => link.type === LinkType.Dir && /^_chunk_\d+$/.test(link.name ?? ''));
}

/** Forget what was counted, as when another account signs in. */
export function forgetHolding(): void {
  remembered.clear();
}

export async function measureHolding(
  root: CID,
  parts: HoldingParts,
  options: { signal?: AbortSignal; maxAgeMs?: number; now?: number } = {},
): Promise<DriveHolding> {
  const { signal } = options;
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? Infinity;
  const limit = limiter(CONCURRENCY);
  const has = (hash: Uint8Array) => limit(() => parts.has(hash));

  // A file of one piece is that piece; a larger one is a list of pieces. Both
  // writers cut files into pieces of this size, so a small file is checked
  // without reading it.
  const heldOf = async (cid: CID, size: number, piece: boolean): Promise<number> => {
    signal?.throwIfAborted();
    if (!await has(cid.hash)) return 0;
    if (piece || size <= DEFAULT_CHUNK_SIZE) return size;
    const node = await limit(() => parts.node(cid));
    if (node?.type !== LinkType.File) return size;
    const pieces = await Promise.all(node.links.map((link) => heldOf(cidOf(link), link.size, link.type === LinkType.Blob)));
    return Math.min(size, pieces.reduce((sum, bytes) => sum + bytes, 0));
  };

  const count = async (cid: CID): Promise<FolderTally> => {
    signal?.throwIfAborted();
    const hex = toHex(cid.hash);
    const known = remembered.get(hex);
    if (known && now - known.at <= maxAge) return known;
    const tally: FolderTally = { ...empty(), loose: empty(), subfolders: [], unreadFolders: 0, at: now };
    let node: TreeNode | null;
    try {
      node = await limit(() => parts.node(cid));
    } catch {
      signal?.throwIfAborted();
      // Not remembered: it is tried again next time.
      return { ...tally, unreadFolders: 1 };
    }
    const links = node?.links ?? [];
    const fanout = isLegacyFanout(links);
    await Promise.all(links.map(async (link) => {
      if (link.type === LinkType.Fanout || fanout) {
        // Part of this same folder.
        const part = await count(cidOf(link));
        add(tally, part);
        add(tally.loose, part.loose);
        tally.subfolders.push(...part.subfolders);
        tally.unreadFolders += part.unreadFolders;
        return;
      }
      if (link.name === META) return;
      if (link.type === LinkType.Dir) {
        const sub = await count(cidOf(link));
        add(tally, sub);
        tally.unreadFolders += sub.unreadFolders;
        tally.subfolders.push([link.name ?? '', toHex(link.hash)]);
        return;
      }
      // Drive enters a file as content whatever its size, so its type does not tell.
      const held = await heldOf(cidOf(link), link.size, false);
      const file = { files: 1, bytes: link.size, heldFiles: held >= link.size ? 1 : 0, heldBytes: held };
      add(tally, file);
      add(tally.loose, file);
    }));
    if (tally.unreadFolders === 0) {
      if (remembered.size >= MAX_REMEMBERED) remembered.clear();
      remembered.set(hex, tally);
    }
    return tally;
  };

  const top = await count(root);
  return {
    files: top.files,
    bytes: top.bytes,
    heldFiles: top.heldFiles,
    heldBytes: top.heldBytes,
    loose: top.loose,
    folders: largeFolders(top),
    unreadFolders: top.unreadFolders,
  };
}

/** A path as one string; names hold no NUL. */
const key = (path: string[]) => path.join('\0');

/** The folders holding at least FOLDER_SHARE of the Drive, a folder before its subfolders. */
function largeFolders(top: FolderTally): FolderHolding[] {
  const least = Math.max(1, top.bytes * FOLDER_SHARE);
  const found: Array<FolderHolding & { parent: string }> = [];
  const visit = (folder: FolderTally, path: string[]) => {
    if (path.length >= FOLDER_DEPTH) return;
    for (const [name, hash] of folder.subfolders) {
      const sub = remembered.get(hash);
      if (!sub || sub.bytes < least) continue;
      const at = [...path, name];
      found.push({ path: at, bytes: sub.bytes, held: sub.heldBytes, parent: key(path) });
      visit(sub, at);
    }
  };
  visit(top, []);
  // The largest, which takes in each one's parents, as no subfolder is larger than its folder.
  const kept = new Set(
    [...found].sort((a, b) => b.bytes - a.bytes || a.path.length - b.path.length).slice(0, MAX_FOLDERS),
  );
  const children = new Map<string, Array<FolderHolding & { parent: string }>>();
  for (const folder of kept) children.set(folder.parent, [...(children.get(folder.parent) ?? []), folder]);
  const ordered: FolderHolding[] = [];
  const place = (parent: string) => {
    for (const folder of (children.get(parent) ?? []).sort((a, b) => b.bytes - a.bytes || key(a.path).localeCompare(key(b.path)))) {
      ordered.push({ path: folder.path, bytes: folder.bytes, held: folder.held });
      place(key(folder.path));
    }
  };
  place('');
  return ordered;
}
