/**
 * How a document is stored inside a Drive folder.
 *
 * Drive merges device roots by path. Files that are only ever added merge
 * cleanly, while a file that one device rewrites or deletes at the moment
 * another device saves comes back as "conflict from …" copies. A document is
 * therefore a set of write-once files, each folder written by one device:
 *
 *   updates/<writer>-<generation>/base          the whole document when the folder was started
 *   updates/<writer>-<generation>/<time>-<id>   one saved batch of edits
 *   updates/<writer>-<generation>/<time>-<id>-<mark>   one marked as more than edits:
 *                                                     r<time> restored the version saved then
 *
 * A writer folds a long folder into a fresh one and removes the old folder
 * only after the other writers have been quiet, so a removal rarely races a
 * save. A lost race costs leftover files, never content: every file is a Yjs
 * update and applying one twice changes nothing.
 */
import { LinkType, toHex, type CID, type HashTree, type TreeEntry } from '@hashtree/core';
import * as Y from 'yjs';

export const UPDATES_DIRECTORY = 'updates';
export const BASE_FILE = 'base';
const READ_CONCURRENCY = 8;
// Change files are named by when they were saved, in milliseconds written in base 36.
const TIME_DIGITS = 9;

/** Transaction origin of updates that came from storage and need no saving. */
export const STORED_ORIGIN = 'stored';
/**
 * Transaction origin of edits received live from someone else who has the
 * document open. Their writer stores them; see liveChannel.ts.
 */
export const LIVE_ORIGIN = 'live';

export interface DocumentChange {
  /** Files to add, as paths below the document folder. */
  writes: Array<{ path: string[]; data: Uint8Array }>;
  /** This writer's own folders that the new files replace, as paths below the document folder. */
  removeDirectories: string[][];
}

export interface DocumentSessionOptions {
  ydoc: Y.Doc;
  tree: Pick<HashTree, 'listDirectory' | 'readFile'>;
  /** Stable id of this device. It names the folders only this device writes. */
  writerId: string;
  /** Stores a change in the Drive as one update, or rejects having stored nothing. */
  commit: (change: DocumentChange) => Promise<void>;
  /** Saved batches kept in one folder before they are folded into a fresh base. */
  maxChanges?: number;
  /** How long other writers must have been quiet before old folders are removed. */
  quietMs?: number;
  now?: () => number;
}

interface OwnFolders {
  generation: number;
  changeCount: number;
  /** Older folders of this writer whose content a newer base already holds. */
  stale: Set<number>;
}

/**
 * The name of a saved batch: it sorts by time, and the counter keeps two
 * saves in one millisecond apart. A mark says what else the batch is.
 */
export function changeFileName(time: number, sequence: number, mark = ''): string {
  const random = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `${time.toString(36).padStart(TIME_DIGITS, '0')}-${sequence.toString(36)}${random}${mark ? `-${mark}` : ''}`;
}

const CHANGE_NAME = /^([0-9a-z]{9})-[0-9a-z]+(?:-([0-9a-z]+))?$/;

/** When a change file was saved, by its name, or null for a base or a name of another form. */
export function changeFileTime(name: string): number | null {
  const match = CHANGE_NAME.exec(name);
  if (!match) return null;
  const time = Number.parseInt(match[1], 36);
  return Number.isSafeInteger(time) ? time : null;
}

/** The mark a change file's name carries, if any. */
export function changeFileMark(name: string): string | null {
  return CHANGE_NAME.exec(name)?.[2] ?? null;
}

function cidKey(cid: CID): string {
  return toHex(cid.hash);
}

function isFile(entry: TreeEntry): boolean {
  return entry.type !== LinkType.Dir;
}

async function mapLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
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

/** Loads a document from its folder and saves this device's edits into it. */
export class DocumentSession {
  private readonly ydoc: Y.Doc;
  private readonly tree: Pick<HashTree, 'listDirectory' | 'readFile'>;
  private readonly writerId: string;
  private readonly commit: (change: DocumentChange) => Promise<void>;
  private readonly maxChanges: number;
  private readonly quietMs: number;
  private readonly now: () => number;
  /** Content already applied, by file hash. */
  private readonly seen = new Set<string>();
  /** Folder listings already walked, by folder hash. */
  private readonly walked = new Set<string>();
  private readonly storedClocks = new Map<number, number>();
  /** The highest clock of each writer that storage is known to hold. */
  private readonly storedTo = new Map<number, number>();
  private pending: Uint8Array[] = [];
  private own: OwnFolders = { generation: 0, changeCount: 0, stale: new Set() };
  private lastForeignAt = 0;
  private saving: Promise<boolean> | null = null;
  private saver = true;
  private sequence = 0;
  private mark = '';

