import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, type Event } from 'nostr-tools';
import { HashTree, MemoryStore, toHex, type CID } from '@hashtree/core';
import {
  buildDeviceStorageEvent,
  DEVICE_STORAGE_LABEL,
  deviceStorageDTag,
  openDeviceStorageEvent,
  readDeviceStorageReport,
  type DeviceStorageReport,
} from '../src/drive/deviceStorageReport';
import { forgetHolding, measureHolding, type HoldingParts } from '../src/workers/driveHolding';
import { folderLines, holdersSentence, holdingLabel, spaceLabel, syncState } from '../src/lib/deviceStorageView';

const PROFILE = '0f'.repeat(32);
const BIG = 2 * 1024 * 1024 + 1000;
const format = (bytes: number) => `${bytes} B`;

function report(overrides: Partial<DeviceStorageReport> = {}): DeviceStorageReport {
  return {
    v: 1,
    measured_at: 1_700_000_000,
    app: 'web',
    root: 'ab'.repeat(32),
    files: 3,
    file_bytes: 3000,
    held_files: 1,
    held_bytes: 1000,
    stored_bytes: 5000,
    capacity_bytes: 10_000,
    ...overrides,
  };
}

describe('a device storage report', () => {
  it('opens for each of the account devices it was sent to, and for no other key', async () => {
    const sender = generateSecretKey();
    const other = generateSecretKey();
    const stranger = generateSecretKey();
    const event = await buildDeviceStorageEvent(sender, PROFILE, report(), [getPublicKey(other)], 1_700_000_100);

    // Relays can tell neither the account nor what the event is.
    expect(event.tags).toEqual([['d', deviceStorageDTag(PROFILE)]]);
    expect(JSON.stringify(event)).not.toContain(PROFILE);
    expect(JSON.stringify(event)).not.toContain(DEVICE_STORAGE_LABEL);
    expect(event.content).not.toContain('3000');
    expect(await openDeviceStorageEvent(event, PROFILE, other)).toEqual(report());
    expect(await openDeviceStorageEvent(event, PROFILE, sender)).toEqual(report());
    expect(await openDeviceStorageEvent(event, PROFILE, stranger)).toBeNull();
    expect(await openDeviceStorageEvent(event, 'aa'.repeat(32), other)).toBeNull();
  });

  it('is refused when changed after signing', async () => {
    const sender = generateSecretKey();
    const event = await buildDeviceStorageEvent(sender, PROFILE, report(), []);
    const changed: Event = { ...event, created_at: event.created_at + 1 };
    expect(await openDeviceStorageEvent(changed, PROFILE, sender)).toBeNull();
  });

  it('keeps only well-formed fields, and never more held than there is', () => {
    expect(readDeviceStorageReport({ ...report(), files: -1 })).toBeNull();
    expect(readDeviceStorageReport({ ...report(), root: 'nope' })).toBeNull();
    const read = readDeviceStorageReport({
      ...report({ held_bytes: 9999 }),
      seen: { ['cd'.repeat(32)]: 4, bad: 2, ['ef'.repeat(32)]: -1 },
      loose: { files: 1, bytes: 10, held: 20 },
      folders: [{ path: ['Photos'], bytes: 100, held: 500 }, { path: [], bytes: 1, held: 1 }, { name: 'old', bytes: 1, held: 1 }],
    });
    expect(read?.held_bytes).toBe(3000);
    expect(read?.seen).toEqual({ ['cd'.repeat(32)]: 4 });
    expect(read?.loose).toEqual({ files: 1, bytes: 10, held: 10 });
    expect(read?.folders).toEqual([{ path: ['Photos'], bytes: 100, held: 100 }]);
  });
});

async function drive(): Promise<{ root: CID; tree: HashTree; store: MemoryStore; large: CID; photos: CID }> {
  const store = new MemoryStore();
  const tree = new HashTree({ store });
  const put = (text: string) => tree.putFile(new TextEncoder().encode(text));
  const small = await put('hello');
  const large = await tree.putFile(new Uint8Array(BIG).map((_, index) => index % 251));
  const trip = await put('a photo of a trip');
  const year = await tree.putDirectory([{ name: 'trip.jpg', cid: trip.cid, size: trip.size, type: 0 }]);
  const photos = await tree.putDirectory([
    { name: 'large.bin', cid: large.cid, size: large.size, type: 0 },
    { name: '2024', cid: year.cid, size: 0, type: 2 },
  ]);
  const meta = await tree.putDirectory([]);
  const { cid: root } = await tree.putDirectory([
    { name: 'hello.txt', cid: small.cid, size: small.size, type: 0 },
    { name: 'Photos', cid: photos.cid, size: 0, type: 2 },
    { name: '.hashtree', cid: meta.cid, size: 0, type: 2 },
  ]);
  return { root, tree, store, large: large.cid, photos: photos.cid };
}

function partsOf(tree: HashTree, local: Set<string>, unreadable = new Set<string>()): HoldingParts & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async has(hash) { return local.has(toHex(hash)); },
    async node(cid) {
      reads.push(toHex(cid.hash));
      if (unreadable.has(toHex(cid.hash))) throw new Error('not found');
      return tree.getTreeNode(cid);
    },
  };
}

