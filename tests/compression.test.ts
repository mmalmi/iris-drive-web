import { describe, expect, it, vi } from 'vitest';
import { LinkType, type CID, type HashTree } from '@hashtree/core';
import { createZipFromDirectory, ZipCancelledError } from '../src/utils/compression';

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
});
