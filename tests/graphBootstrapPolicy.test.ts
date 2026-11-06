import { describe, expect, test } from 'vitest';
import { DEFAULT_PUBLIC_RELAYS } from '@iris/hashtree-app/defaultRelays';
import { allowsPublicGraphBootstrap, getFipsBootstrapOptions } from '../src/lib/graphBootstrapPolicy';

describe('public graph bootstrap relay policy', () => {
  test('includes Ditto in the three shipped graph relays while retaining the previous catalog', () => {
    expect([...new Set(DEFAULT_PUBLIC_RELAYS)].slice(0, 3)).toContain('wss://relay.ditto.pub');
    expect(DEFAULT_PUBLIC_RELAYS).toEqual(expect.arrayContaining([
      'wss://relay.damus.io', 'wss://relay.primal.net', 'wss://relay.nostr.band',
      'wss://relay.snort.social', 'wss://temp.iris.to',
    ]));
  });

  test('allows only the exact shipped public set, independent of order and duplicates', () => {
    expect(allowsPublicGraphBootstrap(DEFAULT_PUBLIC_RELAYS)).toBe(true);
    expect(allowsPublicGraphBootstrap([...DEFAULT_PUBLIC_RELAYS].reverse())).toBe(true);
    expect(allowsPublicGraphBootstrap([...DEFAULT_PUBLIC_RELAYS, DEFAULT_PUBLIC_RELAYS[0]])).toBe(true);
    for (const relay of DEFAULT_PUBLIC_RELAYS) {
      expect(allowsPublicGraphBootstrap([relay])).toBe(false);
      expect(allowsPublicGraphBootstrap(DEFAULT_PUBLIC_RELAYS.filter(value => value !== relay))).toBe(false);
    }
  });

  test('normalizes surrounding whitespace and trailing slashes', () => {
    expect(allowsPublicGraphBootstrap(DEFAULT_PUBLIC_RELAYS.map(relay => `  ${relay}/  `))).toBe(true);
  });

  test.each([
    { relays: [] },
    { relays: ['wss://relay.example'] },
    { relays: ['ws://127.0.0.1:7777'] },
    { relays: ['wss://relay.damus.io.example'] },
    { relays: ['wss://relay.damus.io?custom=true'] },
    { relays: [DEFAULT_PUBLIC_RELAYS[0], 'wss://relay.example'] },
    { relays: [''] },
  ])('does not authorize fixed public bootstrap for $relays', ({ relays }) => {
    expect(allowsPublicGraphBootstrap(relays)).toBe(false);
  });
});

describe('FIPS public bootstrap follows the saved relay scope', () => {
  test('retains existing catalog behavior for the exact shipped relay set', () => {
    expect(getFipsBootstrapOptions(DEFAULT_PUBLIC_RELAYS)).toEqual({
      websocketSeedUrls: undefined, stunServers: undefined,
    });
  });

  test.each([
    { relays: [] }, { relays: ['wss://relay.example'] }, { relays: ['ws://127.0.0.1:7777'] },
    { relays: [DEFAULT_PUBLIC_RELAYS[0]] },
  ])('does not introduce public transport helpers for $relays', ({ relays }) => {
    expect(getFipsBootstrapOptions(relays)).toEqual({ websocketSeedUrls: [], stunServers: [] });
  });

  test('preserves explicit transport and test overrides independently', () => {
    const explicit = { websocketSeedUrls: ['ws://127.0.0.1:7778/fips'], stunServers: ['stun:127.0.0.1:3478'] };
    expect(getFipsBootstrapOptions([], explicit)).toEqual(explicit);
    expect(getFipsBootstrapOptions(DEFAULT_PUBLIC_RELAYS, { websocketSeedUrls: [], stunServers: [] }))
      .toEqual({ websocketSeedUrls: [], stunServers: [] });
  });
});