  constructor(options: DocumentSessionOptions) {
    this.ydoc = options.ydoc;
    this.tree = options.tree;
    this.writerId = options.writerId;
    this.commit = options.commit;
    this.maxChanges = options.maxChanges ?? 100;
    this.quietMs = options.quietMs ?? 60_000;
    this.now = options.now ?? Date.now;
    this.ydoc.on('update', this.onUpdate);
  }

  destroy(): void {
    this.ydoc.off('update', this.onUpdate);
  }

  /** True while edits are waiting to be stored. */
  get dirty(): boolean {
    return this.pending.length > 0;
  }

  private readonly onUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === STORED_ORIGIN || origin === LIVE_ORIGIN || !this.saver) return;
    this.pending.push(update);
  };

  /**
   * Whether storage holds what `update` brought. Each writer stores its edits
   * in order, so its highest stored clock stands for all before it.
   */
  holds(update: Uint8Array): boolean {
    for (const [client, clock] of Y.parseUpdateMeta(update).to) {
      if ((this.storedTo.get(client) ?? 0) < clock) return false;
    }
    return true;
  }

  /**
   * Stores `update` with this device's next edits: something received live
   * whose writer never stored it, so that what was written after it does not
   * hang on content nobody has.
   */
  keep(update: Uint8Array): void {
    if (this.saver && !this.holds(update)) this.pending.push(update);
  }

  /**
   * Only one tab of a device saves. A tab that stops saving keeps receiving
   * edits; one that starts saving stores whatever storage does not hold yet.
   */
  setSaver(saver: boolean): void {
    if (saver === this.saver) return;
    this.saver = saver;
    if (!saver) {
      this.pending = [];
      return;
    }
    const missing = Y.encodeStateAsUpdate(this.ydoc, Y.encodeStateVector(this.storedClocks));
    const current = Y.decodeStateVector(Y.encodeStateVector(this.ydoc));
    const ahead = [...current].some(([client, clock]) => clock > (this.storedClocks.get(client) ?? 0));
    if (ahead) this.pending.push(missing);
  }

  /**
   * Applies every stored update in the document folder that has not been
   * applied yet. Returns how many files were new.
   */
  async load(documentEntries: readonly TreeEntry[]): Promise<number> {
    const files: Array<{ cid: CID; own: boolean }> = [];
    const ownGenerations = new Map<number, number>();

    const updates = documentEntries.find(entry => entry.name === UPDATES_DIRECTORY && !isFile(entry));
    if (updates && this.markWalked(updates.cid)) {
      for (const folder of await this.tree.listDirectory(updates.cid)) {
        if (isFile(folder)) {
          files.push({ cid: folder.cid, own: false });
          continue;
        }
        const generation = this.ownGeneration(folder.name);
        // Listing an unchanged folder again would find nothing new.
        if (generation === null && !this.markWalked(folder.cid)) continue;
        const entries = await this.tree.listDirectory(folder.cid);
        if (generation !== null) {
          ownGenerations.set(generation, entries.filter(entry => isFile(entry) && entry.name !== BASE_FILE).length);
        }
        for (const entry of entries) {
          if (isFile(entry)) files.push({ cid: entry.cid, own: generation !== null });
        }
      }
      this.adoptOwnFolders(ownGenerations);
    }

    const unseen = files.filter(file => !this.seen.has(cidKey(file.cid)));
    if (unseen.length === 0) return 0;
    const contents = await mapLimited(unseen, READ_CONCURRENCY, file => this.tree.readFile(file.cid));
    const updatesToApply: Uint8Array[] = [];
    unseen.forEach((file, index) => {
      const data = contents[index];
      // A file that cannot be read yet is tried again on the next load.
      if (!data) {
        this.walked.clear();
        return;
      }
      this.seen.add(cidKey(file.cid));
      updatesToApply.push(data);
      if (!file.own) this.lastForeignAt = this.now();
    });
    if (updatesToApply.length === 0) return 0;
    const merged = updatesToApply.length === 1 ? updatesToApply[0] : Y.mergeUpdates(updatesToApply);
    this.noteStored(merged);
    Y.applyUpdate(this.ydoc, merged, STORED_ORIGIN);
    return updatesToApply.length;
  }

  /** Names the next stored batch of edits with a mark (see changeFileName), when there are edits waiting. */
  markNext(mark: string): void {
    if (this.saver && this.pending.length > 0) this.mark = mark;
  }

  /** Stores waiting edits. Resolves false when there was nothing to store. */
  save(): Promise<boolean> {
    if (this.saving) return this.saving.then(() => this.save(), () => this.save());
    this.saving = this.storePending().finally(() => {
      this.saving = null;
    });
    return this.saving;
  }

  private async storePending(): Promise<boolean> {
    if (!this.saver || this.pending.length === 0) return false;
    const batch = this.pending;
    const mark = this.mark;
    this.pending = [];
    this.mark = '';
    const before: OwnFolders = { ...this.own, stale: new Set(this.own.stale) };
    try {
      const change: DocumentChange = { writes: [], removeDirectories: [] };
      let stored: Uint8Array;
      if (this.own.changeCount >= this.maxChanges) {
        // Fold everything known into the base of a new folder.
        this.own.stale.add(this.own.generation);
        this.own.generation += 1;
        this.own.changeCount = 0;
        stored = Y.encodeStateAsUpdate(this.ydoc);
        change.writes.push({ path: [UPDATES_DIRECTORY, this.folderName(this.own.generation), BASE_FILE], data: stored });
      } else {
        stored = batch.length === 1 ? batch[0] : Y.mergeUpdates(batch);
        this.own.changeCount += 1;
        change.writes.push({
          path: [UPDATES_DIRECTORY, this.folderName(this.own.generation), this.changeName(mark)],
          data: stored,
        });
      }
      const removed = this.now() - this.lastForeignAt >= this.quietMs ? [...this.own.stale] : [];
      change.removeDirectories = removed.map(generation => [UPDATES_DIRECTORY, this.folderName(generation)]);
      await this.commit(change);
      for (const generation of removed) this.own.stale.delete(generation);
      this.noteStored(stored);
      return true;
    } catch (error) {
      this.own = before;
      this.pending = [...batch, ...this.pending];
      this.mark ||= mark;
      throw error;
    }
  }

  private folderName(generation: number): string {
    return `${this.writerId}-${generation}`;
  }

  private ownGeneration(folderName: string): number | null {
    const prefix = `${this.writerId}-`;
    if (!folderName.startsWith(prefix)) return null;
    const suffix = folderName.slice(prefix.length);
    return /^\d+$/.test(suffix) ? Number(suffix) : null;
  }

  private changeName(mark: string): string {
    this.sequence += 1;
    return changeFileName(this.now(), this.sequence, mark);
  }

  private markWalked(cid: CID): boolean {
    const key = cidKey(cid);
    if (this.walked.has(key)) return false;
    this.walked.add(key);
    return true;
  }

  /** Storage may hold folders from an earlier session of this device; continue after them. */
  private adoptOwnFolders(stored: ReadonlyMap<number, number>): void {
    if (stored.size === 0) return;
    const newest = Math.max(...stored.keys());
    if (newest > this.own.generation) {
      this.own.generation = newest;
      this.own.changeCount = stored.get(newest) ?? 0;
    } else if (newest === this.own.generation) {
      this.own.changeCount = Math.max(this.own.changeCount, stored.get(newest) ?? 0);
    }
    for (const generation of stored.keys()) {
      if (generation < this.own.generation) this.own.stale.add(generation);
    }
  }

  private noteStored(update: Uint8Array): void {
    for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update))) {
      if (clock > (this.storedClocks.get(client) ?? 0)) this.storedClocks.set(client, clock);
    }
    for (const [client, clock] of Y.parseUpdateMeta(update).to) {
      if (clock > (this.storedTo.get(client) ?? 0)) this.storedTo.set(client, clock);
    }
  }
}
