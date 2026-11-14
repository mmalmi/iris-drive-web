import { describe, expect, it } from 'vitest';
import { LinkType, type TreeEntry } from '@hashtree/core';
import { DEFAULT_SORT, loadSort, saveSort, sortEntries, type ListSort } from '../src/lib/fileListSort';

const cid = { hash: new Uint8Array(32) };
const file = (name: string, size: number, modified?: number): TreeEntry => ({
  name, cid, size, type: LinkType.Blob, meta: modified === undefined ? undefined : { modified_at: modified },
});
const folder = (name: string, modified?: number): TreeEntry => ({
  name, cid, size: 0, type: LinkType.Dir, meta: modified === undefined ? undefined : { modified_at: modified },
});

const DAY = 86_400;
const T = 1_760_000_000;
const entries = [
  file('b.txt', 1, T + 1),
  folder('Zeta', T),
  file('a.txt', 3000, T + 2),
  folder('Plans.irisdoc', T + 9),
  file('old.txt', 50),
  folder('Alpha', T + DAY),
  file('c10.txt', 100, T + 3),
  file('c9.txt', 100, T + 3),
];
const names = (sort: ListSort) => sortEntries(entries, sort).map((entry) => entry.name);

describe('sorting the list of a folder', () => {
  it('puts folders first, and a document among the files, by name as people count', () => {
    expect(names(DEFAULT_SORT)).toEqual(['Alpha', 'Zeta', 'a.txt', 'b.txt', 'c9.txt', 'c10.txt', 'old.txt', 'Plans.irisdoc']);
    expect(names({ by: 'name', descending: true })).toEqual(['Zeta', 'Alpha', 'Plans.irisdoc', 'old.txt', 'c10.txt', 'c9.txt', 'b.txt', 'a.txt']);
  });

  it('sorts by the last change, what has no time last when newest is first', () => {
    expect(names({ by: 'modified', descending: true })).toEqual(['Alpha', 'Zeta', 'Plans.irisdoc', 'c9.txt', 'c10.txt', 'a.txt', 'b.txt', 'old.txt']);
    expect(names({ by: 'modified', descending: false })).toEqual(['Zeta', 'Alpha', 'old.txt', 'b.txt', 'a.txt', 'c9.txt', 'c10.txt', 'Plans.irisdoc']);
  });

  it('sorts files by size, folders by name above them', () => {
    expect(names({ by: 'size', descending: true })).toEqual(['Alpha', 'Zeta', 'a.txt', 'c9.txt', 'c10.txt', 'old.txt', 'b.txt', 'Plans.irisdoc']);
    expect(names({ by: 'size', descending: false })).toEqual(['Alpha', 'Zeta', 'Plans.irisdoc', 'b.txt', 'old.txt', 'c9.txt', 'c10.txt', 'a.txt']);
  });

  it('keeps the choice in the given storage, and falls back to name when it holds nothing usable', () => {
    const kept = new Map<string, string>();
    const storage = {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => { kept.set(key, value); },
    };
    expect(loadSort(storage)).toEqual(DEFAULT_SORT);
    saveSort({ by: 'size', descending: true }, storage);
    expect(loadSort(storage)).toEqual({ by: 'size', descending: true });
    kept.set([...kept.keys()][0]!, '{"by":"colour"}');
    expect(loadSort(storage)).toEqual(DEFAULT_SORT);
    const broken = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(loadSort(broken)).toEqual(DEFAULT_SORT);
    expect(() => saveSort(DEFAULT_SORT, broken)).not.toThrow();
  });
});
