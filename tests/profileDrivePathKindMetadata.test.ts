import { describe, expect, it } from 'vitest';
import { HashTree, MemoryStore, toHex } from '@hashtree/core';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  decodePathKindReplacements,
  encodePathKindReplacements,
  readPathKindReplacements,
  replacePathKindReplacements,
} from '../src/drive/profileDrivePathKindMetadata';
import { prepareProfileDriveRootForPublish } from '../src/drive/profileDriveMutation';

describe('profile Drive path-kind replacement metadata', () => {
  it('does not treat an unreadable retained metadata directory as absent', async () => {
    const store = new MemoryStore();
    const tree = new HashTree({ store });
    const empty = (await tree.putDirectory([])).cid;
    const previous = await replacePathKindReplacements(tree, empty, new Map([['draft', 1]]));
    const metadata = await tree.resolvePath(previous, ['.hashtree']);
    expect(metadata).not.toBeNull();
    await store.delete(metadata!.cid.hash);
    await store.put(metadata!.cid.hash, new Uint8Array([1, 2, 3]));
    const reader = new HashTree({ store });

    await expect(readPathKindReplacements(reader, previous)).rejects.toThrow();
    await expect(prepareProfileDriveRootForPublish(reader, empty, previous)).rejects.toThrow();
  });

  it('encodes the cross-platform compact JSON contract in UTF-8 byte order', () => {
    const encoded = encodePathKindReplacements(new Map([
      ['zeta', 9],
      ['unicode/𐀀', 11],
      ['unicode/\uE000', 10],
      ['alpha/nested', 7],
    ]));

    expect(new TextDecoder().decode(encoded)).toBe(
      '{"schema":1,"replacements":[{"path":"alpha/nested","generation":7},{"path":"unicode/","generation":10},{"path":"unicode/𐀀","generation":11},{"path":"zeta","generation":9}]}',
    );
    expect(encoded.byteLength).toBe(178);
    expect(toHex(sha256(encoded))).toBe('5f80c45327be1010600cae05247e52f46f44c60e1183b1e5952c7bd015c209d7');
    expect([...decodePathKindReplacements(encoded)]).toEqual([
      ['alpha/nested', 7],
      ['unicode/', 10],
      ['unicode/𐀀', 11],
      ['zeta', 9],
    ]);
  });

  it.each([
    '{"schema":1,"replacements":[{"path":"a","generation":0}]}',
    '{"schema":1,"replacements":[{"path":"a","generation":9007199254740992}]}',
    '{"schema":1,"replacements":[{"path":".hashtree/x","generation":1}]}',
    '{"schema":1,"replacements":[{"path":"a//b","generation":1}]}',
    '{"schema":1,"replacements":[{"path":"b","generation":1},{"path":"a","generation":2}]}',
    '{"schema":1,"replacements":[{"path":"a","generation":1},{"path":"a","generation":2}]}',
    '{"schema":1,"replacements":[],"extra":true}',
  ])('rejects invalid role metadata: %s', (raw) => {
    expect(() => decodePathKindReplacements(new TextEncoder().encode(raw))).toThrow();
  });
});
