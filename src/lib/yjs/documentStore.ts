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
 *
 * A writer folds a long folder into a fresh one and removes the old folder
 * only after the other writers have been quiet, so a removal rarely races a
 * save. A lost race costs leftover files, never content: every file is a Yjs
 * update and applying one twice changes nothing.
 */
import { LinkType, toHex, type CID, type HashTree, type TreeEntry } from '@hashtree/core';
import * as Y from 'yjs';

export const UPDATES_DIRECTORY = 'updates';
const BASE_FILE = 'base';
// Documents written before this layout: one full copy per save.
const LEGACY_STATE_FILE = 'state.yjs';
const LEGACY_DELTAS_DIRECTORY = 'deltas';
const READ_CONCURRENCY = 8;

/** Transaction origin of updates that came from storage and need no saving. */
export const STORED_ORIGIN = 'stored';

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
  private pending: Uint8Array[] = [];
  private own: OwnFolders = { generation: 0, changeCount: 0, stale: new Set() };
  private lastForeignAt = 0;
  private saving: Promise<boolean> | null = null;
  private saver = true;
  private sequence = 0;

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
    if (origin === STORED_ORIGIN || !this.saver) return;
    this.pending.push(update);
  };

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

    const legacyState = documentEntries.find(entry => entry.name === LEGACY_STATE_FILE && isFile(entry));
    if (legacyState) files.push({ cid: legacyState.cid, own: false });
    const legacyDeltas = documentEntries.find(entry => entry.name === LEGACY_DELTAS_DIRECTORY && !isFile(entry));
    if (legacyDeltas && this.markWalked(legacyDeltas.cid)) {
      for (const entry of await this.tree.listDirectory(legacyDeltas.cid)) {
        if (isFile(entry)) files.push({ cid: entry.cid, own: false });
      }
    }

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
    this.pending = [];
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
          path: [UPDATES_DIRECTORY, this.folderName(this.own.generation), this.changeName()],
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

  /** Names sort by time; the counter keeps two saves in one millisecond apart. */
  private changeName(): string {
    this.sequence += 1;
    const random = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
    return `${this.now().toString(36).padStart(9, '0')}-${this.sequence.toString(36)}${random}`;
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
  }
}
