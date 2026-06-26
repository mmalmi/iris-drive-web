import {
  buildIrisProfileRosterOpEventDraft,
  type IrisIdentityEventSigner,
} from '@iris/identity';
import { parseIrisProfileRosterOpEvent } from './protocolProfileEvents';
import {
  irisProfileRosterParentIds,
  projectIrisProfileRoster,
} from './protocolProfileProjection';
import type {
  IrisProfileId,
  SignedIrisProfileRosterOp,
} from './protocolTypes';
import { generateSecretKey, type Event as NostrToolsEvent } from 'nostr-tools';

export interface CreateIrisProfileDckRewrapOpOptions {
  profileId: IrisProfileId;
  signer: IrisIdentityEventSigner;
  rosterOps: SignedIrisProfileRosterOp[];
  appKeyPubkey: string;
  parentRosterOp: SignedIrisProfileRosterOp;
  createdAt?: number;
  clientNonce?: string;
}

export interface CreateIrisProfileDckRotateAfterRemovalOpOptions {
  profileId: IrisProfileId;
  signer: IrisIdentityEventSigner;
  rosterOps: SignedIrisProfileRosterOp[];
  parentRosterOp: SignedIrisProfileRosterOp;
  createdAt?: number;
  clientNonce?: string;
  dckPlaintext?: string;
}

export interface CreateIrisProfileDckRotateAfterAddOpOptions {
  profileId: IrisProfileId;
  signer: IrisIdentityEventSigner;
  rosterOps: SignedIrisProfileRosterOp[];
  parentRosterOp: SignedIrisProfileRosterOp;
  createdAt?: number;
  clientNonce?: string;
  dckPlaintext?: string;
}

export async function createIrisProfileDckRewrapOp(
  options: CreateIrisProfileDckRewrapOpOptions,
): Promise<SignedIrisProfileRosterOp | null> {
  const rosterOps = [...options.rosterOps, options.parentRosterOp];
  const projection = projectIrisProfileRoster(options.profileId, rosterOps);
  const latestEpoch = Object.values(projection.key_epochs)
    .sort((left, right) => right.epoch - left.epoch)[0];
  if (!latestEpoch || latestEpoch.wrapped_dck[options.appKeyPubkey]) {
    return null;
  }

  if (!options.signer.nip44Decrypt || !options.signer.nip44Encrypt) {
    throw new Error('Recovery signer needs NIP-44 decrypt access to rewrap the Drive key');
  }

  const signerPubkey = normalizeHexPubkeyOrThrow(await options.signer.getPublicKey(), 'recovery signer');
  const existingWrap = latestEpoch.wrapped_dck[signerPubkey];
  if (!existingWrap) {
    throw new Error('Existing Drive key epoch is not wrapped for this recovery key');
  }

  const dckPlaintext = await options.signer.nip44Decrypt(latestEpoch.signed_by_pubkey, existingWrap);
  const recipients = Object.values(projection.active_facets)
    .filter((facet) => facet.capabilities?.can_receive_key_wraps)
    .map((facet) => facet.pubkey)
    .concat(options.appKeyPubkey)
    .filter((pubkey, index, values) => values.indexOf(pubkey) === index)
    .sort();
  const wrappedDck: Record<string, string> = {};
  for (const recipient of recipients) {
    wrappedDck[recipient] = await options.signer.nip44Encrypt(recipient, dckPlaintext);
  }

  const draft = buildIrisProfileRosterOpEventDraft({
    signerPubkey,
    profileId: options.profileId,
    parents: irisProfileRosterParentIds(rosterOps),
    createdAt: options.createdAt ?? currentUnixSeconds(),
    clientNonce: options.clientNonce ?? `${options.parentRosterOp.content.client_nonce}:rewrap-dck`,
    op: {
      op: 'rotate_key_epoch',
      epoch: latestEpoch.epoch + 1,
      wrapped_dck: wrappedDck,
    },
  });
  const signed = await options.signer.signEvent(draft);
  return parseIrisProfileRosterOpEvent(signed as NostrToolsEvent);
}

export async function createIrisProfileDckRotateAfterRemovalOp(
  options: CreateIrisProfileDckRotateAfterRemovalOpOptions,
): Promise<SignedIrisProfileRosterOp | null> {
  return createIrisProfileDckRotateForCurrentRecipientsOp({
    ...options,
    requireExistingEpoch: true,
    missingEpochResult: null,
    missingEpochError: null,
    defaultClientNonceSuffix: 'rotate-dck',
  });
}

