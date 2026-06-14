import { describe, expect, it } from 'vitest';
import { shortNpub } from '../src/utils/format';

const sampleNpub = `npub1${'a'.repeat(58)}`;

describe('shortNpub', () => {
  it('returns empty or already-short values unchanged', () => {
    expect(shortNpub('')).toBe('');
    expect(shortNpub('npub1short')).toBe('npub1short');
  });

  it('truncates long npubs with default and custom segment lengths', () => {
    expect(shortNpub(sampleNpub)).toBe(`${sampleNpub.slice(0, 10)}...${sampleNpub.slice(-6)}`);
    expect(shortNpub(sampleNpub, { start: 12, end: 4 })).toBe(`${sampleNpub.slice(0, 12)}...${sampleNpub.slice(-4)}`);
  });
});
