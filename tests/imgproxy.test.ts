import { afterEach, describe, expect, it, vi } from 'vitest';

import { generateProxyUrlAsync } from '../src/utils/imgproxy';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generateProxyUrlAsync', () => {
  it('passes ArrayBuffer inputs to WebCrypto HMAC APIs', async () => {
    const importKey = vi.fn(async (_format, keyData) => {
      expect(keyData).toBeInstanceOf(ArrayBuffer);
      return { type: 'secret' };
    });
    const sign = vi.fn(async (_algorithm, _key, data) => {
      expect(data).toBeInstanceOf(ArrayBuffer);
      return new Uint8Array([1, 2, 3]).buffer;
    });

    vi.stubGlobal('crypto', {
      subtle: {
        importKey,
        sign,
      },
    });

    const proxied = await generateProxyUrlAsync('https://example.com/avatar.png');

    expect(proxied).toMatch(/^https:\/\/imgproxy\.iris\.to\//);
    expect(importKey).toHaveBeenCalledOnce();
    expect(sign).toHaveBeenCalledOnce();
  });
});
