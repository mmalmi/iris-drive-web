import { describe, expect, it, vi } from 'vitest';
import { HashTree, LinkType, MemoryStore } from '@hashtree/core';
import { fileRevision, OWNER_META } from '../src/drive/fileReturnProtocol';

vi.mock('../src/drive/profileRoute', () => ({ isEditableDriveRouteScope: () => true }));
vi.mock('../src/drive/shareScope', () => ({ activeShareScope: () => ({
  canWrite: true,
  record: { share_id: '22222222-2222-4222-8222-222222222222', local_profile_id: '33333333-3333-4333-8333-333333333333' },
}) }));
vi.mock('../src/nostr/auth', () => ({ getSecretKey: () => new Uint8Array(32).fill(1) }));

import { setEntriesForDriveRoute } from '../src/drive/profileDriveRouteEntry';

const route = { npub: '22222222-2222-4222-8222-222222222222', treeName: 'main' };
const state = { isLoggedIn: true, pubkey: 'a'.repeat(64) };

describe('shared batch write ownership', () => {
  it('rejects nested uploads whose parent is an existing shared file', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const original = await tree.putFile(new Uint8Array([1]));
    const child = await tree.putFile(new Uint8Array([2]));
    const root = (await tree.putDirectory([{ name: 'Team', ...original, type: LinkType.Blob }])).cid;
    await expect(setEntriesForDriveRoute(tree, root, [
      { parentPath: ['Team', 'nested'], name: 'file.txt', entry: { ...child, type: LinkType.Blob } },
    ], route, state)).rejects.toThrow('shared file');
    expect((await tree.resolvePath(root, ['Team']))?.cid).toEqual(original.cid);
  });

  it('retains the original ownership claim when a batch overwrites its own new file', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    const original = await tree.putFile(new Uint8Array([1]));
    const revised = await tree.putFile(new Uint8Array([2]));
    const root = (await tree.putDirectory([])).cid;
    const next = await setEntriesForDriveRoute(tree, root, [
      { parentPath: [], name: 'file.txt', entry: { ...original, type: LinkType.Blob } },
      { parentPath: [], name: 'file.txt', entry: { ...revised, type: LinkType.Blob } },
    ], route, state);
    const entry = (await tree.listDirectory(next)).find(entry => entry.name === 'file.txt')!;
    const claim = JSON.parse(entry.meta![OWNER_META] as string);
    expect(JSON.parse(claim.content).origin).toBe(fileRevision(original.cid));
    expect(entry.cid).toEqual(revised.cid);
  });
});
