import { describe, expect, it } from 'vitest';
import { describeItemAccess, itemAccess } from '../src/drive/itemAccess';
import type { AcceptedShareRecord } from '../src/drive/shareLibrary';

const ME = '11111111-1111-4111-8111-111111111111';
const SHARE = '22222222-2222-4222-8222-222222222222';
const THEIR_SHARE = '33333333-3333-4333-8333-333333333333';

function record(overrides: Partial<AcceptedShareRecord> & { source?: string; owner?: string }): AcceptedShareRecord {
  return {
    share_id: SHARE,
    local_profile_id: ME,
    accepted_at: 1,
    invite_payload: '',
    shortcuts: [],
    folder: {
      owner_profile_id: overrides.owner ?? ME,
      source_path: overrides.source ?? 'Plans',
      display_name: 'Plans',
    } as AcceptedShareRecord['folder'],
    ...overrides,
  };
}

const link = { v: 1, share_id: SHARE, owner_profile_id: ME, admin: 'a', name: 'Plans', role: 'editor', key: 'k' } as const;

describe('who can open an item', () => {
  const mine = { scope: ME, treeName: 'main', profileId: ME };

  it('is private in my own Drive until it is shared', () => {
    expect(itemAccess({ ...mine, path: ['Notes.irisdoc'], records: [] })).toEqual({ kind: 'private' });
    expect(itemAccess({ ...mine, path: ['Other'], records: [record({})] })).toEqual({ kind: 'private' });
    expect(itemAccess({ ...mine, path: ['Plans and more'], records: [record({})] })).toEqual({ kind: 'private' });
  });

  it('covers everything inside a folder I shared', () => {
    const records = [record({ join_links: [link] })];
    expect(itemAccess({ ...mine, path: ['Plans'], records })).toMatchObject({ kind: 'people', invite: true });
    expect(itemAccess({ ...mine, path: ['Plans', 'Budget.irissheet'], records })).toMatchObject({ kind: 'people', invite: true });
    expect(itemAccess({ ...mine, path: ['Plans'], records: [record({})] })).toEqual({ kind: 'people', people: 0 });
  });

  it('does not call a folder with an invite link open to anyone with the link', () => {
    // Joining by invite takes an account and the owner's Drive letting them in.
    const access = itemAccess({ ...mine, path: ['Plans'], records: [record({ join_links: [link] })] })!;
    expect(access.kind).not.toBe('link');
    expect(describeItemAccess(access).label).toBe('Shared');
    expect(describeItemAccess(access).detail).not.toMatch(/anyone/i);
  });

  it('knows a folder someone shared with me', () => {
    const records = [record({ share_id: THEIR_SHARE, owner: 'someone-else', source: 'Team' })];
    expect(itemAccess({ scope: THEIR_SHARE, treeName: 'main', profileId: ME, path: ['a.txt'], records })?.kind).toBe('people');
  });

  it('falls back to how a tree outside the Drive is published', () => {
    const elsewhere = { scope: 'npub1someone', treeName: 'photos', profileId: ME, path: [], records: [] };
    expect(itemAccess({ ...elsewhere, treeVisibility: 'public' })).toEqual({ kind: 'public' });
    expect(itemAccess({ ...elsewhere, treeVisibility: 'link-visible' })?.kind).toBe('link');
    expect(itemAccess({ ...elsewhere })).toBeNull();
    expect(itemAccess({ ...elsewhere, scope: null })).toBeNull();
  });

  it('says it in a few words', () => {
    expect(describeItemAccess({ kind: 'private' }).label).toBe('Private');
    expect(describeItemAccess({ kind: 'people', people: 2 }).label).toBe('Shared with 2');
    expect(describeItemAccess({ kind: 'people', people: 0 }).label).toBe('Shared');
    expect(describeItemAccess({ kind: 'people', people: 1, invite: true }).detail).toBe('Shared with 1 person. People with the invite link can join');
    expect(describeItemAccess({ kind: 'link' }).label).toBe('Anyone with the link');
    expect(describeItemAccess({ kind: 'public' }).label).toBe('Public');
  });
});
