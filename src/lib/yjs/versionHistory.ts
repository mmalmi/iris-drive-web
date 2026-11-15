/**
 * Earlier versions of a document, spreadsheet or presentation.
 *
 * Every save is a write-once Yjs update named by when it was saved (see
 * documentStore.ts), so the stored files are the history: the document as it
 * was at some moment is every file saved up to then, applied together. Saves
 * made close together are one version, as when someone writes for a while.
 *
 * A device that has saved many times folds its saves into one base file and
 * later removes the folder that held them. A base holds the whole document of
 * its moment, so nothing from before it can be rebuilt; such versions are not
 * listed. The base's own name carries no time: it is placed just before the
 * first save that follows it, or just after the last one before it.
 *
 * Restoring is undoing, as one edit, everything since the version: what was
 * added since goes, what was removed since comes back. It is an ordinary Yjs
 * update, so other devices merge it with their own edits like any other. It
 * is saved on its own, marked with the version it restored, and always
 * starts a version, so the document as it was before stays in the list.
 */
import * as Y from 'yjs';
import { LinkType, toHex, type CID, type HashTree } from '@hashtree/core';
import { BASE_FILE, UPDATES_DIRECTORY, changeFileMark, changeFileTime } from './documentStore';

/** Saves further apart than this start a new version. */
export const VERSION_GAP_MS = 5 * 60_000;
/** A version that has gone on this long ends with its next save after it, even without a pause. */
export const VERSION_SPAN_MS = 30 * 60_000;
const READ_CONCURRENCY = 8;

export interface StoredFile {
  cid: CID;
  /** The device that saved it, as its folder names it; empty for a file outside such a folder. */
  writer: string;
  generation: number;
  base: boolean;
  /** When it was saved, or for a base, about when; null when that cannot be told. */
  time: number | null;
  /** For a save that restored an earlier version, the time of that version. */
  restored?: number;
}

export interface Version {
  /** When its last save was made; it is the version's name. */
  time: number;
  /** The devices that saved it, by the names of their folders. */
  writers: string[];
  /** When it began by restoring an earlier version, the time of that version. */
  restored?: number;
}

/** What a change file says about itself in its name. */
function describe(name: string): Pick<StoredFile, 'time' | 'restored'> {
  const restored = /^r([0-9a-z]+)$/.exec(changeFileMark(name) ?? '')?.[1];
  return { time: changeFileTime(name), ...(restored ? { restored: Number.parseInt(restored, 36) } : {}) };
}

export interface TimelineOptions {
  gapMs?: number;
  spanMs?: number;
}

async function mapLimited<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index]);
    }
  }));
  return results;
}

function folderKey(writer: string, generation: number): string {
  return `${writer}\n${generation}`;
}

type DocumentUpdateFile = StoredFile & { size: number };

/** Every saved update, including legacy files directly under updates/. */
export async function listDocumentUpdates(tree: Pick<HashTree, 'listDirectory'>, folder: CID, signal?: AbortSignal): Promise<DocumentUpdateFile[]> {
  const updates = (await tree.listDirectory(folder, signal)).find(entry => entry.name === UPDATES_DIRECTORY && entry.type === LinkType.Dir);
  if (!updates) return [];
  const listed = await tree.listDirectory(updates.cid, signal);
  const nested = await mapLimited(listed, READ_CONCURRENCY, async (entry): Promise<DocumentUpdateFile[]> => {
    if (entry.type !== LinkType.Dir) {
      return [{ cid: entry.cid, size: entry.size, writer: '', generation: 0, base: false, ...describe(entry.name) }];
    }
    const match = /^(.+)-(\d+)$/.exec(entry.name);
    const writer = match ? match[1] : entry.name;
    const generation = match ? Number(match[2]) : 0;
    return (await tree.listDirectory(entry.cid, signal))
      .filter(file => file.type !== LinkType.Dir)
      .map(file => {
        const base = file.name === BASE_FILE;
        return { cid: file.cid, size: file.size, writer, generation, base, ...(base ? { time: null } : describe(file.name)) };
      });
  });
  return nested.flat();
}

/** Every update file of a document folder, with when it was saved. */
export async function listStoredFiles(tree: Pick<HashTree, 'listDirectory'>, folder: CID): Promise<StoredFile[]> {
  return placeBases(await listDocumentUpdates(tree, folder));
}

/** Gives each base the time of the fold that wrote it, as near as its neighbours tell. */
export function placeBases(files: StoredFile[]): StoredFile[] {
  const saves = new Map<string, number[]>();
  for (const file of files) {
    if (file.base || file.time === null) continue;
    const key = folderKey(file.writer, file.generation);
    saves.set(key, [...(saves.get(key) ?? []), file.time]);
  }
  const placed = new Map<string, number | null>();
  const timeOf = (writer: string, generation: number): number | null => {
    const key = folderKey(writer, generation);
    if (placed.has(key)) return placed.get(key) ?? null;
    const own = saves.get(key);
    let time: number | null = null;
    // The fold was the save just before the first one into the new folder…
    if (own?.length) time = Math.min(...own) - 1;
    else if (generation > 0) {
      // …or, with none yet, the one just after the last save into the old folder.
      const before = saves.get(folderKey(writer, generation - 1));
      const previous = before?.length ? Math.max(...before) : files.some(file => file.base && file.writer === writer && file.generation === generation - 1) ? timeOf(writer, generation - 1) : null;
      time = previous === null ? null : previous + 1;
    }
    placed.set(key, time);
    return time;
  };
  return files.map(file => (file.base ? { ...file, time: timeOf(file.writer, file.generation) } : file));
}

