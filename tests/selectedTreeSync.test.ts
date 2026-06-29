import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nip19 } from 'nostr-tools';
import type { HashTreeEvent } from '../src/nostr/store';
import { buildSelectedTreeForOwnRoute } from '../src/lib/selectedTree';

const pubkey = 'a'.repeat(64);
const npub = nip19.npubEncode(pubkey);
const profileId = '123e4567-e89b-42d3-a456-426614174170';
const mocks = vi.hoisted(() => ({
  activeNostrIdentityRootScope: vi.fn(() => null as string | null),
}));

vi.mock('../src/drive/profileRoute', () => ({
  activeNostrIdentityRootScope: (...args: unknown[]) => mocks.activeNostrIdentityRootScope(...args),
}));

function createState(selectedTree: HashTreeEvent | null = null) {
  return {
    isLoggedIn: true,
    pubkey,
    selectedTree,
  };
}

describe('buildSelectedTreeForOwnRoute', () => {
  beforeEach(() => {
    mocks.activeNostrIdentityRootScope.mockReturnValue(null);
  });

  it('uses resolved link-visible metadata instead of defaulting own trees to public', () => {
    const next = buildSelectedTreeForOwnRoute(createState(), {
      npub,
      treeName: 'boards/roadmap',
      visibility: 'link-visible',
      labels: ['boards'],
      nowMs: 1_700_000_000_000,
    });

    expect(next).not.toBeNull();
    expect(next?.pubkey).toBe(pubkey);
    expect(next?.name).toBe('boards/roadmap');
    expect(next?.visibility).toBe('link-visible');
    expect(next?.labels).toEqual(['boards']);
    expect(next?.rootHash).toBe('');
    expect(next?.created_at).toBe(1_700_000_000);
  });

  it('does not carry a previous tree root into a different tree selection', () => {
    const previous: HashTreeEvent = {
      id: 'prev',
      pubkey,
      name: 'boards/old',
      rootHash: 'ff'.repeat(32),
      rootKey: 'aa'.repeat(32),
      visibility: 'public',
      created_at: 123,
    };

    const next = buildSelectedTreeForOwnRoute(createState(previous), {
      npub,
      treeName: 'boards/new',
      visibility: 'link-visible',
      nowMs: 1_700_000_000_000,
    });

    expect(next).not.toBeNull();
    expect(next?.name).toBe('boards/new');
    expect(next?.rootHash).toBe('');
    expect(next?.rootKey).toBeUndefined();
    expect(next?.visibility).toBe('link-visible');
  });

  it('preserves the current tree root while updating metadata for the same tree', () => {
    const previous: HashTreeEvent = {
      id: 'prev',
      pubkey,
      name: 'boards/roadmap',
      rootHash: '11'.repeat(32),
      rootKey: '22'.repeat(32),
      visibility: 'public',
      created_at: 123,
      labels: ['old'],
    };

    const next = buildSelectedTreeForOwnRoute(createState(previous), {
      npub,
      treeName: 'boards/roadmap',
      visibility: 'link-visible',
      labels: ['boards'],
      nowMs: 1_700_000_000_000,
    });

    expect(next).not.toBeNull();
    expect(next?.rootHash).toBe(previous.rootHash);
    expect(next?.rootKey).toBe(previous.rootKey);
    expect(next?.visibility).toBe('link-visible');
    expect(next?.labels).toEqual(['boards']);
  });

  it('treats the active Iris profile UUID as an own route scope', () => {
    mocks.activeNostrIdentityRootScope.mockReturnValue(profileId);

    const next = buildSelectedTreeForOwnRoute(createState(), {
      npub: profileId,
      treeName: 'main',
      visibility: 'private',
      nowMs: 1_700_000_000_000,
    });

    expect(next).not.toBeNull();
    expect(next?.pubkey).toBe(pubkey);
    expect(next?.name).toBe('main');
    expect(next?.visibility).toBe('private');
  });
});
