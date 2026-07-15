import type { TreeVisibility } from '@hashtree/core';

export function shouldWaitForLinkVisibleMetadata(options: {
  visibility: TreeVisibility | undefined;
  hasRouteLinkKey: boolean;
  hasEncryptedKey: boolean;
  hasSessionDecryptedKey: boolean;
}): boolean {
  const {
    visibility,
    hasRouteLinkKey,
    hasEncryptedKey,
    hasSessionDecryptedKey,
  } = options;

  return visibility === 'link-visible'
    && hasRouteLinkKey
    && !hasEncryptedKey
    && !hasSessionDecryptedKey;
}
