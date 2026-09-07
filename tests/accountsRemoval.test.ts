// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { accountsStore } from '../src/accounts';

function storedSession(profileId: string, secretKey: Uint8Array): Record<string, unknown> {
  return {
    schema: 1,
    profileId,
    appKeyNsec: nip19.nsecEncode(secretKey),
    status: 'active',
    rosterOps: [],
    createdAt: 100,
  };
}

describe('saved account removal', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() { return values.size; },
    });
    accountsStore.setState({ accounts: [], activeAccountPubkey: null });
  });

  it('purges only the removed non-active account secret-bearing Drive session', () => {
    const activeSecret = generateSecretKey();
    const activePubkey = getPublicKey(activeSecret);
    const removedSecret = generateSecretKey();
    const removedPubkey = getPublicKey(removedSecret);
    const activeSession = storedSession('11111111-2222-4333-8444-555555555555', activeSecret);
    const removedSession = storedSession('89f3d04f-41fb-437b-9339-75df537bf291', removedSecret);
    localStorage.setItem('iris:identity:sessions', JSON.stringify({
      [activePubkey]: activeSession,
      [removedPubkey]: removedSession,
    }));
    localStorage.setItem('iris:identity:session', JSON.stringify(activeSession));
    accountsStore.setState({
      accounts: [
        {
          pubkey: activePubkey,
          npub: nip19.npubEncode(activePubkey),
          type: 'drive_profile',
          nostrIdentityId: String(activeSession.profileId),
          nsec: nip19.nsecEncode(activeSecret),
          addedAt: 1,
        },
        {
          pubkey: removedPubkey,
          npub: nip19.npubEncode(removedPubkey),
          type: 'drive_profile',
          nostrIdentityId: String(removedSession.profileId),
          nsec: nip19.nsecEncode(removedSecret),
          addedAt: 2,
        },
      ],
      activeAccountPubkey: activePubkey,
    });

    expect(accountsStore.removeAccount(removedPubkey)).toBe(true);

    const sessions = JSON.parse(localStorage.getItem('iris:identity:sessions') ?? '{}');
    expect(sessions).toEqual({ [activePubkey]: activeSession });
    expect(localStorage.getItem('iris:identity:session')).toBe(JSON.stringify(activeSession));
    expect(accountsStore.getState().activeAccountPubkey).toBe(activePubkey);
    expect(accountsStore.getState().accounts.map((account) => account.pubkey)).toEqual([activePubkey]);
  });

  it('refuses account-list removal of the active session', () => {
    const activeSecret = generateSecretKey();
    const activePubkey = getPublicKey(activeSecret);
    const otherSecret = generateSecretKey();
    const otherPubkey = getPublicKey(otherSecret);
    const activeSession = storedSession('11111111-2222-4333-8444-555555555555', activeSecret);
    localStorage.setItem('iris:identity:sessions', JSON.stringify({ [activePubkey]: activeSession }));
    accountsStore.setState({
      accounts: [
        {
          pubkey: activePubkey,
          npub: nip19.npubEncode(activePubkey),
          type: 'drive_profile',
          nsec: nip19.nsecEncode(activeSecret),
          addedAt: 1,
        },
        {
          pubkey: otherPubkey,
          npub: nip19.npubEncode(otherPubkey),
          type: 'nsec',
          nsec: nip19.nsecEncode(otherSecret),
          addedAt: 2,
        },
      ],
      activeAccountPubkey: activePubkey,
    });

    expect(accountsStore.removeAccount(activePubkey)).toBe(false);
    expect(JSON.parse(localStorage.getItem('iris:identity:sessions') ?? '{}'))
      .toEqual({ [activePubkey]: activeSession });
    expect(accountsStore.getState().activeAccountPubkey).toBe(activePubkey);
  });
});
