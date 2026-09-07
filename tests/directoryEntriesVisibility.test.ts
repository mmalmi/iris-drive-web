import { describe, expect, it } from 'vitest';
import { LinkType, type TreeEntry } from '@hashtree/core';
import { filterVisibleDirectoryEntries } from '../src/lib/directoryEntryVisibility';

function entry(name: string): TreeEntry {
  return {
    name,
    cid: { hash: new Uint8Array(32) },
    size: 0,
    type: LinkType.Dir,
  };
}

describe('directory entry visibility', () => {
  it('never exposes the reserved hashtree metadata directory', () => {
    expect(filterVisibleDirectoryEntries([
      entry('photos'),
      entry('.hashtree'),
      entry('.HASHTREE'),
    ]).map(({ name }) => name)).toEqual(['photos']);
  });
});
