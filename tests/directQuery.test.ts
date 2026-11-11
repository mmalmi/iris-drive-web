import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/stores/settings', () => ({ settingsStore: { subscribe: () => () => {} }, waitForSettingsLoaded: () => Promise.resolve() }));
vi.mock('../src/lib/runtimeNetwork', () => ({ getEffectiveNostrRelays: () => [] }));

import { answers } from '../src/nostr/directQuery';

const event = (overrides: Record<string, unknown> = {}) => ({
  id: 'a'.repeat(64), pubkey: 'b'.repeat(64), kind: 21, created_at: 100, content: '', sig: '', tags: [['d', 'clip'], ['t', 'music']], ...overrides,
}) as never;

describe('direct relay lookups', () => {
  it('accepts what was asked for, by id, by author and kind, or by tag', () => {
    expect(answers([{ ids: ['a'.repeat(64)] }], event())).toBe(true);
    expect(answers([{ kinds: [21], authors: ['b'.repeat(64)], '#d': ['clip'] }], event())).toBe(true);
    expect(answers([{ kinds: [0] }, { kinds: [21], '#t': ['music'] }], event())).toBe(true);
  });

  it('drops events a relay sent that do not match', () => {
    expect(answers([{ ids: ['c'.repeat(64)] }], event())).toBe(false);
    expect(answers([{ kinds: [0], authors: ['b'.repeat(64)] }], event())).toBe(false);
    expect(answers([{ kinds: [21], '#d': ['other'] }], event())).toBe(false);
  });
});
