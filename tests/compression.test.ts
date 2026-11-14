import { describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { HashTree as Tree, LinkType, MemoryStore, type CID, type HashTree } from '@hashtree/core';
import { createZipFromDirectory, createZipFromEntries, ZipCancelledError } from '../src/utils/compression';

const rootCid = { hash: new Uint8Array([1]) } as CID;
const fileCid = { hash: new Uint8Array([2]) } as CID;

describe('compression helpers', () => {
  it('cancels ZIP creation before reading file bytes', async () => {
    const controller = new AbortController();
    const readFile = vi.fn(async () => new TextEncoder().encode('too late'));
    const tree = {
      listDirectory: vi.fn(async () => [
        { name: 'example.txt', cid: fileCid, type: LinkType.File, size: 8 },
      ]),
      readFile,
    } as unknown as HashTree;

    await expect(createZipFromDirectory(tree, rootCid, 'folder', () => {
      controller.abort();
    }, controller.signal)).rejects.toBeInstanceOf(ZipCancelledError);

    expect(readFile).not.toHaveBeenCalled();
  });

  it('puts several chosen items in one ZIP, each folder with what is in it', async () => {
    const tree = new Tree({ store: new MemoryStore() });
    const text = (value: string) => tree.putFile(new TextEncoder().encode(value));
    const a = await text('alpha');
    const inner = await text('inner');
    const folder = await tree.putDirectory([{ name: 'inner.txt', cid: inner.cid, size: inner.size, type: LinkType.Blob }]);
    const empty = await tree.putDirectory([]);

    const zipped = unzipSync(await createZipFromEntries(tree, [
      { name: 'a.txt', cid: a.cid, size: a.size, type: LinkType.Blob },
      { name: 'Trip', cid: folder.cid, size: 0, type: LinkType.Dir },
      { name: 'Empty', cid: empty.cid, size: 0, type: LinkType.Dir },
    ]));

    expect(Object.keys(zipped).sort()).toEqual(['Empty/', 'Trip/inner.txt', 'a.txt']);
    expect(new TextDecoder().decode(zipped['Trip/inner.txt'])).toBe('inner');
  });
});