/**
 * The versions that can be rebuilt from these files, newest first. The
 * first is the document as it is now.
 */
export function versionTimeline(files: readonly StoredFile[], options: TimelineOptions = {}): Version[] {
  const gap = options.gapMs ?? VERSION_GAP_MS;
  const span = options.spanMs ?? VERSION_SPAN_MS;
  // Before a device's oldest base, its saves are gone: versions from then would lack them.
  let horizon = -Infinity;
  const oldest = new Map<string, number>();
  for (const file of files) {
    if (!file.writer) continue;
    oldest.set(file.writer, Math.min(oldest.get(file.writer) ?? Infinity, file.generation));
  }
  for (const file of files) {
    if (file.base && file.generation === oldest.get(file.writer)) horizon = Math.max(horizon, file.time ?? Infinity);
  }

  const saves = files
    .filter((file): file is StoredFile & { time: number } => file.time !== null)
    .sort((left, right) => left.time - right.time);
  const versions: Array<Version & { start: number }> = [];
  for (const save of saves) {
    const last = versions[versions.length - 1];
    if (last && save.restored === undefined && save.time - last.time <= gap && save.time - last.start <= span) {
      last.time = save.time;
      if (save.writer && !last.writers.includes(save.writer)) last.writers.push(save.writer);
    } else {
      versions.push({
        time: save.time,
        start: save.time,
        writers: save.writer ? [save.writer] : [],
        ...(save.restored !== undefined ? { restored: save.restored } : {}),
      });
    }
  }
  return versions
    .filter(version => version.time >= horizon)
    .map(({ time, writers, restored }) => (restored === undefined ? { time, writers } : { time, writers, restored }))
    .reverse();
}

/**
 * The document as it was at a version: every file saved up to then, as one
 * update. `cache` keeps files already read, by hash.
 */
export async function versionUpdate(
  tree: Pick<HashTree, 'readFile'>,
  files: readonly StoredFile[],
  time: number,
  cache: Map<string, Uint8Array> = new Map(),
): Promise<Uint8Array> {
  // A file of unknown time outside the folders is from before them; a base of unknown time is from after every version.
  const wanted = files.filter(file => (file.time === null ? !file.base : file.time <= time));
  const contents = await mapLimited(wanted, READ_CONCURRENCY, async (file) => {
    const key = toHex(file.cid.hash);
    const known = cache.get(key);
    if (known) return known;
    const data = await tree.readFile(file.cid);
    if (data) cache.set(key, data);
    return data;
  });
  if (contents.some(data => !data)) throw new Error('Part of this version is not on this device yet');
  const updates = contents as Uint8Array[];
  return updates.length === 1 ? updates[0] : Y.mergeUpdates(updates);
}

const UNDO_SINCE = Symbol('since the version');

/**
 * Makes `live` what it was at a version again, as one transaction with
 * `origin`: an editor's undo that tracks that origin takes it back in one step.
 * `scope` limits it to some types of the document, such as a text's
 * fragment; by default it is the whole document. Returns false when there
 * was nothing to change.
 */
export function restoreVersion(
  live: Y.Doc,
  version: Uint8Array,
  origin: unknown,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Yjs types differ only in their event type
  scope?: (doc: Y.Doc) => Array<Y.AbstractType<any>>,
): boolean {
  // Without collecting garbage, what was removed since keeps its content and can come back.
  const past = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(past, version);
    const undo = new Y.UndoManager(scope ? scope(past) : past, { trackedOrigins: new Set([UNDO_SINCE]), captureTimeout: 0 });
    Y.applyUpdate(past, Y.encodeStateAsUpdate(live, Y.encodeStateVector(past)), UNDO_SINCE);
    const undone = undo.undo() !== null;
    undo.destroy();
    if (!undone) return false;
    Y.applyUpdate(live, Y.encodeStateAsUpdate(past, Y.encodeStateVector(live)), origin);
    return true;
  } finally {
    past.destroy();
  }
}

function startOfDay(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** The heading a version is listed under: "Today", "Yesterday" or its date. */
export function versionDay(time: number, now = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return new Date(time).toLocaleDateString(undefined, { month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export function versionClock(time: number, seconds = false): string {
  return new Date(time).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) });
}

/** A version's date and time in a few words: "November 14, 3:42 PM". */
export function versionMoment(time: number, now = Date.now()): string {
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return new Date(time).toLocaleString(undefined, {
    month: 'long',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}
