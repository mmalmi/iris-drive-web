import { describe, expect, it } from 'vitest';
import { nip19 } from 'nostr-tools';
import { memberNpub, personHref, personOverview, sharedItemHref } from '../src/drive/people';
import type { AcceptedShareRecord } from '../src/drive/shareLibrary';
import type { SharedFolder } from '../src/drive/protocol';

const ME = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const BOB_DEVICE = 'b'.repeat(64);
const BOB_NPUB = nip19.npubEncode(BOB_DEVICE);
const MY_DEVICE = 'a'.repeat(64);

function record(shareId: string, owner: string, name: string, bobHint?: string, sourcePath = ''): AcceptedShareRecord {
  const folder = {
    share_id: shareId,
    owner_profile_id: owner,
    source_path: sourcePath,
    display_name: name,
    local_role: 'editor',
    pending_invites: {},
    app_key_roots: {},
    access: {
      schema: 1,
      resource_id: shareId,
      updated_at: 10,
      grants: [
        { target: { type: 'id', id: ME }, role: owner === ME ? 'admin' : 'editor', status: 'active', display_name: 'Me' },
        { target: { type: 'id', id: BOB }, role: owner === BOB ? 'admin' : 'editor', status: 'active', display_name: 'Bob', ...(bobHint ? { representative_npub_hint: bobHint } : {}) },
      ],
      devices: {
        [MY_DEVICE]: { pubkey: MY_DEVICE, profile_id: ME, added_at: 1 },
        [BOB_DEVICE]: { pubkey: BOB_DEVICE, profile_id: BOB, added_at: 2 },
      },
    },
  } as unknown as SharedFolder;
  return { share_id: shareId, local_profile_id: ME, accepted_at: 1, invite_payload: '', folder, shortcuts: [] };
}

describe('people from shared folders', () => {
  it('names a member by the npub they gave, else by their first device', () => {
    const withHint = record('s1', ME, 'Plans', BOB_NPUB);
    expect(memberNpub(withHint.folder, BOB)).toBe(BOB_NPUB);
    expect(memberNpub(record('s2', ME, 'Plans').folder, BOB)).toBe(BOB_NPUB);
    expect(personHref(withHint.folder, BOB)).toBe(`#/${BOB_NPUB}/profile`);
  });

  it('lists what a person shares with you and what you share with them', () => {
    const records = [
      record('33333333-3333-4333-8333-333333333333', BOB, 'From Bob'),
      record('44444444-4444-4444-8444-444444444444', ME, 'To Bob'),
    ];
    for (const id of [BOB_NPUB, BOB]) {
      const person = personOverview(id, records, ME);
      expect(person.name).toBe('Bob');
      expect(person.npub).toBe(BOB_NPUB);
      expect(person.sharedWithYou.map((item) => item.folder.display_name)).toEqual(['From Bob']);
      expect(person.youShare.map((item) => item.folder.display_name)).toEqual(['To Bob']);
    }
  });

  it('knows nothing about a stranger and opens shared documents at the document', () => {
    const stranger = nip19.npubEncode('c'.repeat(64));
    const person = personOverview(stranger, [record('s1', BOB, 'From Bob')], ME);
    expect(person).toMatchObject({ npub: stranger, name: '', sharedWithYou: [], youShare: [] });
    expect(sharedItemHref('s1', 'Work/Notes.doc')).toBe('#/s1/main');
    expect(sharedItemHref('s1', 'Work/Plan.irisdoc')).toBe('#/s1/main/Plan.irisdoc');
  });
});
