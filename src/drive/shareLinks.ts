import { nhashDecode, nhashEncode } from '@hashtree/core';
import { getNhashFileUrl } from '../lib/mediaUrl';
import { encodeShareInvite, parseShareInvite, SHARE_INVITE_PREFIX } from './protocol';

const MAX_INVITE_BYTES = 128 * 1024;

export async function resolveShareInvite(input: string, signal?: AbortSignal): Promise<string> {
  const trimmed = input.trim();
  const reference = trimmed.startsWith(SHARE_INVITE_PREFIX) ? trimmed.slice(SHARE_INVITE_PREFIX.length) : trimmed.includes('#/share-invite/') ? trimmed.split('#/share-invite/')[1]! : trimmed;
  if (!reference.startsWith('nhash1')) {
    parseShareInvite(input);
    return input;
  }
  if (reference.length > 160) throw new Error('Invalid invite reference');
  const cid = nhashDecode(reference);
  if (!cid.key || nhashEncode(cid) !== reference) throw new Error('Invalid private invite reference');
  // The app's normal worker verifies the immutable blob and decrypts it. The
  // key stays in the fragment until this same-origin request is made.
  const response = await fetch(getNhashFileUrl(cid, 'invite.json'), { signal });
  if (!response.ok || !response.body) throw new Error('Could not load invite. Check your connection and try again.');
  if (Number(response.headers.get('content-length')) > MAX_INVITE_BYTES) throw new Error('Invite is too large');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_INVITE_BYTES) throw new Error('Invite is too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const invite = encodeShareInvite(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  parseShareInvite(invite);
  return invite;
}
