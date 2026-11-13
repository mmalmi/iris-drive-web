import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { rankShareContacts, representativeNpub } from '../src/drive/shareContacts';

describe('shareContacts', () => {
  it('normalizes representative npubs from pubkeys and npubs', () => {
    const pubkey = getPublicKey(generateSecretKey());
    const npub = nip19.npubEncode(pubkey);

    expect(representativeNpub(pubkey)).toBe(npub);
    expect(representativeNpub(npub)).toBe(npub);
    expect(representativeNpub(`nostr:${npub}`)).toBe(npub);
    expect(representativeNpub('not-a-key')).toBeNull();
    expect(representativeNpub('npub1bad')).toBeNull();
  });

  it('ranks matching contacts with optional social-graph distance', () => {
    const alice = getPublicKey(generateSecretKey());
    const bob = getPublicKey(generateSecretKey());
    const graph = {
      getFollowDistance(pubkey: string) {
        return pubkey === bob ? 1 : 4;
      },
      followedByFriendsCount(pubkey: string) {
        return pubkey === bob ? 8 : 1;
      },
    };

    const ranked = rankShareContacts('a', [
      {
        pubkey: alice,
        displayName: 'Alice',
        nostrIdentityId: '123e4567-e89b-42d3-a456-426614174011',
      },
      {
        pubkey: bob,
        displayName: 'Ada Bob',
        linkedNpubs: [alice, 'not-a-linked-npub'],
        shareRecipientEvidenceJson: '{"profile_id":"123e4567-e89b-42d3-a456-426614174011"}',
      },
    ], graph);

    expect(ranked).toHaveLength(2);
    expect(ranked[0].pubkey).toBe(bob);
    expect(ranked[0].representative_npub).toBe(nip19.npubEncode(bob));
    expect(ranked[0].linked_npubs).toContain(nip19.npubEncode(alice));
    expect(ranked[0].linked_npubs).not.toContain('not-a-linked-npub');
    expect(ranked[0].recipient_evidence_json).toBe('{"profile_id":"123e4567-e89b-42d3-a456-426614174011"}');
    expect(ranked[1].nostr_identity_id).toBe('123e4567-e89b-42d3-a456-426614174011');
  });

  it('puts nearer people first, then better matches, then the order the search found them in', () => {
    const [near, exact, unknownA, unknownB] = [1, 2, 3, 4].map(() => getPublicKey(generateSecretKey()));
    const graph = {
      getFollowDistance: (pubkey: string) => (pubkey === near ? 1 : pubkey === exact ? 2 : 1000),
      followedByFriendsCount: () => 0,
    };
    const ranked = rankShareContacts('bob', [
      { pubkey: unknownB, displayName: 'Bob B', order: 2 },
      { pubkey: exact, displayName: 'Bob' },
      { pubkey: unknownA, displayName: 'Bob A', order: 1 },
      { pubkey: near, displayName: 'Robert Bobson' },
    ], graph);
    expect(ranked.map((contact) => contact.pubkey)).toEqual([near, exact, unknownA, unknownB]);
    expect(ranked[0].follow_distance).toBe(1);
    expect(ranked[2].follow_distance).toBeUndefined();
  });

  it('drops candidates with malformed representative npubs', () => {
    expect(rankShareContacts('', [{ pubkey: 'also-not-a-key', npub: 'npub1bad' }])).toEqual([]);
  });
});
