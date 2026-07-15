import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import {
  createDeviceApprovalBootstrap,
  encodeDeviceApprovalBootstrap,
  pubkeyToNpub,
  npubToPubkey,
  type DeviceApprovalBootstrap,
} from '@iris/identity';
import type { NostrIdentityId, SignedNostrIdentityRosterOp } from './protocolTypes';

export type DriveDeviceApprovalBootstrap = DeviceApprovalBootstrap;

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

export { pubkeyToNpub, npubToPubkey };
