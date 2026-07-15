import { describe, expect, it } from 'vitest';
import { getSameOriginResponseMode } from '../src/lib/swSameOriginPolicy';

describe('same-origin service worker response policy', () => {
  it('adds synthetic isolation headers only for navigations', () => {
    expect(getSameOriginResponseMode({ mode: 'navigate', destination: 'document' })).toBe('document-coi');
  });

  it('passes worker scripts through unchanged', () => {
    expect(getSameOriginResponseMode({ mode: 'same-origin', destination: 'worker' })).toBe('subresource-corp');
    expect(getSameOriginResponseMode({ mode: 'same-origin', destination: 'script' })).toBe('subresource-corp');
    expect(getSameOriginResponseMode({ mode: 'same-origin', destination: 'sharedworker' })).toBe('subresource-corp');
  });

  it('passes ordinary same-origin media through unchanged', () => {
    expect(getSameOriginResponseMode({ mode: 'same-origin', destination: 'image' })).toBe('passthrough');
    expect(getSameOriginResponseMode({ mode: 'same-origin', destination: 'video' })).toBe('passthrough');
    expect(getSameOriginResponseMode({ mode: 'same-origin', destination: 'audio' })).toBe('passthrough');
  });
});
