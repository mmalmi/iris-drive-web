import { describe, expect, it } from 'vitest';
import { isPortableBaseUrl } from '../src/lib/buildFlavor';

describe('build flavor', () => {
  it('treats relative base URLs as portable htree builds', () => {
    expect(isPortableBaseUrl('./')).toBe(true);
  });

  it('keeps hosted builds on the normal web profile', () => {
    expect(isPortableBaseUrl('/')).toBe(false);
    expect(isPortableBaseUrl(undefined)).toBe(false);
  });
});
