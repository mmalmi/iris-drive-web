import { describe, expect, it, vi } from 'vitest';
import {
  appendMediaImageRetryParam,
  getMediaImageRetryDelayMs,
  isRetryableMediaImageUrl,
  MAX_MEDIA_IMAGE_RETRIES,
} from '../src/lib/mediaImageRetry';

describe('mediaImageRetry', () => {
  it('only retries hashtree thumbnail aliases, not exact immutable file guesses', () => {
    expect(isRetryableMediaImageUrl('/htree/nhash1abc/thumbnail')).toBe(true);
    expect(isRetryableMediaImageUrl('https://drive.iris.to/htree/npub1abc/media%2FTest/thumbnail')).toBe(true);
    expect(isRetryableMediaImageUrl('/htree/nhash1abc/thumbnail.jpg')).toBe(false);
    expect(isRetryableMediaImageUrl('https://drive.iris.to/htree/nhash1abc/thumbnail.jpg')).toBe(false);
    expect(isRetryableMediaImageUrl('https://example.com/thumb.jpg')).toBe(false);
    expect(isRetryableMediaImageUrl(null)).toBe(false);
  });

  it('adds a cache-busting retry parameter', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890);
    expect(appendMediaImageRetryParam('/htree/abc', 2)).toBe('/htree/abc?htree_img_retry=1234567890-2');
    expect(appendMediaImageRetryParam('/htree/abc?x=1', 1)).toBe('/htree/abc?x=1&htree_img_retry=1234567890-1');
    vi.restoreAllMocks();
  });

  it('backs off retry timing linearly and limits retries', () => {
    expect(getMediaImageRetryDelayMs(1)).toBe(350);
    expect(getMediaImageRetryDelayMs(2)).toBe(700);
    expect(MAX_MEDIA_IMAGE_RETRIES).toBe(2);
  });
});
