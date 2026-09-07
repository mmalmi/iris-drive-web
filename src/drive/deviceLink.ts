import { finalizeEvent, generateSecretKey, getPublicKey, nip19, type Event } from 'nostr-tools';
import {
  createDeviceApprovalBootstrap,
  encodeDeviceApprovalBootstrap,
  pubkeyToNpub,
  npubToPubkey,
  type DeviceApprovalBootstrap,
  type DeviceApprovalReceipt,
} from '@iris/identity';
import { FACT_OP_KIND } from 'nostr-social-graph';
import type { NostrIdentityId, SignedNostrIdentityRosterOp } from './protocolTypes';

export type DriveDeviceApprovalBootstrap = DeviceApprovalBootstrap;

export const NOSTR_IDENTITY_DEVICE_APPROVAL_APPLIED_ACK_TYPE =
  'nostr_identity_device_approval_applied_ack';
export const KIND_NOSTR_IDENTITY_DEVICE_APPROVAL_APPLIED_ACK = FACT_OP_KIND;

export interface DriveDeviceApprovalAppliedAck {
  schema: 1;
  requestPubkey: string;
  deviceAppKeyPubkey: string;
  approvalEventId: string;
  approvedByPubkey: string;
  appliedAt: number;
}

export interface PendingDriveDeviceApproval {
  bootstrap: DriveDeviceApprovalBootstrap;
  requestSecretKeyNsec: string;
}

export type NostrIdentitySessionStatus = 'active';

export interface NostrIdentitySession {
  profileId: NostrIdentityId;
  appKeyPubkey: string;
  appKeyNpub: string;
  appKeyNsec: string;
  status: NostrIdentitySessionStatus;
  rosterOps: SignedNostrIdentityRosterOp[];
  createdAt: number;
  label?: string;
}

export interface StoredNostrIdentitySession {
  schema: 1;
  profileId: NostrIdentityId;
  appKeyNsec: string;
  status: NostrIdentitySessionStatus;
  rosterOps: SignedNostrIdentityRosterOp[];
  createdAt: number;
  label?: string;
}

export interface DriveDeviceApprovalDraft {
  appKeySecretKey: Uint8Array;
  requestSecretKey: Uint8Array;
  bootstrap: DriveDeviceApprovalBootstrap;
  url: string;
}

export function createDriveDeviceApprovalDraft(options: {
  appKeySecretKey?: Uint8Array;
  requestSecretKey?: Uint8Array;
  label?: string;
} = {}): DriveDeviceApprovalDraft {
  const appKeySecretKey = options.appKeySecretKey ?? generateSecretKey();
  const { bootstrap, requestSecretKey } = createDeviceApprovalBootstrap({
    deviceAppKeySecretKey: appKeySecretKey,
    ...(options.requestSecretKey ? { requestSecretKey: options.requestSecretKey } : {}),
    ...(options.label !== undefined ? { label: options.label } : {}),
  });
  return {
    appKeySecretKey,
    requestSecretKey,
    bootstrap,
    url: encodeDeviceApprovalBootstrap(bootstrap),
  };
}

export function pendingDriveDeviceApprovalFromDraft(
  draft: Pick<DriveDeviceApprovalDraft, 'bootstrap' | 'requestSecretKey'>,
): PendingDriveDeviceApproval {
  return {
    bootstrap: { ...draft.bootstrap },
    requestSecretKeyNsec: nip19.nsecEncode(draft.requestSecretKey),
  };
}

export function driveDeviceApprovalRequestSecretKey(pending: PendingDriveDeviceApproval): Uint8Array {
  const decoded = nip19.decode(pending.requestSecretKeyNsec);
  if (decoded.type !== 'nsec') {
    throw new Error('Stored device approval request secret is not an nsec');
  }
  const secretKey = decoded.data as Uint8Array;
  if (getPublicKey(secretKey) !== npubToPubkey(pending.bootstrap.requestNpub)) {
    throw new Error('Stored device approval request secret does not match the request pubkey');
  }
  return secretKey;
}

export function buildDriveDeviceApprovalAppliedAckEvent(options: {
  appKeySecretKey: Uint8Array;
  receipt: DeviceApprovalReceipt;
  approvalEventId: string;
  appliedAt: number;
}): Event {
  const deviceAppKeyPubkey = getPublicKey(options.appKeySecretKey);
  if (deviceAppKeyPubkey !== options.receipt.deviceAppKeyPubkey) {
    throw new Error('Device approval applied ACK signer mismatch');
  }
  if (!/^[0-9a-f]{64}$/u.test(options.approvalEventId)) {
    throw new Error('Device approval applied ACK receipt id is invalid');
  }
  if (!Number.isSafeInteger(options.appliedAt) || options.appliedAt < 0) {
    throw new Error('Device approval applied ACK timestamp is invalid');
  }

  const ack: DriveDeviceApprovalAppliedAck = {
    schema: 1,
    requestPubkey: options.receipt.requestPubkey,
    deviceAppKeyPubkey,
    approvalEventId: options.approvalEventId,
    approvedByPubkey: options.receipt.approvedByPubkey,
    appliedAt: options.appliedAt,
  };
  return finalizeEvent({
    kind: FACT_OP_KIND,
    content: JSON.stringify(ack),
    created_at: ack.appliedAt,
    tags: [
      ['type', NOSTR_IDENTITY_DEVICE_APPROVAL_APPLIED_ACK_TYPE],
      ['p', ack.approvedByPubkey],
      ['e', ack.approvalEventId],
      ['request_pubkey', ack.requestPubkey],
    ],
  }, options.appKeySecretKey);
}

export { pubkeyToNpub, npubToPubkey };
