import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const authSource = readFileSync(new URL('../src/nostr/auth.ts', import.meta.url), 'utf8');

describe('Drive account privacy', () => {
  it('keeps account names private when creating an account', () => {
    expect(authSource).not.toContain('publishInitialProfile');
    expect(authSource).not.toMatch(/kind:\s*0\b/);
    expect(authSource).not.toMatch(/display_name:\s*trimmedName|name:\s*trimmedName/);
  });

  it('does not announce a Lightning address or initialize a wallet at sign-in', () => {
    expect(authSource).not.toMatch(/npub\.cash|initWallet|stores\/wallet/i);
  });
});
