/**
 * Backs up a Drive to one place besides this device, a file server or a
 * folder on this computer, and checks such a backup.
 *
 * A backup sends the Drive's parts as they are stored: encrypted. The keys
 * stay on this device; they are used here only to find which parts make up
 * the Drive. Only parts the place does not have yet are sent.
 *
 * A check reads a sample of the parts back and compares each with its hash,
 * so it proves the sampled bytes are there, not only that the place says so.
 */
import { LinkType, sha256, toHex, type CID, type TreeNode } from '@hashtree/core';

/** Where the Drive's parts are read from on this device. */
export interface DriveParts {
  /** The links a folder or a large file holds; null for a part of a file's content. Throws when the part cannot be found. */
  node(cid: CID): Promise<TreeNode | null>;
  bytes(hash: Uint8Array): Promise<Uint8Array | null>;
}

/** A place that keeps parts by their hash (hex). */
export interface BackupPlace {
  /** Whether the place has the part; throws when it cannot tell. */
  has(hash: string): Promise<boolean>;
  put(hash: string, bytes: Uint8Array): Promise<void>;
  /** The part as the place holds it; null when it does not. */
  read(hash: string): Promise<Uint8Array | null>;
  /** Stop trusting an earlier answer that the place has this part. */
  forget?(hash: string): void;
  /** After a backup: note which Drive version the place now holds. */
  finish?(root: string, parts: number): Promise<void>;
}

export interface BackupReport { total: number; sent: number; present: number; bytesSent: number }
export interface CheckReport { total: number; sampled: number; verified: number; missing: number; unknown: number }

export type BackupPlaceSpec =
  | { kind: 'server'; url: string }
  | { kind: 'folder'; handle: FileSystemDirectoryHandle };

/** What the page asks the worker for. */
export interface DriveBackupRequest {
  target: string;
  job: 'backup' | 'check';
  place: BackupPlaceSpec;
  root: { hash: Uint8Array; key?: Uint8Array };
  /** Ask the place about every part, trusting nothing remembered. */
  fresh?: boolean;
}

export interface DriveBackupResult {
  backup?: BackupReport;
  check?: CheckReport;
  error?: string;
}

export const CHECK_SAMPLE_SIZE = 8;
const CONCURRENCY = 4;
const REQUEST_TIMEOUT_MS = 30_000;

interface Part { hash: Uint8Array; hex: string }

/** At most `max` calls of `run` at once. */
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

/**
 * Every part of the Drive at `root`, each folder before what is in it.
 *
 * A file's entry in a folder may be its content or the list of its pieces,
 * whatever its size, so each one is read to tell; only the pieces a file's
 * list names are known to be content without reading them.
 */
export async function listParts(root: CID, parts: DriveParts, signal?: AbortSignal): Promise<Part[]> {
  const seen = new Map<string, Part>();
  const limit = limiter(CONCURRENCY * 2);
  const visit = async (cid: CID, content: boolean): Promise<void> => {
    signal?.throwIfAborted();
    const hex = toHex(cid.hash);
    if (seen.has(hex)) return;
    seen.set(hex, { hash: cid.hash, hex });
    if (content) return;
    const node = await limit(() => parts.node(cid));
    const pieces = node?.type === LinkType.File;
    await Promise.all((node?.links ?? []).map((link) => (
      visit({ hash: link.hash, key: link.key }, pieces && link.type === LinkType.Blob)
    )));
  };
  await visit(root, false);
  return [...seen.values()];
}

