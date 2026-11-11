import { describe, expect, it } from 'vitest';
import { HashTree, LinkType, MemoryStore, toHex, type CID, type TreeEntry } from '@hashtree/core';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import * as Y from 'yjs';
import { buildDriveRootEvent, parseDriveRootEventForDevice } from '../src/drive/protocol';
import { mutateProfileDriveRoot, prepareProfileDriveRootForPublish } from '../src/drive/profileDriveMutation';
import { ProfileDriveProjection } from '../src/drive/profileDriveProjection';
import { DocumentSession, type DocumentChange } from '../src/lib/yjs/documentStore';

const PROFILE_ID = '89f3d04f-41fb-437b-9339-75df537bf291';
const DOCUMENT = 'Notes/Plan';

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
  async documentFiles(): Promise<string[]> {
    const folder = await this.tree.resolvePath(await this.merged(), DOCUMENT);
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

  async documentEntries(): Promise<TreeEntry[]> {
    const folder = await this.drive.tree.resolvePath(this.local, DOCUMENT);
    return folder ? this.drive.tree.listDirectory(folder.cid) : [];
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
        path: `${DOCUMENT}/${write.path.join('/')}`,
        entry: { cid: file.cid, size: file.size, type: LinkType.Blob },
      });
    }
    for (const directory of change.removeDirectories) {
      root = await mutateProfileDriveRoot(tree, root, {
        type: 'delete',
        path: `${DOCUMENT}/${directory.join('/')}`,
        markContents: false,
      }, { tombstonedAt: this.drive.clock });
    }
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

describe('document storage in a Drive folder', () => {
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

  it('opens a document saved in the old one-copy-per-save layout', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const old = new Y.Doc();
    const copies: Uint8Array[] = [];
    for (const word of ['old ', 'format ', 'document']) {
      old.getText('body').insert(old.getText('body').length, word);
      copies.push(Y.encodeStateAsUpdate(old));
    }
    const deltas = await tree.putDirectory(await Promise.all(copies.map(async (data, index) => {
      const file = await tree.putFile(data);
      return { name: `delta-${index}`, cid: file.cid, size: file.size, type: LinkType.Blob };
    })));
    const marker = await tree.putFile(new TextEncoder().encode('npub1example\n'));
    const entries: TreeEntry[] = [
      { name: '.yjs', cid: marker.cid, size: marker.size, type: LinkType.Blob },
      { name: 'deltas', cid: deltas.cid, size: 0, type: LinkType.Dir },
    ];

    const ydoc = new Y.Doc();
    const session = new DocumentSession({ ydoc, tree, writerId: 'bbbbbbbbbbbb', commit: async () => {} });
    expect(await session.load(entries)).toBe(3);
    expect(ydoc.getText('body').toString()).toBe('old format document');
    expect(session.dirty).toBe(false);
  });
});
