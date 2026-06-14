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
        irisProfileId: '123e4567-e89b-42d3-a456-426614174011',
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
    expect(ranked[1].iris_profile_id).toBe('123e4567-e89b-42d3-a456-426614174011');
  });

  it('drops candidates with malformed representative npubs', () => {
    expect(rankShareContacts('', [{ pubkey: 'also-not-a-key', npub: 'npub1bad' }])).toEqual([]);
  });
});
