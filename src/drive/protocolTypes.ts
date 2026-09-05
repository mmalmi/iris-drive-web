import type { CID } from '@hashtree/core';
import type {
  NostrIdentityId,
  SignedNostrIdentityFacetAcceptance,
  SignedNostrIdentityRosterOp,
  NostrIdentitySecretEpoch,
  NostrIdentityTombstone,
} from 'nostr-social-graph';

export {
  KIND_NOSTR_IDENTITY_FACET_ACCEPTANCE,
  KIND_NOSTR_IDENTITY_ROSTER_OP,
  NOSTR_IDENTITY_FACET_ACCEPTANCE_SCHEMA,
  NOSTR_IDENTITY_ROSTER_SCHEMA,
} from 'nostr-social-graph';
export type {
  BuildNostrIdentityFacetAcceptanceEventOptions,
  BuildNostrIdentityRosterOpEventOptions,
  NostrIdentityCapabilities,
  NostrIdentityFacet,
  NostrIdentityFacetAcceptanceContent,
  NostrIdentityId,
  NostrIdentityKeyPurpose,
  NostrIdentityRosterOp,
  NostrIdentityRosterOpContent,
  NostrIdentityRosterProjection,
  NostrIdentitySecretEpoch,
  NostrIdentityTombstone,
  SignedNostrIdentityFacetAcceptance,
  SignedNostrIdentityRosterOp,
} from 'nostr-social-graph';

export const KIND_APP_KEYS = 30078;
export const KIND_DRIVE_ROOT = 30078;
export const KIND_LEGACY_DRIVE_ROOT = 30079;
export const D_TAG_APP_KEYS = 'iris-drive/app-keys';
export const KIND_SHARE_MEMBER_ROSTER_OP = 30078;
export const KIND_SHARE_ROSTER_CHECKPOINT = 30078;
export const SHARE_INVITE_PREFIX = 'iris-drive://share-invite/';
export const SHARE_MEMBER_ROSTER_SCHEMA = 1;
export const SHARE_ROSTER_CHECKPOINT_SCHEMA = 1;

export type ShareRole = 'admin' | 'editor' | 'reader';
export type ShareMemberStatus = 'pending' | 'active' | 'revoked';
export type ShareRootWriteAuthorization =
  | 'authorized'
  | 'unknown_app_key'
  | 'unknown_member'
  | 'pending_member'
  | 'revoked_member'
  | 'insufficient_share_role'
  | 'app_key_not_active'
  | 'not_an_app_key'
  | 'app_key_cannot_write_roots';
export interface ShareMember {
  profile_id: NostrIdentityId;
  role: ShareRole;
  status: ShareMemberStatus;
  representative_npub_hint?: string;
  display_name?: string;
}

export interface PendingShareInvite {
  representative_npub_hint: string;
  role: ShareRole;
  status: 'pending';
  display_name?: string;
  created_at: number;
}

export type ShareMemberRosterOp =
  | { op: 'grant_member'; member: ShareMember }
  | { op: 'set_member_role'; profile_id: NostrIdentityId; role: ShareRole }
  | { op: 'revoke_member'; profile_id: NostrIdentityId; reason?: string };

export interface ShareMemberRosterOpContent {
  schema: number;
  share_id: NostrIdentityId;
  actor_pubkey: string;
  parents?: string[];
  key_roster_parents?: string[];
  client_nonce: string;
  created_at: number;
  op: ShareMemberRosterOp;
}

export interface SignedShareMemberRosterOp {
  op_id: string;
  signer_pubkey: string;
  content: ShareMemberRosterOpContent;
  event_json: string;
}

export interface ShareMemberRosterProjection {
  share_id: NostrIdentityId;
  members: Record<string, ShareMember>;
  accepted_op_ids: string[];
  rejected_op_ids: string[];
}

export interface ShareRecipient {
  profile_id: NostrIdentityId;
  app_pubkey: string;
  role: ShareRole;
  label?: string;
  representative_npub_hint?: string;
  display_name?: string;
}

export interface ResolvedShareRecipient {
  profile_id: NostrIdentityId;
  representative_pubkey: string;
  representative_npub: string;
  display_name?: string;
  app_pubkeys: string[];
  linked_social_pubkeys: string[];
}

export interface ShareRecipientProfileEvidence {
  profile_id: NostrIdentityId;
  representative_pubkey?: string;
  representative_npub?: string;
  display_name?: string;
  roster_ops?: SignedNostrIdentityRosterOp[];
  acceptances?: SignedNostrIdentityFacetAcceptance[];
  facet_acceptances?: SignedNostrIdentityFacetAcceptance[];
}

export interface ShareAccessGrant {
  target: { type: 'id'; id: NostrIdentityId } | { type: 'pubkey'; pubkey: string };
  role: ShareRole;
  status: ShareMemberStatus;
  representative_npub_hint?: string;
  display_name?: string;
}

export interface ShareAccessSnapshot {
  schema: number;
  resource_id: NostrIdentityId;
  updated_at: number;
  grants?: ShareAccessGrant[];
  devices?: Record<string, { pubkey: string; profile_id?: NostrIdentityId; added_at: number; label?: string }>;
  tombstones?: Record<string, NostrIdentityTombstone>;
  key_epochs?: Record<string, NostrIdentitySecretEpoch>;
}

export interface SignedShareAccessSnapshot {
  snapshot_id: string;
  signer_pubkey: string;
  content: ShareAccessSnapshot;
  event_json: string;
}

