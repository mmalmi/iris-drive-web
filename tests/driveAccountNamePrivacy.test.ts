import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const authSource = readFileSync(new URL('../src/nostr/auth.ts', import.meta.url), 'utf8');

describe('Drive account name privacy', () => {
  it('does not publish local account names in the public initial kind 0 profile', () => {
    expect(authSource).not.toContain('publishInitialProfile(npubStr, accountOptions.name)');
    expect(authSource).not.toMatch(/function publishInitialProfile\([^)]*name/);
    expect(authSource).not.toMatch(/display_name:\s*trimmedName|name:\s*trimmedName/);
  });
});
