/**
 * Recovery phrases, made the way native Iris Drive makes them
 * (`iris-drive-core/src/recovery_phrase.rs` and `Profile::add_recovery_pubkey`).
 *
 * A phrase is 12 English BIP-39 words. Its key is the NIP-06 key of those
 * words with no passphrase. Adding it signs one `add_facet` for that key, with
 * the purposes, capabilities and label native gives a recovery phrase, then
 * moves the Drive key to a new epoch that is wrapped for it too. The phrase
 * itself is never kept: only its public key goes into the account.
 */
import { createNostrIdentitySignerFromSecretKey } from '@iris/identity';
import { getPublicKey } from 'nostr-tools';
import { generateSeedWords, privateKeyFromSeedWords, validateWords } from 'nostr-tools/nip06';
import { DRIVE_DEVICE_LABEL_SCHEMA, encryptDriveDeviceLabelsWithDck } from './deviceLabels';
import { signNostrIdentityFacetAcceptance, signNostrIdentityRosterOp } from './protocolProfileEvents';
import { projectNostrIdentityRoster } from './protocolProfileProjection';
import { createNostrIdentityDckRotateAfterAddOp } from './protocolRecovery';
import type {
  NostrIdentityCapabilities,
  NostrIdentityFacet,
  NostrIdentityId,
  NostrIdentityRosterProjection,
  SignedNostrIdentityFacetAcceptance,
  SignedNostrIdentityRosterOp,
} from './protocolTypes';

/** `RECOVERY_PHRASE_WORD_COUNT` in native. */
export const RECOVERY_PHRASE_WORD_COUNT = 12;

/** The label native gives every recovery phrase key. */
export const RECOVERY_PHRASE_FACET_LABEL = 'Recovery key';

/** `NostrIdentityCapabilities::recovery_phrase()` in native. */
export const RECOVERY_PHRASE_CAPABILITIES: NostrIdentityCapabilities = {
  can_recover_app_keys: true,
  can_receive_secret_wraps: true,
  can_decrypt_secret_epochs: true,
};

/** 128 bits of randomness as 12 English words, like `generate_recovery_phrase`. */
export function generateRecoveryPhrase(): string {
  return generateSeedWords();
}

/** Lower case, single spaces: `normalize_recovery_phrase`. */
export function normalizeRecoveryPhrase(phrase: string): string {
  return phrase.split(/\s+/).filter(Boolean).map((word) => word.toLowerCase()).join(' ');
}

/** `validate_recovery_phrase`: exactly 12 words that make a valid phrase. */
export function validateRecoveryPhrase(phrase: string): string {
  const normalized = normalizeRecoveryPhrase(phrase);
  if (normalized.split(' ').length !== RECOVERY_PHRASE_WORD_COUNT) {
    throw new Error(`A recovery phrase has ${RECOVERY_PHRASE_WORD_COUNT} words`);
  }
  if (!validateWords(normalized)) {
    throw new Error('Those words are not a recovery phrase');
  }
  return normalized;
}

/** `recovery_phrase_to_keys`: the NIP-06 key, account 0, no passphrase. */
export function recoveryPhraseSecretKey(phrase: string): Uint8Array {
  return privateKeyFromSeedWords(validateRecoveryPhrase(phrase));
}

export function recoveryPhrasePubkey(phrase: string): string {
  return getPublicKey(recoveryPhraseSecretKey(phrase));
}

/** `NostrIdentityFacet::recovery_phrase(pubkey, added_at)` in native. */
export function recoveryPhraseFacet(pubkey: string, addedAt: number): NostrIdentityFacet {
  return {
    pubkey,
    purposes: ['recovery_phrase'],
    capabilities: { ...RECOVERY_PHRASE_CAPABILITIES },
    added_at: addedAt,
    label: RECOVERY_PHRASE_FACET_LABEL,
  };
}

/** The account's recovery phrase keys, oldest first. */
export function activeRecoveryPhraseFacets(
  projection: Pick<NostrIdentityRosterProjection, 'active_facets'>,
): NostrIdentityFacet[] {
  return Object.values(projection.active_facets)
    .filter((facet) => facet.purposes?.includes('recovery_phrase'))
    .sort((left, right) => left.added_at - right.added_at || left.pubkey.localeCompare(right.pubkey));
}

