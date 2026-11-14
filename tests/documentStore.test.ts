import { describe, expect, it } from 'vitest';
import { HashTree, LinkType, MemoryStore, toHex, type CID, type TreeEntry } from '@hashtree/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import * as Y from 'yjs';
import { buildDriveRootEvent, parseDriveRootEventForDevice } from '../src/drive/protocol';
import { mutateProfileDriveRoot, prepareProfileDriveRootForPublish, type ProfileDriveMutation } from '../src/drive/profileDriveMutation';
import { ProfileDriveProjection } from '../src/drive/profileDriveProjection';
import { DocumentSession, type DocumentChange } from '../src/lib/yjs/documentStore';
import { findMovedDocument } from '../src/lib/yjs/movedDocument';

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';
const DOCUMENT = 'Notes/Plan.irisdoc';
const RENAMED = 'Notes/Final plan.irisdoc';

/** A Drive shared by simulated devices, merged by the real projection. */
class SimulatedDrive {
  readonly tree = new HashTree({ store: new MemoryStore() });
  readonly projection = new ProfileDriveProjection();
  readonly devices: SimulatedDevice[] = [];
  clock = 1_000;
  private empty!: CID;

  async addDevice(options: { maxChanges?: number; quietMs?: number } = {}): Promise<SimulatedDevice> {
    this.empty ??= (await this.tree.putDirectory([])).cid;
    const device = new SimulatedDevice(this, this.empty, options);
    this.devices.push(device);
    return device;
  }

  async merged(): Promise<CID> {
    const authorized = new Set(this.devices.map(device => device.pubkey));
    return (await this.projection.materialize(this.tree, PROFILE_ID, 'main', authorized))?.root ?? this.empty;
  }

  /** Every file below the document folder in the merged Drive. */
  async documentFiles(path = DOCUMENT): Promise<string[]> {
    const folder = await this.tree.resolvePath(await this.merged(), path);
    if (!folder) return [];
    const paths: string[] = [];
    const walk = async (cid: CID, prefix: string): Promise<void> => {
      for (const entry of await this.tree.listDirectory(cid)) {
        if (entry.type === LinkType.Dir) await walk(entry.cid, `${prefix}${entry.name}/`);
        else paths.push(`${prefix}${entry.name}`);
      }
    };
    await walk(folder.cid, '');
    return paths.sort();
  }
}

class SimulatedDevice {
  readonly key = generateSecretKey();
  readonly pubkey = getPublicKey(this.key);
  readonly writerId = this.pubkey.slice(0, 12);
  readonly ydoc = new Y.Doc();
  readonly text = this.ydoc.getText('body');
  readonly session: DocumentSession;
  commits = 0;
  /** Where this device has the document open. */
  path = DOCUMENT;
  private sequence = 0;
  private local: CID;
  private contribution: CID | null = null;
  private observed: Record<string, { app_key_seq: number; root_cid: string }> = {};
  private latest: { sequence: number; root: CID } | null = null;

  constructor(private readonly drive: SimulatedDrive, empty: CID, options: { maxChanges?: number; quietMs?: number }) {
    this.local = empty;
    this.session = new DocumentSession({
      ydoc: this.ydoc,
      tree: drive.tree,
      writerId: this.writerId,
      commit: change => this.commit(change),
      now: () => drive.clock * 1000,
      ...options,
    });
  }

  /** Sees everything published so far and applies new document updates. */
  async sync(): Promise<number> {
    this.local = await this.drive.merged();
    for (const other of this.drive.devices) {
      if (other !== this && other.latest) {
        this.observed[other.pubkey] = { app_key_seq: other.latest.sequence, root_cid: toHex(other.latest.root.hash) };
      }
    }
    return this.session.load(await this.documentEntries());
  }

  async documentEntries(path = this.path): Promise<TreeEntry[]> {
    const folder = await this.drive.tree.resolvePath(this.local, path);
    return folder ? this.drive.tree.listDirectory(folder.cid) : [];
  }

  /** The Drive as this device last saw it, with its own changes. */
  get view(): CID {
    return this.local;
  }

  /** Changes the Drive as the file list does, and publishes it. */
  async mutate(mutation: ProfileDriveMutation): Promise<void> {
    await this.publish(await mutateProfileDriveRoot(this.drive.tree, this.local, mutation, { tombstonedAt: this.drive.clock }));
  }

  type(value: string): void {
    this.text.insert(this.text.length, value);
  }

