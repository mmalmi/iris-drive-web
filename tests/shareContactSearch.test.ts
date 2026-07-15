import { describe, expect, it } from 'vitest';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  rankedShareContactFromRecipientEvidenceJson,
  rankedShareContactFromRepresentativeInput,
  rankUserShareContacts,
  searchShareContacts,
  shareContactCandidatesFromUsers,
} from '../src/drive/shareContactSearch';
import {
  signNostrIdentityFacetAcceptance,
  signNostrIdentityRosterOp,
  type NostrIdentityFacet,
} from '../src/drive/protocol';
import type { UserIndexEntry } from '../src/stores/searchIndex';

describe('shareContactSearch', () => {
  it('maps user-index entries into share contact candidates', () => {
    const pubkey = getPublicKey(generateSecretKey());
    const npub = nip19.npubEncode(pubkey);

    expect(shareContactCandidatesFromUsers([{
      pubkey,
      npub,
      name: 'alice',
      displayName: 'Alice',
      nip05: 'alice.example',
      nostrIdentityId: '123e4567-e89b-42d3-a456-426614174011',
      linkedNpubs: [nip19.npubEncode(getPublicKey(generateSecretKey()))],
      shareRecipientEvidenceJson: '{"profile_id":"123e4567-e89b-42d3-a456-426614174011"}',
    }])).toEqual([{
      pubkey,
      npub,
      displayName: 'Alice',
      nip05: 'alice.example',
      nostrIdentityId: '123e4567-e89b-42d3-a456-426614174011',
      linkedNpubs: expect.arrayContaining([expect.stringMatching(/^npub1/)]),
      shareRecipientEvidenceJson: '{"profile_id":"123e4567-e89b-42d3-a456-426614174011"}',
    }]);
  });

  it('ranks user-index contacts with async social graph scores', async () => {
    const alice = getPublicKey(generateSecretKey());
    const bob = getPublicKey(generateSecretKey());
    const users: UserIndexEntry[] = [
      userEntry(alice, 'Alice'),
      userEntry(bob, 'Ada Bob'),
    ];

    const ranked = await rankUserShareContacts('a', users, {
      async getFollowDistance(pubkey: string) {
        return pubkey === bob ? 1 : 5;
      },
      async getFollowedByFriends(pubkey: string) {
        return pubkey === bob ? ['friend-a', 'friend-b'] : [];
      },
    });

    expect(ranked.map((contact) => contact.pubkey)).toEqual([bob, alice]);
    expect(ranked[0]!.representative_npub).toBe(nip19.npubEncode(bob));
  });

  it('carries recipient evidence to the ranked contact without interpreting authority', async () => {
    const alice = getPublicKey(generateSecretKey());
    const evidence = '{"profile_id":"123e4567-e89b-42d3-a456-426614174011","roster_ops":[]}';

    const ranked = await rankUserShareContacts('ali', [{
      ...userEntry(alice, 'Alice'),
      nostrIdentityId: '123e4567-e89b-42d3-a456-426614174011',
      shareRecipientEvidenceJson: evidence,
    }], null);

    expect(ranked[0]!.recipient_evidence_json).toBe(evidence);
  });

  it('recognizes pasted signed recipient evidence without user-index lookup', async () => {
    const appSecret = generateSecretKey();
    const appPubkey = getPublicKey(appSecret);
    const profileId = '123e4567-e89b-42d3-a456-426614174051';
    const rosterOp = signNostrIdentityRosterOp({
      signerSecretKey: appSecret,
      profileId,
      createdAt: 10,
      op: {
        op: 'add_facet',
        facet: appFacet(appPubkey, 10, 'Phone'),
      },
    });
    const acceptance = signNostrIdentityFacetAcceptance({
      signerSecretKey: appSecret,
      profileId,
      purposes: ['app_key'],
      rosterOpId: rosterOp.op_id,
      acceptedAt: 20,
    });
    const evidenceJson = JSON.stringify({
      profile_id: profileId,
      representative_npub: nip19.npubEncode(appPubkey),
      display_name: 'Alice',
      roster_ops: [rosterOp],
      acceptances: [acceptance],
    });
    let userSearchCalls = 0;

    const direct = rankedShareContactFromRecipientEvidenceJson(evidenceJson);
    const results = await searchShareContacts(` ${evidenceJson} `, {
      userSearch: async () => {
        userSearchCalls += 1;
        return [];
      },
      graph: null,
    });

    expect(userSearchCalls).toBe(0);
    expect(direct?.recipient_evidence_json).toBe(evidenceJson);
    expect(results).toEqual([{
      representative_npub: nip19.npubEncode(appPubkey),
      pubkey: appPubkey,
      display_name: 'Alice',
      nostr_identity_id: profileId,
      linked_npubs: [nip19.npubEncode(appPubkey)],
      recipient_evidence_json: evidenceJson,
      score: 10,
    }]);
  });

  it('offers pasted representative npubs as pending invite contacts', async () => {
    const alice = getPublicKey(generateSecretKey());
    const aliceNpub = nip19.npubEncode(alice);
    let userSearchCalls = 0;

    const direct = await rankedShareContactFromRepresentativeInput(`nostr:${aliceNpub}`, {
      async getFollowDistance(pubkey: string) {
        return pubkey === alice ? 2 : -1;
      },
      async getFollowedByFriends(pubkey: string) {
        return pubkey === alice ? ['friend-a'] : [];
      },
    });
    const results = await searchShareContacts(` ${aliceNpub} `, {
      userSearch: async () => {
        userSearchCalls += 1;
        return [];
      },
      graph: null,
    });

    expect(userSearchCalls).toBe(1);
    expect(direct?.representative_npub).toBe(aliceNpub);
    expect(direct?.score).toBeGreaterThan(0.8);
    expect(results).toEqual([{
      representative_npub: aliceNpub,
      pubkey: alice,
      display_name: aliceNpub.slice(0, 12),
      linked_npubs: [aliceNpub],
      score: 0.8,
    }]);
  });

  it('keeps indexed recipient evidence when direct npub fallback duplicates it', async () => {
    const alice = getPublicKey(generateSecretKey());
    const aliceNpub = nip19.npubEncode(alice);
    const evidence = '{"profile_id":"123e4567-e89b-42d3-a456-426614174011","roster_ops":[]}';

    const results = await searchShareContacts(aliceNpub, {
      userSearch: async () => [{
        ...userEntry(alice, 'Alice'),
        nostrIdentityId: '123e4567-e89b-42d3-a456-426614174011',
        shareRecipientEvidenceJson: evidence,
      }],
      graph: {
        async getFollowDistance() {
          return 0;
        },
        async getFollowedByFriends() {
          return Array.from({ length: 20 }, (_, index) => `friend-${index}`);
        },
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0]!.display_name).toBe('Alice');
    expect(results[0]!.recipient_evidence_json).toBe(evidence);
    expect(results[0]!.nostr_identity_id).toBe('123e4567-e89b-42d3-a456-426614174011');
  });

  it('searches users before ranking and skips blank queries', async () => {
    const alice = getPublicKey(generateSecretKey());
    let calls = 0;

    expect(await searchShareContacts('  ', {
      userSearch: async () => {
        calls += 1;
        return [userEntry(alice, 'Alice')];
      },
    })).toEqual([]);
    expect(calls).toBe(0);

    const results = await searchShareContacts('ali', {
      limit: 1,
      userSearch: async (query, limit) => {
        calls += 1;
        expect(query).toBe('ali');
        expect(limit).toBeGreaterThan(1);
        return [userEntry(alice, 'Alice')];
      },
      graph: null,
    });

    expect(calls).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]!.display_name).toBe('Alice');
  });
});

function userEntry(pubkey: string, displayName: string): UserIndexEntry {
  return {
    pubkey,
    npub: nip19.npubEncode(pubkey),
    displayName,
  };
}

function appFacet(pubkey: string, addedAt: number, _label: string): NostrIdentityFacet {
  return {
    pubkey,
    purposes: ['app_key'],
    capabilities: {
      can_admin_profile: true,
      can_receive_secret_wraps: true,
      can_decrypt_secret_epochs: true,
    },
    added_at: addedAt,
  };
}