export async function createIrisProfileDckRotateAfterAddOp(
  options: CreateIrisProfileDckRotateAfterAddOpOptions,
): Promise<SignedIrisProfileRosterOp> {
  const op = await createIrisProfileDckRotateForCurrentRecipientsOp({
    ...options,
    requireExistingEpoch: false,
    missingEpochResult: 'create',
    missingEpochError: 'Cannot rotate Drive key epoch for an empty recipient set',
    defaultClientNonceSuffix: 'rotate-dck-after-add',
  });
  if (!op) throw new Error('Cannot rotate Drive key epoch for an empty recipient set');
  return op;
}

async function createIrisProfileDckRotateForCurrentRecipientsOp(options: {
  profileId: IrisProfileId;
  signer: IrisIdentityEventSigner;
  rosterOps: SignedIrisProfileRosterOp[];
  parentRosterOp: SignedIrisProfileRosterOp;
  createdAt?: number;
  clientNonce?: string;
  dckPlaintext?: string;
  requireExistingEpoch: boolean;
  missingEpochResult: 'create' | null;
  missingEpochError: string | null;
  defaultClientNonceSuffix: string;
}): Promise<SignedIrisProfileRosterOp | null> {
  const rosterOps = [...options.rosterOps, options.parentRosterOp];
  const projection = projectIrisProfileRoster(options.profileId, rosterOps);
  const latestEpoch = Object.values(projection.key_epochs)
    .sort((left, right) => right.epoch - left.epoch)[0];
  if (!latestEpoch) {
    if (options.missingEpochResult !== 'create') return null;
    if (!Object.values(projection.active_facets).some((facet) => facet.capabilities?.can_receive_key_wraps)) {
      if (options.missingEpochError) throw new Error(options.missingEpochError);
      return null;
    }
  }

  if (!options.signer.nip44Decrypt || !options.signer.nip44Encrypt) {
    throw new Error('Recovery signer needs NIP-44 decrypt access to rotate the Drive key');
  }

  const signerPubkey = normalizeHexPubkeyOrThrow(await options.signer.getPublicKey(), 'recovery signer');
  const signerFacet = projection.active_facets[signerPubkey];
  if (!signerFacet?.capabilities?.can_decrypt_key_epochs
    || !(signerFacet.capabilities.can_admin_profile || signerFacet.capabilities.can_recover_app_keys)) {
    throw new Error('Signer cannot rotate Drive key epochs');
  }
  if (latestEpoch) {
    const existingWrap = latestEpoch.wrapped_dck[signerPubkey];
    if (!existingWrap) {
      throw new Error('Existing Drive key epoch is not wrapped for this recovery key');
    }
    await options.signer.nip44Decrypt(latestEpoch.signed_by_pubkey, existingWrap);
  } else if (options.requireExistingEpoch) {
    return null;
  }

  const recipients = Object.values(projection.active_facets)
    .filter((facet) => facet.capabilities?.can_receive_key_wraps)
    .map((facet) => facet.pubkey)
    .filter((pubkey, index, values) => values.indexOf(pubkey) === index)
    .sort();
  if (recipients.length === 0) {
    return null;
  }

  const dckPlaintext = options.dckPlaintext ?? randomDriveContentKey();
  const wrappedDck: Record<string, string> = {};
  for (const recipient of recipients) {
    wrappedDck[recipient] = await options.signer.nip44Encrypt(recipient, dckPlaintext);
  }

  const draft = buildIrisProfileRosterOpEventDraft({
    signerPubkey,
    profileId: options.profileId,
    parents: irisProfileRosterParentIds(rosterOps),
    createdAt: options.createdAt ?? currentUnixSeconds(),
    clientNonce: options.clientNonce ?? `${options.parentRosterOp.content.client_nonce}:${options.defaultClientNonceSuffix}`,
    op: {
      op: 'rotate_key_epoch',
      epoch: latestEpoch ? latestEpoch.epoch + 1 : 1,
      wrapped_dck: wrappedDck,
    },
  });
  const signed = await options.signer.signEvent(draft);
  return parseIrisProfileRosterOpEvent(signed as NostrToolsEvent);
}

function normalizeHexPubkeyOrThrow(pubkey: string, label: string): string {
  const normalized = pubkey.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error(`${label} pubkey must be 64-char hex`);
  }
  return normalized;
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function randomDriveContentKey(): string {
  const bytes = new Uint8Array(32);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    bytes.set(generateSecretKey());
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
