import { describe, expect, it, vi } from 'vitest';
import { HashTree, MemoryStore, sha256, toHex, type CID } from '@hashtree/core';
import {
  backUp,
  checkBackup,
  listParts,
  serverPlace,
  spreadSample,
  type BackupPlace,
  type DriveParts,
} from '../src/workers/driveBackup';
import { ConfirmedUploads } from '../src/workers/uploadOnce';

const BIG = 2 * 1024 * 1024 + 1000;

async function drive(): Promise<{ root: CID; store: MemoryStore; parts: DriveParts }> {
  const store = new MemoryStore();
  const tree = new HashTree({ store });
  const small = await tree.putFile(new TextEncoder().encode('hello'));
  const large = await tree.putFile(new Uint8Array(BIG).map((_, index) => index % 251));
  const inner = await tree.putDirectory([{ name: 'large.bin', cid: large.cid, size: large.size, type: 0 }]);
  // Files are entered as content whatever their size, as Drive does.
  const { cid: root } = await tree.putDirectory([
    { name: 'hello.txt', cid: small.cid, size: small.size, type: 0 },
    { name: 'inner', cid: inner.cid, size: 0, type: 2 },
  ]);
  const parts: DriveParts = {
    node: (cid) => tree.getTreeNode(cid),
    bytes: (hash) => store.get(hash),
  };
  return { root, store, parts };
}

function memoryPlace(): BackupPlace & { held: Map<string, Uint8Array>; puts: string[] } {
  const held = new Map<string, Uint8Array>();
  const puts: string[] = [];
  return {
    held,
    puts,
    async has(hash) { return held.has(hash); },
    async put(hash, bytes) { puts.push(hash); held.set(hash, bytes); },
    async read(hash) { return held.get(hash) ?? null; },
  };
}

describe('backing up a Drive', () => {
  it('finds every part, including the pieces of a large file entered as content', async () => {
    const { root, store, parts } = await drive();
    const listed = await listParts(root, parts);
    expect(listed.map((part) => part.hex).sort()).toEqual((await store.keys()).map(toHex).sort());
    expect(listed.length).toBeGreaterThanOrEqual(6);
  });

  it('sends only the parts the place lacks, and nothing the second time', async () => {
    const { root, parts, store } = await drive();
    const place = memoryPlace();
    const [first] = await store.keys();
    place.held.set(toHex(first), (await store.get(first))!);
    const progress = vi.fn();

    const report = await backUp(root, parts, place, { onProgress: progress });

    expect(report.total).toBe(store.size);
    expect(report.present).toBe(1);
    expect(report.sent).toBe(store.size - 1);
    expect(report.bytesSent).toBeGreaterThan(BIG);
    expect(place.puts).not.toContain(toHex(first));
    expect(progress).toHaveBeenLastCalledWith(store.size, store.size);

    const again = await backUp(root, parts, place);
    expect(again).toMatchObject({ sent: 0, present: store.size, bytesSent: 0 });
  });

  it('fails plainly when a part of the Drive cannot be found', async () => {
    const { root, parts } = await drive();
    const place = memoryPlace();
    const missing: DriveParts = { ...parts, bytes: async () => null };
    await expect(backUp(root, missing, place)).rejects.toThrow('Some parts of your Drive could not be found');
  });

  it('stops when asked', async () => {
    const { root, parts } = await drive();
    const controller = new AbortController();
    controller.abort();
    await expect(backUp(root, parts, memoryPlace(), { signal: controller.signal })).rejects.toThrow();
  });
});

describe('checking a backup', () => {
  it('reads a sample back and compares each part with its hash', async () => {
    const { root, parts } = await drive();
    const place = memoryPlace();
    await backUp(root, parts, place);
    expect(await checkBackup(root, parts, place, { sampleSize: 3 })).toMatchObject({ sampled: 3, verified: 3, missing: 0, unknown: 0 });

    // Wrong bytes count as missing, and so does a part that is gone.
    const [one, two] = [...place.held.keys()].sort();
    place.held.set(one, new Uint8Array([1, 2, 3]));
    place.held.delete(two);
    const forget = vi.fn();
    const report = await checkBackup(root, parts, { ...place, forget }, { sampleSize: 100 });
    expect(report).toMatchObject({ verified: report.sampled - 2, missing: 2, unknown: 0 });
    expect(forget.mock.calls.map(([hash]) => hash).sort()).toEqual([one, two]);
  });

  it('counts a place it cannot read as unknown, not missing', async () => {
    const { root, parts } = await drive();
    const place = { ...memoryPlace(), read: async () => { throw new Error('offline'); } };
    expect(await checkBackup(root, parts, place, { sampleSize: 4 })).toMatchObject({ sampled: 4, verified: 0, unknown: 4 });
  });

  it('spreads its sample over all the parts', () => {
    const items = Array.from({ length: 20 }, (_, index) => index);
    expect(spreadSample(items, 4)).toEqual([0, 5, 10, 15]);
    expect(spreadSample(items, 4, 2)).toEqual([2, 7, 12, 17]);
    expect(spreadSample(items.slice(0, 3), 8)).toEqual([0, 1, 2]);
    expect(spreadSample([], 8)).toEqual([]);
  });
});

describe('a file server as a backup place', () => {
  const SERVER = 'https://files.example';
  const HASH = 'c'.repeat(64);

  it('asks before sending, and remembers what the server confirmed', async () => {
    const send = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => (
      new Response(null, { status: init?.method === 'HEAD' ? 200 : 500 })
    ));
    const memory = new ConfirmedUploads();
    const place = serverPlace(SERVER, send as unknown as typeof fetch, async () => ({}), memory);

    expect(await place.has(HASH)).toBe(true);
    expect(await place.has(HASH)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(`${SERVER}/${HASH}.bin`);

    // Asked about every part again when told to trust nothing remembered.
    const fresh = serverPlace(SERVER, send as unknown as typeof fetch, async () => ({}), memory, true);
    await fresh.has(HASH);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends a signed upload, and tells plainly when the server refuses', async () => {
    const sign = vi.fn(async (event: { tags: string[][] }) => ({ ...event, sig: 'signed' }));
    const answers = [new Response('{}', { status: 201 }), new Response('no', { status: 403 })];
    const send = vi.fn(async () => answers.shift()!);
    const place = serverPlace(SERVER, send as unknown as typeof fetch, sign, null);
    const bytes = new Uint8Array([1, 2, 3]);

    await place.put(HASH, bytes);
    const [url, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SERVER}/upload`);
    expect(new Headers(init.headers).get('x-sha-256')).toBe(HASH);
    expect(new Headers(init.headers).get('authorization')).toMatch(/^Nostr /);
    expect(sign.mock.calls[0][0].tags).toContainEqual(['x', HASH]);

    await expect(place.put(HASH, bytes)).rejects.toThrow('the server did not accept the backup');
  });

  it('reads a part back, and says when it cannot reach the server', async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const hash = toHex(await sha256(bytes));
    const answers: Array<() => Promise<Response>> = [
      async () => new Response(bytes),
      async () => new Response(null, { status: 404 }),
      async () => { throw new TypeError('Failed to fetch'); },
    ];
    const send = vi.fn(async () => answers.shift()!());
    const place = serverPlace(SERVER, send as unknown as typeof fetch, async () => ({}), null);

    expect(await place.read(hash)).toEqual(bytes);
    expect(await place.read(hash)).toBeNull();
    await expect(place.read(hash)).rejects.toThrow('could not reach the server');
  });
});
