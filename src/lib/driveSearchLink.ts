import { isNHash, isNPath, nhashEncode } from '@hashtree/core';
import { normalizeOwnerNpub } from '../drive/setup';
import { directPathIsRoutable } from './driveEntryPath.js';

/** Open links inside the current Drive, including when it runs from a portable URL. */
export function driveSearchHash(input: string, origin: string): string | null {
  const text = input.trim();
  if (text.startsWith('#/')) return text;

  const address = text.split(/[/?]/, 1)[0];
  if (isNHash(address) || isNPath(address)) return '#/' + text;
  const hex = /^([a-f0-9]{64})(\/.*)?$/i.exec(text);
  if (hex) return '#/' + nhashEncode(hex[1]!) + (hex[2] ?? '');
  if (/^(nostr:)?npub1/i.test(text)) {
    const npub = normalizeOwnerNpub(text);
    return npub ? '#/' + npub : null;
  }

  // Native share dialogs and invites use both iris-drive:// and iris-drive:/.
  const path = text.replace(/^iris-drive:\/{1,2}(?=share\b)/i, '/')
    .replace(/^nostr-identity:\/\/device-approval\//, '/approve-device/');
  if (path.startsWith('/') && directPathIsRoutable(path.split('?', 1)[0]!)) return '#' + path;

  try {
    const url = new URL(text);
    // Hash-based links also come from portable and self-hosted Drive instances.
    if (['http:', 'https:', 'htree:'].includes(url.protocol) && url.hash.startsWith('#/')) return url.hash;
    if (url.origin === origin || ['https://drive.iris.to', 'https://files.iris.to'].includes(url.origin)) {
      if (directPathIsRoutable(url.pathname)) return '#' + url.pathname + url.search;
    }
  } catch {
    // A file name or other search query.
  }
  return null;
}
