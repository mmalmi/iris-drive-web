import { describe, expect, it } from 'vitest';

import { shouldWaitForLinkVisibleMetadata } from '../src/lib/treeRootRoutePolicy';

describe('tree root route policy', () => {
  it('waits for exact metadata on link-visible routes that only have the URL key', () => {
    expect(shouldWaitForLinkVisibleMetadata({
      visibility: 'link-visible',
      hasRouteLinkKey: true,
      hasEncryptedKey: false,
      hasSessionDecryptedKey: false,
    })).toBe(true);
  });

  it('uses cached state once the encrypted metadata is present', () => {
    expect(shouldWaitForLinkVisibleMetadata({
      visibility: 'link-visible',
      hasRouteLinkKey: true,
      hasEncryptedKey: true,
      hasSessionDecryptedKey: false,
    })).toBe(false);
  });

  it('uses cached state once the current session already decrypted the key', () => {
    expect(shouldWaitForLinkVisibleMetadata({
      visibility: 'link-visible',
      hasRouteLinkKey: true,
      hasEncryptedKey: false,
      hasSessionDecryptedKey: true,
    })).toBe(false);
  });

  it('does not block public routes', () => {
    expect(shouldWaitForLinkVisibleMetadata({
      visibility: 'public',
      hasRouteLinkKey: true,
      hasEncryptedKey: false,
      hasSessionDecryptedKey: false,
    })).toBe(false);
  });
});
