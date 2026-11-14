/**
 * The key and the topic a document's live channel uses (see liveChannel.ts).
 *
 * Both come from a secret that everyone who may read the document already
 * holds, and from where the document is. The key encrypts what is sent; the
 * topic is what relays are asked for. Neither says which document it is or
 * who is in it, and the topic says nothing about the key.
 */
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils.js';

/** Where a secret comes from: a shared folder's key, a Drive's key, or an account's own key. */
export type LiveSecretKind = 'share' | 'drive' | 'account';

/** The document's place, as everyone who has it open addresses it. */
export interface LivePlace {
  scope: string;
  treeName: string;
  path: string[];
}

export interface LiveKey {
  /** Names the secret it was made from; another id means the secret was rotated. */
  id: string;
  /** Encrypts and decrypts messages (NIP-44 v2, used as the conversation key). */
  key: Uint8Array;
  /** What messages are tagged with, in hex. */
  topic: string;
}

const SALT = utf8ToBytes('iris-drive live v1');

/** The key and topic for one document, from one secret. */
export function deriveLiveKey(kind: LiveSecretKind, secret: Uint8Array, id: string, place: LivePlace): LiveKey {
  const name = utf8ToBytes(JSON.stringify([kind, place.scope, place.treeName, ...place.path]));
  const expand = (purpose: string) => hkdf(sha256, secret, SALT, concatBytes(utf8ToBytes(`${purpose}\0`), name), 32);
  return { id, key: expand('key'), topic: bytesToHex(expand('topic')) };
}

/** A short name for a secret, so that a rotation is noticed without keeping the secret around. */
export function secretId(kind: LiveSecretKind, epoch: number | string, secret: Uint8Array): string {
  return `${kind}:${epoch}:${bytesToHex(sha256(secret)).slice(0, 16)}`;
}