  /** The editor's write path: Drive mutations on the local view, then one published root. */
  private async commit(change: DocumentChange): Promise<void> {
    const { tree } = this.drive;
    let root = this.local;
    for (const write of change.writes) {
      const file = await tree.putFile(write.data);
      root = await mutateProfileDriveRoot(tree, root, {
        type: 'set-entry',
        path: `${this.path}/${write.path.join('/')}`,
        entry: { cid: file.cid, size: file.size, type: LinkType.Blob },
      });
    }
    for (const directory of change.removeDirectories) {
      root = await mutateProfileDriveRoot(tree, root, {
        type: 'delete',
        path: `${this.path}/${directory.join('/')}`,
        markContents: false,
      }, { tombstonedAt: this.drive.clock });
    }
    // What following a renamed document leaves behind goes with the next save.
    if (this.leftover) {
      root = await mutateProfileDriveRoot(tree, root, { type: 'delete', path: this.leftover, markContents: false }, { tombstonedAt: this.drive.clock });
      this.leftover = null;
    }
    await this.publish(root);
  }

  /** The folder to remove with the next save, as DriveDocument does after following a rename. */
  leftover: string | null = null;

  private async publish(root: CID): Promise<void> {
    const { tree } = this.drive;
    this.local = root;
    const published = await prepareProfileDriveRootForPublish(tree, root, this.contribution);
    this.sequence += 1;
    this.drive.clock += 1;
    const event = buildDriveRootEvent({
      deviceSecretKey: this.key,
      rootScopeId: PROFILE_ID,
      driveId: 'main',
      root: published,
      dckGeneration: 1,
      appKeySeq: this.sequence,
      publishedAt: this.drive.clock,
      authorizedAppKeyPubkeys: this.drive.devices.map(device => device.pubkey),
      observed: { ...this.observed },
    });
    this.drive.projection.add(event, parseDriveRootEventForDevice(event, this.key));
    this.contribution = published;
    this.latest = { sequence: this.sequence, root: published };
    this.commits += 1;
  }
}