export interface SharedFolder {
  share_id: NostrIdentityId;
  owner_profile_id: NostrIdentityId;
  source_path: string;
  display_name: string;
  local_role: ShareRole;
  access?: ShareAccessSnapshot;
  members?: Record<string, ShareMember>;
  pending_invites?: Record<string, PendingShareInvite>;
  member_ops?: SignedShareMemberRosterOp[];
  participant_profiles?: Record<string, NostrIdentityId>;
  app_key_roots?: Record<string, DriveRootRef>;
  roster_ops?: SignedNostrIdentityRosterOp[];
}

export interface ShareShortcut {
  share_id: NostrIdentityId;
  path: string;
  target_path: string;
}

export interface SharedFolderMemberView {
  profile_id: NostrIdentityId;
  role: ShareRole;
  role_label: string;
  status: ShareMemberStatus;
  status_label: string;
  display_name: string;
  representative_npub_hint?: string;
  app_key_count: number;
  can_revoke: boolean;
  can_change_role: boolean;
}

export interface PendingShareInviteView {
  representative_npub_hint: string;
  role: ShareRole;
  role_label: string;
  status: 'pending';
  status_label: string;
  display_name: string;
  created_at: number;
}

export interface SharedFolderView {
  share_id: NostrIdentityId;
  display_name: string;
  source_path: string;
  shared_with_me_path: string;
  local_role: ShareRole;
  local_role_label: string;
  key_status: 'available' | 'repair_needed' | 'key_unavailable' | 'no_key_epoch' | 'not_a_recipient' | 'revoked';
  key_status_label: string;
  write_authorization: ShareRootWriteAuthorization;
  write_authorization_label: string;
  can_write: boolean;
  can_admin: boolean;
  current_key_epoch?: number;
  has_current_key_wrap: boolean;
  key_unavailable: boolean;
  repair_needed: boolean;
  missing_key_wrap_count: number;
  missing_key_wrap_pubkeys: string[];
  participant_count: number;
  app_key_count: number;
  members: SharedFolderMemberView[];
  pending_invites: PendingShareInviteView[];
  shortcut_paths: string[];
}

export interface ShareInviteBundle {
  schema: number;
  shared_folder: SharedFolder;
  recipient_profile_id: NostrIdentityId;
  role: ShareRole;
  representative_npub_hint?: string;
  roster_checkpoint?: SignedShareRosterCheckpoint;
  access_snapshot?: SignedShareAccessSnapshot;
  created_at: number;
}

export interface ShareRosterCheckpointContent {
  schema: number;
  share_id: NostrIdentityId;
  signer_pubkey: string;
  roster_head_op_ids: string[];
  member_roster_head_op_ids?: string[];
  accepted_op_count: number;
  rejected_op_count: number;
  accepted_member_op_count?: number;
  rejected_member_op_count?: number;
  active_app_key_pubkeys: string[];
  tombstoned_app_key_pubkeys: string[];
  current_key_epoch?: number;
  missing_key_wrap_pubkeys?: string[];
  members: SharedFolderMemberView[];
  client_nonce: string;
  created_at: number;
}

export interface SignedShareRosterCheckpoint {
  checkpoint_id: string;
  signer_pubkey: string;
  content: ShareRosterCheckpointContent;
  event_json: string;
}

export interface AppKeyEntry {
  pubkey: string;
  added_at: number;
  label?: string;
}

export interface AppKeysSnapshot {
  owner_pubkey: string;
  created_at: number;
  app_keys: AppKeyEntry[];
  dck_generation: number;
  wrapped_dck: Record<string, string>;
}

export interface RootParent {
  app_key_pubkey?: string;
  app_key_seq?: number;
  device_id?: string;
  device_seq?: number;
  root_cid: string;
}

export interface RootObservation {
  app_key_seq?: number;
  device_seq?: number;
  root_cid: string;
}

export interface DriveRootRef {
  root: CID;
  published_at: number;
  dck_generation: number;
  app_key_seq?: number;
  device_seq: number;
  parents: RootParent[];
  observed: Record<string, RootObservation>;
  materialized_only: false;
}

export interface DriveRootEventPreview {
  app_key_pubkey_hex: string;
  device_pubkey_hex: string;
  root_scope_id: string;
  owner_pubkey_hex: string;
  drive_id: string;
  published_at: number;
  published_at_ms?: number;
  dck_generation: number;
  app_key_seq: number;
  device_seq: number;
}

export interface ParsedDriveRootEvent extends DriveRootEventPreview {
  root: CID;
  rootRef: DriveRootRef;
}

export interface BuildDriveRootEventOptions {
  deviceSecretKey: Uint8Array;
  ownerPubkeyHex?: string;
  rootScopeId?: string;
  driveId: string;
  root: CID;
  dckGeneration: number;
  appKeySeq?: number;
  deviceSeq?: number;
  authorizedDevicePubkeys?: string[];
  authorizedAppKeyPubkeys?: string[];
  publishedAt?: number;
  publishedAtMs?: number;
  parents?: RootParent[];
  observed?: Record<string, RootObservation>;
}

export interface BuildShareRosterCheckpointEventOptions {
  signerSecretKey: Uint8Array;
  folder: SharedFolder;
  createdAt?: number;
  clientNonce?: string;
}

export interface AppKeysWireContent {
  devices: AppKeyEntry[];
  dck_generation?: number;
  wrapped_dck?: Record<string, string>;
}

export interface DriveRootWireContent {
  root_cid?: string;
  root_hash?: string;
  root_key_wraps: Record<string, string>;
  dck_generation: number;
  app_key_seq?: number;
  device_seq?: number;
  parents?: RootParent[];
  observed?: Record<string, RootObservation>;
}
