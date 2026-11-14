/**
 * Notes to one device each, readable only by it: relays and anyone else see
 * a label and the device a note is for, not what it is about. A note's `d`
 * tag names what it is about without saying it, so a newer note about the
 * same thing replaces the older one.
 */
import { finalizeEvent, getPublicKey, nip44, type Event } from 'nostr-tools';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { KIND_DRIVE_ROOT } from './protocolTypes';

/** The `d` tag of a note with `label` about `about`, for one device. */
export function deviceNoteDTag(label: string, about: string[], devicePubkey: string): string {
  return bytesToHex(sha256(new TextEncoder().encode([label, ...about, devicePubkey].join('\n'))));
}

/** One note per device, each carrying `payload` for that device alone. */
export function buildDeviceNotes(
  signerSecretKey: Uint8Array,
  label: string,
  about: string[],
  payload: unknown,
  devicePubkeys: string[],
  createdAt: number,
): Event[] {
  return [...new Set(devicePubkeys)].map((devicePubkey) => finalizeEvent({
    kind: KIND_DRIVE_ROOT,
    created_at: createdAt,
    content: nip44.encrypt(JSON.stringify(payload), nip44.getConversationKey(signerSecretKey, devicePubkey)),
    tags: [
      ['d', deviceNoteDTag(label, about, devicePubkey)],
      ['l', label],
      ['p', devicePubkey],
    ],
  }, signerSecretKey));
}

/**
 * What a note with `label` for this device, and for no other, carries, with
 * its `d` tag; null when the event is not such a note or does not open.
 */
export function readDeviceNote(
  event: Event,
  label: string,
  deviceSecretKey: Uint8Array,
): { payload: unknown; dTag: string | undefined } | null {
  const tag = (name: string) => event.tags.filter(([key]) => key === name).map(([, value]) => value);
  const recipients = tag('p');
  if (event.kind !== KIND_DRIVE_ROOT || !tag('l').includes(label)) return null;
  if (recipients.length !== 1 || recipients[0] !== getPublicKey(deviceSecretKey)) return null;
  try {
    const payload = JSON.parse(nip44.decrypt(event.content, nip44.getConversationKey(deviceSecretKey, event.pubkey))) as unknown;
    return { payload, dTag: tag('d')[0] };
  } catch {
    return null;
  }
}