// Every simulated save signs and merges real Drive roots, which is slow on a busy machine.
describe('document storage in a Drive folder', { timeout: 30_000 }, () => {
  it('stores each save as a small added file and reloads the document from them', async () => {
    const drive = new SimulatedDrive();
    const writer = await drive.addDevice();
    writer.type('A long opening paragraph. '.repeat(200));
    expect(await writer.session.save()).toBe(true);
    writer.type('One more sentence.');
    await writer.session.save();
    expect(await writer.session.save()).toBe(false);

    const files = await drive.documentFiles();
    expect(files).toHaveLength(2);
    expect(files.every(path => path.startsWith(`updates/${writer.writerId}-0/`))).toBe(true);
    const folder = await drive.tree.resolvePath(await drive.merged(), `${DOCUMENT}/updates/${writer.writerId}-0`);
    const sizes = (await drive.tree.listDirectory(folder!.cid)).map(entry => entry.size).sort((a, b) => a - b);
    // The second file holds only the new sentence, not another copy of the document.
    expect(sizes[0]).toBeLessThan(100);
    expect(sizes[1]).toBeGreaterThan(1_000);

    const reader = await drive.addDevice();
    expect(await reader.sync()).toBe(2);
    expect(reader.text.toString()).toBe(writer.text.toString());
    expect(await reader.sync()).toBe(0);
    expect(reader.session.dirty).toBe(false);
  });

  it('merges simultaneous saves from two devices without conflict copies', async () => {
    const drive = new SimulatedDrive();
    const [first, second] = [await drive.addDevice(), await drive.addDevice()];
    for (let round = 1; round <= 8; round += 1) {
      // Both look at the Drive, then both save before seeing the other's save.
      await first.sync();
      await second.sync();
      first.type(`a${round} `);
      second.type(`b${round} `);
      await first.session.save();
      await second.session.save();
    }
    await first.sync();
    await second.sync();

    expect(first.text.toString()).toBe(second.text.toString());
    for (let round = 1; round <= 8; round += 1) {
      expect(first.text.toString()).toContain(`a${round} `);
      expect(first.text.toString()).toContain(`b${round} `);
    }
    const files = await drive.documentFiles();
    expect(files).toHaveLength(16);
    expect(files.filter(path => path.includes('conflict'))).toEqual([]);
  });

  it('folds a long folder into a fresh base and removes the old one with a single marker', async () => {
    const drive = new SimulatedDrive();
    const writer = await drive.addDevice({ maxChanges: 3, quietMs: 60_000 });
    for (let save = 1; save <= 5; save += 1) {
      writer.type(`line ${save}\n`);
      await writer.session.save();
    }

    const files = await drive.documentFiles();
    // Three changes filled the first folder; the fourth save started the second with a base.
    expect(files.filter(path => path.startsWith(`updates/${writer.writerId}-0/`))).toEqual([]);
    expect(files).toContain(`updates/${writer.writerId}-1/base`);
    expect(files).toHaveLength(2);
    const merged = await drive.merged();
    expect(await drive.tree.resolvePath(merged, '.hashtree')).toBeNull();

    const reader = await drive.addDevice();
    await reader.sync();
    expect(reader.text.toString()).toBe(writer.text.toString());
    expect(reader.text.toString()).toContain('line 1\n');
  });

  it('keeps an old folder while another writer is active and removes it once they are quiet', async () => {
    const drive = new SimulatedDrive();
    const writer = await drive.addDevice({ maxChanges: 2, quietMs: 60_000 });
    const other = await drive.addDevice();
    writer.type('one ');
    await writer.session.save();
    writer.type('two ');
    await writer.session.save();
    other.type('theirs ');
    await other.sync();
    await other.session.save();
    await writer.sync();

    writer.type('three ');
    await writer.session.save();
    expect((await drive.documentFiles()).filter(path => path.startsWith(`updates/${writer.writerId}-0/`))).toHaveLength(2);

    drive.clock += 120;
    await writer.sync();
    writer.type('four ');
    await writer.session.save();
    expect((await drive.documentFiles()).filter(path => path.startsWith(`updates/${writer.writerId}-0/`))).toEqual([]);

    await other.sync();
    expect(other.text.toString()).toBe(writer.text.toString());
    for (const word of ['one ', 'two ', 'three ', 'four ', 'theirs ']) expect(other.text.toString()).toContain(word);
  });

  it('never loses content when a removal races another device\'s save', async () => {
    const drive = new SimulatedDrive();
    const writer = await drive.addDevice({ maxChanges: 2, quietMs: 0 });
    const other = await drive.addDevice();
    for (let round = 1; round <= 6; round += 1) {
      await writer.sync();
      await other.sync();
      writer.type(`w${round} `);
      other.type(`o${round} `);
      // The writer folds and removes folders while the other device saves at the same moment.
      await writer.session.save();
      await other.session.save();
    }
    await writer.sync();
    await other.sync();
    const late = await drive.addDevice();
    await late.sync();

    expect(other.text.toString()).toBe(writer.text.toString());
    expect(late.text.toString()).toBe(writer.text.toString());
    for (let round = 1; round <= 6; round += 1) {
      expect(late.text.toString()).toContain(`w${round} `);
      expect(late.text.toString()).toContain(`o${round} `);
    }
  });

  it('continues in the folders an earlier session of the same device left behind', async () => {
    const drive = new SimulatedDrive();
    const writer = await drive.addDevice({ maxChanges: 3 });
    writer.type('first session ');
    await writer.session.save();
    writer.type('still first ');
    await writer.session.save();

    // The tab is reopened: a new document and session for the same device.
    const reopened = new Y.Doc();
    const commits: DocumentChange[] = [];
    const session = new DocumentSession({
      ydoc: reopened,
      tree: drive.tree,
      writerId: writer.writerId,
      maxChanges: 3,
      commit: async change => { commits.push(change); },
    });
    await writer.sync();
    await session.load(await writer.documentEntries());
    expect(reopened.getText('body').toString()).toBe('first session still first ');

    reopened.getText('body').insert(0, 'x');
    await session.save();
    reopened.getText('body').insert(0, 'y');
    await session.save();
    expect(commits[0].writes[0].path.slice(0, 2)).toEqual(['updates', `${writer.writerId}-0`]);
    // The folder now holds three changes, so the next save starts a new one.
    expect(commits[1].writes[0].path).toEqual(['updates', `${writer.writerId}-1`, 'base']);
  });

  it('keeps unsaved edits and retries when storing fails', async () => {
    const ydoc = new Y.Doc();
    const tree = new HashTree({ store: new MemoryStore() });
    let fail = true;
    const stored: DocumentChange[] = [];
    const session = new DocumentSession({
      ydoc,
      tree,
      writerId: 'aaaaaaaaaaaa',
      commit: async (change) => {
        if (fail) throw new Error('offline');
        stored.push(change);
      },
    });
    ydoc.getText('body').insert(0, 'kept');
    await expect(session.save()).rejects.toThrow('offline');
    expect(session.dirty).toBe(true);

    fail = false;
    ydoc.getText('body').insert(4, ' safe');
    expect(await session.save()).toBe(true);
    expect(session.dirty).toBe(false);
    const restored = new Y.Doc();
    for (const change of stored) for (const write of change.writes) Y.applyUpdate(restored, write.data);
    expect(restored.getText('body').toString()).toBe('kept safe');
  });

  it('lets one tab take over saving and stores what the other tab had not', async () => {
    const drive = new SimulatedDrive();
    const device = await drive.addDevice();
    device.session.setSaver(false);
    device.type('typed while another tab was saving');
    expect(device.session.dirty).toBe(false);
    expect(await device.session.save()).toBe(false);

    device.session.setSaver(true);
    expect(device.session.dirty).toBe(true);
    await device.session.save();

    const reader = await drive.addDevice();
    await reader.sync();
    expect(reader.text.toString()).toBe('typed while another tab was saving');
  });
  it('a device that saved into the old name while it was renamed elsewhere moves everything into the renamed folder', async () => {
    const drive = new SimulatedDrive();
    const [renamer, typist] = [await drive.addDevice(), await drive.addDevice()];
    renamer.type('first ');
    await renamer.session.save();
    await typist.sync();
    expect(drive.projection.deletedAt(PROFILE_ID, 'main', DOCUMENT.split('/'))).toBe(0);

    await renamer.sync();
    await renamer.mutate({ type: 'rename', from: DOCUMENT, to: RENAMED });
    renamer.path = RENAMED;
    // Saved before the typist heard of the rename: it brings the old name back.
    typist.type('late ');
    await typist.session.save();
    await typist.sync();
    expect(await drive.tree.resolvePath(typist.view, DOCUMENT)).not.toBeNull();
    expect(await drive.tree.resolvePath(typist.view, RENAMED)).not.toBeNull();

    // The merge says the old place was deleted after the typist opened it; the renamed folder holds what it read.
    const merged = await drive.merged();
    expect(drive.projection.deletedAt(PROFILE_ID, 'main', DOCUMENT.split('/'), merged)).toBeGreaterThan(0);
    expect(drive.projection.deletedAt(PROFILE_ID, 'main', RENAMED.split('/'), merged)).toBe(0);
    const to = await findMovedDocument({
      tree: drive.tree,
      root: typist.view,
      from: DOCUMENT.split('/'),
      kind: 'document',
      known: entries => typist.session.filesKnown(entries),
    });
    expect(to).toEqual(RENAMED.split('/'));

    // Following it: what that folder lacks is stored there, and the old folder goes with the same save.
    typist.path = RENAMED;
    typist.leftover = DOCUMENT;
    expect(await typist.session.moveTo(await typist.documentEntries())).toBe(true);
    expect(await typist.session.save()).toBe(true);
    renamer.type('after ');
    await renamer.sync();
    await renamer.session.save();

    const final = await drive.merged();
    expect(await drive.tree.resolvePath(final, DOCUMENT)).toBeNull();
    expect((await drive.documentFiles(RENAMED)).filter(path => path.includes('conflict'))).toEqual([]);
    const reader = await drive.addDevice();
    reader.path = RENAMED;
    await reader.sync();
    for (const word of ['first ', 'late ', 'after ']) expect(reader.text.toString()).toContain(word);
    await typist.sync();
    expect(typist.text.toString()).toBe(reader.text.toString());
  });

  it('following a rename stores nothing when the new folder already holds all this copy has', async () => {
    const drive = new SimulatedDrive();
    const [renamer, viewer] = [await drive.addDevice(), await drive.addDevice()];
    renamer.type('only words ');
    await renamer.session.save();
    await viewer.sync();
    await renamer.sync();
    await renamer.mutate({ type: 'rename', from: DOCUMENT, to: RENAMED });
    await viewer.sync();
    expect(await drive.tree.resolvePath(viewer.view, DOCUMENT)).toBeNull();
    viewer.path = RENAMED;
    expect(await viewer.session.moveTo(await viewer.documentEntries())).toBe(false);
    expect(viewer.session.dirty).toBe(false);
    // Typed after following: saved in the new folder.
    viewer.type('more');
    await viewer.session.save();
    const reader = await drive.addDevice();
    reader.path = RENAMED;
    await reader.sync();
    expect(reader.text.toString()).toBe('only words more');
  });
});