/** Two different word positions, in order, for the person to type back. */
export function pickConfirmationWordIndexes(
  wordCount = RECOVERY_PHRASE_WORD_COUNT,
  random: () => number = secureRandom,
): [number, number] {
  const first = Math.floor(random() * wordCount);
  const second = (first + 1 + Math.floor(random() * (wordCount - 1))) % wordCount;
  return first < second ? [first, second] : [second, first];
}

export interface CreateRecoveryPhraseRosterOpsOptions {
  profileId: NostrIdentityId;
  /** This device's key. It must be an admin of the account. */
  appKeySecretKey: Uint8Array;
  rosterOps: SignedNostrIdentityRosterOp[];
  recoveryPhrase: string;
  createdAt: number;
  clientNonce: string;
  /** Device names, sealed again under the new Drive key so they stay readable. */
  deviceLabels?: Record<string, string>;
  dckPlaintext?: string;
}

export interface RecoveryPhraseRosterOps {
  recoveryPubkey: string;
  addOp: SignedNostrIdentityRosterOp;
  dckRotationOp: SignedNostrIdentityRosterOp;
  /**
   * Signed by the phrase's own key, so signing in with the phrase can find
   * this account by the events that key signed.
   */
  acceptance: SignedNostrIdentityFacetAcceptance;
}

/**
 * The roster changes that add a recovery phrase: `add_recovery_pubkey` in
 * native. Resolves null when the phrase is already one of the account's.
 */
export async function createRecoveryPhraseRosterOps(
  options: CreateRecoveryPhraseRosterOpsOptions,
): Promise<RecoveryPhraseRosterOps | null> {
  const recoverySecretKey = recoveryPhraseSecretKey(options.recoveryPhrase);
  const recoveryPubkey = getPublicKey(recoverySecretKey);
  const appKeyPubkey = getPublicKey(options.appKeySecretKey);
  const projection = projectNostrIdentityRoster(options.profileId, options.rosterOps);
  if (!projection.active_facets[appKeyPubkey]?.capabilities?.can_admin_profile) {
    throw new Error('Only an admin device can add a recovery phrase');
  }
  const existing = projection.active_facets[recoveryPubkey];
  if (existing) {
    if (existing.purposes?.includes('recovery_phrase')) return null;
    throw new Error('That key is already part of this account');
  }
  if (projection.tombstones[recoveryPubkey]) {
    throw new Error('That recovery phrase was removed from this account');
  }

  const dckPlaintext = options.dckPlaintext ?? randomDriveContentKey();
  const secretEpoch = Math.max(0, ...Object.values(projection.secret_epochs).map((epoch) => epoch.epoch)) + 1;
  const encryptedDeviceLabels = options.deviceLabels && Object.keys(options.deviceLabels).length > 0
    ? await encryptDriveDeviceLabelsWithDck({
        schema: DRIVE_DEVICE_LABEL_SCHEMA,
        profileId: options.profileId,
        secretEpoch,
        labels: options.deviceLabels,
        updatedAt: options.createdAt,
      }, dckPlaintext)
    : undefined;
  const addOp = signNostrIdentityRosterOp({
    signerSecretKey: options.appKeySecretKey,
    profileId: options.profileId,
    parents: projection.accepted_op_ids,
    createdAt: options.createdAt,
    clientNonce: options.clientNonce,
    ...(encryptedDeviceLabels ? { encryptedDeviceLabels } : {}),
    op: {
      op: 'add_facet',
      facet: recoveryPhraseFacet(recoveryPubkey, options.createdAt),
    },
  });
  const dckRotationOp = await createNostrIdentityDckRotateAfterAddOp({
    profileId: options.profileId,
    signer: createNostrIdentitySignerFromSecretKey(options.appKeySecretKey),
    rosterOps: options.rosterOps,
    parentRosterOp: addOp,
    createdAt: options.createdAt + 1,
    clientNonce: `${options.clientNonce}:rotate-dck`,
    dckPlaintext,
  });
  const acceptance = signNostrIdentityFacetAcceptance({
    signerSecretKey: recoverySecretKey,
    profileId: options.profileId,
    purposes: ['recovery_phrase'],
    rosterOpId: addOp.op_id,
    acceptedAt: options.createdAt + 1,
    clientNonce: `${options.clientNonce}:accept`,
  });
  return { recoveryPubkey, addOp, dckRotationOp, acceptance };
}

function secureRandom(): number {
  const value = new Uint32Array(1);
  globalThis.crypto.getRandomValues(value);
  return value[0] / 2 ** 32;
}

function randomDriveContentKey(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
