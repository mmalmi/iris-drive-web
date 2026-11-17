import { describe, expect, it, vi } from 'vitest';
import { HashTree, LinkType, MemoryStore, type CID } from '@hashtree/core';

const shared = vi.hoisted(() => ({ tree: null as HashTree | null }));
vi.mock('../src/store', () => ({ getTree: () => shared.tree }));

const { driveSearchDone, hasMoreFolders, onDriveSearchProgress, searchDrive, startDriveSearch } = await import('../src/lib/driveSearch');

async function file(tree: HashTree, text: string) {
  const { cid, size } = await tree.putFile(new TextEncoder().encode(text));
  return { cid, size, type: LinkType.File };
}

async function dir(tree: HashTree, entries: Array<{ name: string; cid: CID; size: number; type: LinkType }>) {
  const { cid, size } = await tree.putDirectory(entries);
  return { cid, size, type: LinkType.Dir };
}

async function finished(roots: Parameters<typeof driveSearchDone>[0]) {
  if (driveSearchDone(roots)) return;
  await new Promise<void>((resolve) => {
    const stop = onDriveSearchProgress(() => {
      if (!driveSearchDone(roots)) return;
      stop();
      resolve();
    });
  });
}

describe('searching this Drive', () => {
  it('finds files, folders and documents by name, deep down and in shared folders', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    const report = await file(tree, 'q3');
    const doc = await dir(tree, [{ name: 'body.yjs', ...(await file(tree, 'x')) }]);
    const deep = await dir(tree, [{ name: 'Quarterly report.pdf', ...report }]);
    const work = await dir(tree, [
      { name: 'Archive', ...deep },
      { name: 'Budget plan.irissheet', ...doc },
    ]);
    const shareSource = await dir(tree, [{ name: 'old copy.txt', ...(await file(tree, 'stale')) }]);
    const mine = await dir(tree, [{ name: 'Work', ...work }, { name: 'Trip', ...shareSource }]);
    const trip = await dir(tree, [{ name: 'Tickets.txt', ...(await file(tree, 't')) }]);

    const roots = [
      { scope: 'me', label: 'My Drive', cid: mine.cid, skip: ['Trip'] },
      { scope: 'share-1', label: 'Trip', cid: trip.cid, shared: true },
    ];
    startDriveSearch(roots);
    await finished(roots);

    expect(searchDrive(roots, 'quarter')).toEqual([expect.objectContaining({
      name: 'Quarterly report.pdf',
      where: 'My Drive / Work / Archive',
      href: '#/me/main/Work/Archive/Quarterly%20report.pdf',
    })]);
    expect(searchDrive(roots, 'budget')).toEqual([expect.objectContaining({
      name: 'Budget plan',
      href: '#/me/main/Work/Budget%20plan.irissheet',
    })]);
    // Nothing inside a document, and nothing of a folder that is now shared.
    expect(searchDrive(roots, 'body')).toEqual([]);
    expect(searchDrive(roots, 'old copy')).toEqual([]);
    expect(searchDrive(roots, 'trip').map((item) => item.href)).toEqual(['#/share-1/main']);
    expect(searchDrive(roots, 'tickets')[0]?.where).toBe('Trip');
    expect(searchDrive(roots, 'work')[0]).toMatchObject({ name: 'Work', folder: true });
  });

  it('combines folder and type filters throughout a subtree, including nested shares', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    const pdf = await file(tree, 'PDF');
    const deep = await dir(tree, Array.from({ length: 15 }, (_, i) => ({ name: `Notes ${i}.PDF`, ...pdf })));
    const work = await dir(tree, [{ name: 'Records', ...deep }, { name: 'Notes.txt', ...pdf }]);
    const root = await dir(tree, [{ name: 'Work', ...work }, { name: 'Workshop', ...deep }]);
    const roots = [
      { scope: 'me', label: 'My Drive', cid: root.cid },
      { scope: 'owned-share', label: 'Shared notes', cid: deep.cid, shared: true },
      { scope: 'received-share', label: 'Invited notes', cid: deep.cid, shared: true },
    ];
    startDriveSearch(roots);
    await finished(roots);
    const folder = { scope: 'me', path: ['Work'], nestedShares: ['owned-share'] };
    const all = searchDrive(roots, 'notes', Infinity, { folder, type: 'pdf' });
    expect(all).toHaveLength(30);
    expect(all.every(item => item.where === 'My Drive / Work / Records' || item.where === 'Shared notes')).toBe(true);
    expect(searchDrive(roots, '', 12, { folder, type: 'pdf' })).toHaveLength(12);
    expect(searchDrive(roots, '', 12, { folder, type: 'document' }).map(item => item.name)).toEqual(['Notes.txt']);
    expect(searchDrive(roots, '', 12, { folder, type: 'folder' }).map(item => item.name).sort()).toEqual(['Records', 'Shared notes']);
    expect(searchDrive(roots, '', Infinity, { folder: { scope: 'received-share', path: [], nestedShares: [] } })).toHaveLength(15);
  });

  it('continues a large Drive from the quick scan limit when all results are requested', async () => {
    const tree = new HashTree({ store: new MemoryStore() });
    shared.tree = tree;
    const folder = await dir(tree, [{ name: 'needle.txt', ...(await file(tree, 'x')) }]);
    const root = await dir(tree, Array.from({ length: 2001 }, (_, i) => ({ name: `folder-${i}`, ...folder })));
    const roots = [{ scope: 'large', label: 'My Drive', cid: root.cid }];
    startDriveSearch(roots);
    await finished(roots);
    expect(hasMoreFolders(roots, false)).toBe(true);
    expect(searchDrive(roots, 'needle', Infinity)).toHaveLength(1999);
    hasMoreFolders(roots, true);
    await finished(roots);
    expect(hasMoreFolders(roots, false)).toBe(false);
    expect(searchDrive(roots, 'needle', Infinity)).toHaveLength(2001);
  });
});
