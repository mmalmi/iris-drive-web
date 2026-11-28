import { appendFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { HashTree, LinkType, MemoryStore, type Store } from '@hashtree/core';
import { createZipFromDirectory, extractZip } from '../src/utils/compression';
import { setEntriesForDriveRoute, type DriveEntryWrite } from '../src/drive/profileDriveRouteEntry';

const session = vi.hoisted(() => ({ shared: false }));
vi.mock('../src/drive/profileRoute', () => ({ isEditableDriveRouteScope: () => true }));
vi.mock('../src/drive/shareScope', () => ({ activeShareScope: () => session.shared ? {
  canWrite: true,
  record: { share_id: '22222222-2222-4222-8222-222222222222', local_profile_id: '33333333-3333-4333-8333-333333333333' },
} : null }));
vi.mock('../src/nostr/auth', () => ({ getSecretKey: () => new Uint8Array(32).fill(1) }));

class MeteredStore implements Store {
  readonly inner = new MemoryStore();
  reads = 0;
  writes = 0;
  bytesRead = 0;
  bytesWritten = 0;
  async get(hash: Uint8Array) {
    this.reads++;
    const bytes = await this.inner.get(hash);
    this.bytesRead += bytes?.byteLength ?? 0;
    return bytes;
  }
  put(hash: Uint8Array, bytes: Uint8Array) {
    this.writes++;
    this.bytesWritten += bytes.byteLength;
    return this.inner.put(hash, bytes);
  }
  has(hash: Uint8Array) { return this.inner.has(hash); }
  delete(hash: Uint8Array) { return this.inner.delete(hash); }
  reset() { this.reads = this.writes = this.bytesRead = this.bytesWritten = 0; }
}

const route = { npub: '22222222-2222-4222-8222-222222222222', treeName: 'main' };
const state = { isLoggedIn: true, pubkey: 'a'.repeat(64) };
async function measure(name: string, store: MeteredStore, work: () => Promise<void>) {
  store.reset();
  const cpu = process.cpuUsage();
  const start = performance.now();
  await work();
  const cpuUsed = process.cpuUsage(cpu);
  appendFileSync(process.env.DRIVE_FLOW_METRICS!, JSON.stringify({
    name, wallMs: performance.now() - start, cpuMs: (cpuUsed.user + cpuUsed.system) / 1000,
    maxRSSKiB: process.resourceUsage().maxRSS,
    reads: store.reads, writes: store.writes, bytesRead: store.bytesRead, bytesWritten: store.bytesWritten,
    networkBytes: 0,
  }) + '\n');
}

// Opt-in matched measurements; ordinary unit runs already cover the behavior.
describe.skipIf(!process.env.DRIVE_FLOW_METRICS)('affected batch flow measurements', () => {
  it.each([false, true])('retains all nested files in a shared=%s batch', async (shared) => {
    session.shared = shared;
    const store = new MeteredStore();
    const tree = new HashTree({ store });
    const file = await tree.putFile(new Uint8Array(4096).fill(42));
    const root = (await tree.putDirectory([])).cid;
    const items: DriveEntryWrite[] = Array.from({ length: 256 }, (_, index) => ({
      parentPath: ['Albums', `folder-${index % 16}`, 'photos'], name: `photo-${index}.jpg`,
      entry: { ...file, type: LinkType.Blob },
    }));
    await measure(shared ? 'shared-256-nested-writes' : 'private-256-nested-writes', store, async () => {
      const next = await setEntriesForDriveRoute(tree, root, items, route, state);
      for (const item of items) {
        const entry = await tree.resolvePath(next, [...item.parentPath, item.name]);
        expect(entry?.cid).toEqual(file.cid);
        expect(entry?.cid.key).toBeDefined();
      }
    });
  });

  it('round-trips a 32 MiB private media file through a folder ZIP', async () => {
    session.shared = false;
    const store = new MeteredStore();
    const tree = new HashTree({ store });
    const data = new Uint8Array(32 * 1024 * 1024);
    let seed = 0x12345678;
    for (let offset = 0; offset < data.length; offset++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      data[offset] = seed & 255;
    }
    await measure('private-32MiB-store-zip-download', store, async () => {
      const file = await tree.putFile(data);
      expect(file.cid.key).toBeDefined();
      const root = await setEntriesForDriveRoute(tree, (await tree.putDirectory([])).cid, [
        { parentPath: [], name: 'video.mp4', entry: { ...file, type: LinkType.Blob } },
      ], route, state);
      const zip = await createZipFromDirectory(tree, root, 'Media');
      const decoded = extractZip(zip);
      expect(Buffer.from(decoded['video.mp4']!).equals(Buffer.from(data))).toBe(true);
    });
  }, 60000);
});