/** Runs `run` on each item, `limit` at a time, stopping at the first failure. */
async function eachLimited<T>(items: T[], limit: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  const lane = async () => {
    while (!failed && next < items.length) {
      try {
        await run(items[next++]);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/** Sends the parts of the Drive at `root` that `place` lacks. */
export async function backUp(
  root: CID,
  parts: DriveParts,
  place: BackupPlace,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<BackupReport> {
  const list = await listParts(root, parts, options.signal);
  const report: BackupReport = { total: list.length, sent: 0, present: 0, bytesSent: 0 };
  let done = 0;
  options.onProgress?.(0, list.length);
  await eachLimited(list, CONCURRENCY, async (part) => {
    options.signal?.throwIfAborted();
    if (await place.has(part.hex)) {
      report.present += 1;
    } else {
      const bytes = await parts.bytes(part.hash);
      if (!bytes) throw new Error('Some parts of your Drive could not be found');
      await place.put(part.hex, bytes);
      report.sent += 1;
      report.bytesSent += bytes.length;
    }
    done += 1;
    options.onProgress?.(done, list.length);
  });
  await place.finish?.(toHex(root.hash), list.length);
  return report;
}

/** Up to `size` items spread evenly over `items`, starting at `offset`. */
export function spreadSample<T>(items: T[], size: number, offset = 0): T[] {
  if (items.length === 0) return [];
  const wanted = Math.min(Math.max(1, size), items.length);
  const step = Math.max(1, Math.floor(items.length / wanted));
  const start = offset % step;
  return items.filter((_, index) => index >= start && (index - start) % step === 0).slice(0, wanted);
}

/** Reads a sample of the Drive's parts back from `place` and compares each with its hash. */
export async function checkBackup(
  root: CID,
  parts: DriveParts,
  place: BackupPlace,
  options: { signal?: AbortSignal; sampleSize?: number; offset?: number } = {},
): Promise<CheckReport> {
  const list = (await listParts(root, parts, options.signal)).sort((a, b) => (a.hex < b.hex ? -1 : 1));
  const size = options.sampleSize ?? CHECK_SAMPLE_SIZE;
  const step = Math.max(1, Math.floor(list.length / Math.max(1, size)));
  const sample = spreadSample(list, size, options.offset ?? Math.floor(Math.random() * step));
  const report: CheckReport = { total: list.length, sampled: sample.length, verified: 0, missing: 0, unknown: 0 };
  await Promise.all(sample.map(async (part) => {
    try {
      const bytes = await place.read(part.hex);
      if (bytes && toHex(await sha256(bytes)) === part.hex) {
        report.verified += 1;
        return;
      }
      report.missing += 1;
      place.forget?.(part.hex);
    } catch {
      report.unknown += 1;
    }
  }));
  return report;
}

/** What a file server says about the parts it keeps, in plain words. */
function refused(response: Response): Error {
  if (response.status === 401 || response.status === 403) return new Error('the server did not accept the backup');
  if (response.status === 413 || response.status === 507) return new Error('the server is full');
  return new Error(`the server answered ${response.status}`);
}

function reached<T>(request: Promise<T>): Promise<T> {
  return request.catch((error: unknown) => {
    if (error instanceof DOMException && (error.name === 'AbortError' || error.name === 'TimeoutError')) throw error;
    throw new Error('could not reach the server');
  });
}

export interface UploadMemory {
  has(server: string, hash: string): boolean;
  add(server: string, hash: string): void;
  forget(server: string, hash: string): void;
}

export interface UnsignedAuth { kind: number; created_at: number; content: string; tags: string[][] }

/**
 * A file server that keeps parts by hash. Uploads are signed by the account;
 * `memory` holds the parts this server confirmed lately, so they are not asked about again.
 */
export function serverPlace(
  server: string,
  send: typeof fetch,
  sign: (event: UnsignedAuth) => Promise<unknown>,
  memory: UploadMemory | null,
  fresh = false,
): BackupPlace {
  const blob = (hash: string) => `${server}/${hash}.bin`;
  return {
    async has(hash) {
      if (!fresh && memory?.has(server, hash)) return true;
      const response = await reached(send(blob(hash), { method: 'HEAD', cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
      if (response.ok) {
        memory?.add(server, hash);
        return true;
      }
      if (response.status === 404) return false;
      throw refused(response);
    },
    async put(hash, bytes) {
      const now = Math.floor(Date.now() / 1000);
      const auth = await sign({
        kind: 24242,
        created_at: now,
        content: `Upload ${hash}`,
        tags: [['t', 'upload'], ['x', hash], ['expiration', String(now + 300)]],
      });
      const response = await reached(send(`${server}/upload`, {
        method: 'PUT',
        headers: {
          Authorization: `Nostr ${btoa(JSON.stringify(auth))}`,
          'Content-Type': 'application/octet-stream',
          'X-SHA-256': hash,
        },
        body: new Blob([bytes as BlobPart]),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 4),
      }));
      if (!response.ok && response.status !== 409) throw refused(response);
    },
    async read(hash) {
      const response = await reached(send(blob(hash), { cache: 'no-store', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
      if (response.status === 404) return null;
      if (!response.ok) throw refused(response);
      return new Uint8Array(await response.arrayBuffer());
    },
    forget(hash) {
      memory?.forget(server, hash);
    },
  };
}

export const FOLDER_MANIFEST = 'iris-drive-backup.json';

function isMissing(error: unknown): boolean {
  return error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError');
}

/**
 * A folder on this computer. Each part is a file named by its hash, two
 * folders deep (`ab/cd/ef…`), the layout the Iris Drive app uses for folder
 * backups; a small manifest says which Drive version the folder holds.
 */
export function folderPlace(folder: FileSystemDirectoryHandle): BackupPlace {
  const file = async (hash: string, create: boolean) => {
    const outer = await folder.getDirectoryHandle(hash.slice(0, 2), { create });
    const inner = await outer.getDirectoryHandle(hash.slice(2, 4), { create });
    return inner.getFileHandle(hash.slice(4), { create });
  };
  const write = async (handle: FileSystemFileHandle, data: Uint8Array | string) => {
    const writable = await handle.createWritable();
    await writable.write(data as FileSystemWriteChunkType);
    await writable.close();
  };
  const read = async (hash: string): Promise<Uint8Array | null> => {
    try {
      return new Uint8Array(await (await (await file(hash, false)).getFile()).arrayBuffer());
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };
  return {
    async has(hash) {
      try {
        await file(hash, false);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    async put(hash, bytes) {
      await write(await file(hash, true), bytes);
    },
    read,
    async finish(root, parts) {
      const manifest = {
        app: 'Iris Drive',
        about: 'Encrypted parts of an Iris Drive. The keys to read them are not kept here.',
        version: 1,
        root,
        parts,
        updatedAt: new Date().toISOString(),
      };
      await write(await folder.getFileHandle(FOLDER_MANIFEST, { create: true }), `${JSON.stringify(manifest, null, 2)}\n`);
    },
  };
}