describe('measuring what a device holds', () => {
  beforeEach(() => forgetHolding());

  it('counts every file, and as held only the parts stored here', async () => {
    const { root, tree, store, large } = await drive();
    const all = new Set((await store.keys()).map(toHex));
    const node = await tree.getTreeNode(large);
    const smallPiece = node!.links.find((link) => link.size === 1000)!;
    all.delete(toHex(smallPiece.hash));

    const holding = await measureHolding(root, partsOf(tree, all));
    expect(holding.files).toBe(3);
    expect(holding.bytes).toBe(5 + BIG + 17);
    expect(holding.heldBytes).toBe(5 + 2 * 1024 * 1024 + 17);
    expect(holding.heldFiles).toBe(2);
    expect(holding.loose).toEqual({ files: 1, bytes: 5, heldFiles: 1, heldBytes: 5 });
    expect(holding.folders.map((folder) => folder.path)).toEqual([['Photos']]);
  });

  it('holds nothing of files whose content is elsewhere, without reading them', async () => {
    const { root, tree, store, large } = await drive();
    const folders = new Set<string>();
    for (const hash of await store.keys()) {
      const node = await tree.getTreeNode({ hash });
      if (node?.type === 2) folders.add(toHex(hash));
    }
    const parts = partsOf(tree, folders);
    const holding = await measureHolding(root, parts);
    expect(holding.heldBytes).toBe(0);
    expect(holding.heldFiles).toBe(0);
    expect(parts.reads).not.toContain(toHex(large.hash));
  });

  it('counts again only the folders that changed', async () => {
    const { root, tree, store, photos } = await drive();
    const all = new Set((await store.keys()).map(toHex));
    await measureHolding(root, partsOf(tree, all), { now: 1000 });

    const note = await tree.putFile(new TextEncoder().encode('new'));
    const listed = await tree.listDirectory(root);
    const { cid: next } = await tree.putDirectory([
      ...listed.map((entry) => ({ name: entry.name, cid: entry.cid, size: entry.size, type: entry.type })),
      { name: 'new.txt', cid: note.cid, size: note.size, type: 0 },
    ]);
    for (const hash of await store.keys()) all.add(toHex(hash));
    const parts = partsOf(tree, all);
    const holding = await measureHolding(next, parts, { now: 2000 });
    expect(holding.files).toBe(4);
    expect(parts.reads).not.toContain(toHex(photos.hash));

    const recount = partsOf(tree, all);
    await measureHolding(next, recount, { now: 3000, maxAgeMs: 0 });
    expect(recount.reads).toContain(toHex(photos.hash));
  });

  it('goes on past a folder it cannot read, and says so', async () => {
    const { root, tree, store, photos } = await drive();
    const all = new Set((await store.keys()).map(toHex));
    const holding = await measureHolding(root, partsOf(tree, all, new Set([toHex(photos.hash)])));
    expect(holding.unreadFolders).toBe(1);
    expect(holding.files).toBe(1);
  });

  it('lists large folders under their parents and leaves small ones out', async () => {
    const { root, tree, store } = await drive();
    const all = new Set((await store.keys()).map(toHex));
    const holding = await measureHolding(root, partsOf(tree, all));
    // 2024 holds 17 bytes of over 2 MB: too small to list.
    expect(holding.folders).toEqual([{ path: ['Photos'], bytes: BIG + 17, held: BIG + 17 }]);
  });
});

describe('what the Storage page says', () => {
  it('says how much a device holds, and how much room it uses', () => {
    expect(holdingLabel(report({ held_files: 3, held_bytes: 3000 }), format)).toBe('All of it');
    expect(holdingLabel(report(), format)).toBe('1000 B · 33%');
    expect(holdingLabel(report({ held_bytes: 0, held_files: 0 }), format)).toBe('None of it');
    expect(holdingLabel(report({ held_bytes: 1, file_bytes: 1000 }), format)).toBe('1 B · under 1%');
    expect(spaceLabel(report(), format)).toBe('Uses 5000 B of 10000 B allowed');
  });

  it('names the devices that hold everything', () => {
    const all = report({ held_files: 3, held_bytes: 3000 });
    expect(holdersSentence([{ pubkey: 'a', name: 'Laptop', current: false, report: all }])).toBe('All of it is on Laptop.');
    expect(holdersSentence([{ pubkey: 'a', name: 'Laptop', current: true, report: all }])).toBe('All of it is on this device.');
    expect(holdersSentence([{ pubkey: 'a', name: 'Laptop', current: false, report: report() }])).toBe('No device holds all of it.');
  });

  it('lists folders, the files in no folder and the folders too small to list', () => {
    const lines = folderLines(report({
      folders: [{ path: ['Photos'], bytes: 2000, held: 500 }, { path: ['Photos', '2024'], bytes: 1500, held: 0 }],
      loose: { files: 2, bytes: 600, held: 500 },
    }));
    expect(lines).toEqual([
      { label: 'Photos', depth: 0, bytes: 2000, held: 500 },
      { label: '2024', depth: 1, bytes: 1500, held: 0 },
      { label: '2 files not in a folder', depth: 0, bytes: 600, held: 500 },
      { label: 'Other folders', depth: 0, bytes: 400, held: 0 },
    ]);
  });

  it('tells whether a device has the same versions as this one', () => {
    const [me, laptop, phone] = ['a', 'b', 'c'].map((letter) => letter.repeat(64));
    const held = { [me]: { seq: 5 }, [laptop]: { seq: 3 }, [phone]: { seq: 7 } };
    const devices = [me, laptop, phone];
    expect(syncState(laptop, report({ seen: { [me]: 5, [phone]: 7 } }), held, devices)).toBe('in-sync');
    expect(syncState(laptop, report({ seen: { [me]: 4, [phone]: 7 } }), held, devices)).toBe('behind');
    expect(syncState(laptop, report({ seen: { [me]: 5, [phone]: 8 } }), held, devices)).toBe('ahead');
    expect(syncState(laptop, report({ seen: { [me]: 4, [phone]: 8 } }), held, devices)).toBe('apart');
    expect(syncState(laptop, report(), held, devices)).toBeNull();
  });
});

vi.setConfig({ testTimeout: 30_000 });
