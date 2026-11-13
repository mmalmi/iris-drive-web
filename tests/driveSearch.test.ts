import { describe, expect, it, vi } from 'vitest';
import { HashTree, LinkType, MemoryStore, type CID } from '@hashtree/core';

const shared = vi.hoisted(() => ({ tree: null as HashTree | null }));
vi.mock('../src/store', () => ({ getTree: () => shared.tree }));

const { driveSearchDone, onDriveSearchProgress, searchDrive, startDriveSearch } = await import('../src/lib/driveSearch');

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
});
