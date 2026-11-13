import { describe, expect, it } from 'vitest';
import { requeueUnpublishedRoots, type UnpublishedRootRegistry } from '../src/lib/unpublishedRoots';

function registryWith(records: Record<string, { source: string; dirty: boolean }>) {
  const queued: Array<{ scope: string; treeName: string; hash: Uint8Array; key?: Uint8Array; visibility?: string }> = [];
  const registry: UnpublishedRootRegistry = {
    getAllRecords: () => new Map(Object.entries(records).map(([key, record], index) => [key, {
      ...record,
      hash: new Uint8Array([index]),
      key: new Uint8Array([100 + index]),
      visibility: 'private' as const,
    }])),
    setLocal: (scope, treeName, hash, options) => {
      queued.push({ scope, treeName, hash, key: options?.key, visibility: options?.visibility });
    },
  };
  return { registry, queued };
}

describe('versions left unpublished by an earlier page', () => {
  it('are queued again, and only those', () => {
    const { registry, queued } = registryWith({
      'drive-a/main': { source: 'local-write', dirty: true },
      'drive-b/main': { source: 'local-write', dirty: false },
      'drive-c/main': { source: 'nostr', dirty: false },
      'npub1x/photos/2026': { source: 'local-write', dirty: true },
    });
    expect(requeueUnpublishedRoots(registry)).toBe(2);
    expect(queued.map(item => `${item.scope} | ${item.treeName}`)).toEqual(['drive-a | main', 'npub1x | photos/2026']);
    // The version goes out unchanged, with the key that reads it.
    expect(queued[0].hash).toEqual(new Uint8Array([0]));
    expect(queued[0].key).toEqual(new Uint8Array([100]));
    expect(queued[0].visibility).toBe('private');
  });

  it('does nothing when everything was published', () => {
    const { registry, queued } = registryWith({ 'drive-a/main': { source: 'nostr', dirty: false } });
    expect(requeueUnpublishedRoots(registry)).toBe(0);
    expect(queued).toEqual([]);
  });
});
