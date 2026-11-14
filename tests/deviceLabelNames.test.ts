import { describe, expect, it } from 'vitest';
import { distinctDeviceLabels, freeDeviceLabel } from '../src/drive/deviceLabels';

describe('device names people can tell apart', () => {
  it('numbers a second device of the same kind', () => {
    expect(freeDeviceLabel('Chrome on macOS', ['Chrome on macOS'])).toBe('Chrome on macOS (2)');
    expect(freeDeviceLabel('Chrome on macOS', ['chrome on macos', 'Chrome on macOS (2)'])).toBe('Chrome on macOS (3)');
    expect(freeDeviceLabel('Safari on iOS', ['Chrome on macOS'])).toBe('Safari on iOS');
  });

  it('numbers the one added later, whatever order they come in', () => {
    const keys = [
      { pubkey: 'b', label: 'Chrome on macOS', addedAt: 20 },
      { pubkey: 'a', label: 'Chrome on macOS', addedAt: 10 },
      { pubkey: 'c', label: 'Safari on iOS', addedAt: 30 },
      { pubkey: 'd', addedAt: 40 },
    ];
    expect(distinctDeviceLabels(keys).map((key) => key.label)).toEqual(['Chrome on macOS (2)', 'Chrome on macOS', 'Safari on iOS', undefined]);
    expect(distinctDeviceLabels([...keys].reverse()).map((key) => [key.pubkey, key.label])).toEqual([
      ['d', undefined], ['c', 'Safari on iOS'], ['a', 'Chrome on macOS'], ['b', 'Chrome on macOS (2)'],
    ]);
  });

  it('leaves names that differ as they are', () => {
    const keys = [{ pubkey: 'a', label: 'Laptop', addedAt: 1 }, { pubkey: 'b', label: 'Phone', addedAt: 2 }];
    expect(distinctDeviceLabels(keys)).toEqual(keys);
  });
});
