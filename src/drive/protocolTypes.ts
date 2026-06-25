import type { CID } from '@hashtree/core';

export const KIND_APP_KEYS = 30078;
export const KIND_DRIVE_ROOT = 30078;
// Legacy parse-only device-link request kind. New requests are identity fact events.
export const KIND_APP_KEY_LINK_REQUEST = 30078;
export const KIND_LEGACY_DRIVE_ROOT = 30079;
export const D_TAG_APP_KEYS = 'iris-drive/app-keys';
export const KIND_IRIS_PROFILE_ROSTER_OP = 7368;
export const KIND_IRIS_PROFILE_FACET_ACCEPTANCE = 7368;
export const KIND_SHARE_MEMBER_ROSTER_OP = 30078;
export const KIND_SHARE_ROSTER_CHECKPOINT = 30078;
export const SHARE_INVITE_PREFIX = 'iris-drive://share-invite/';
export const IRIS_PROFILE_ROSTER_SCHEMA = 1;
export const IRIS_PROFILE_FACET_ACCEPTANCE_SCHEMA = 1;
export const SHARE_MEMBER_ROSTER_SCHEMA = 1;
export const SHARE_ROSTER_CHECKPOINT_SCHEMA = 1;

export type IrisProfileId = string;
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
export type IrisProfileKeyPurpose =
  | 'app_key'
  | 'recovery_phrase'
  | 'nip46_signer'
  | 'social_profile';

export interface IrisProfileCapabilities {
  can_write_roots?: boolean;
  can_admin_profile?: boolean;
  can_recover_app_keys?: boolean;
  can_receive_key_wraps?: boolean;
  can_decrypt_key_epochs?: boolean;
}

export interface IrisProfileFacet {
  pubkey: string;
  profile_id?: IrisProfileId;
  purposes?: IrisProfileKeyPurpose[];
  capabilities?: IrisProfileCapabilities;
  added_at: number;
  label?: string;
}

export interface IrisProfileKeyEpoch {
  epoch: number;
  created_at: number;
  signed_by_pubkey: string;
  wrapped_dck: Record<string, string>;
}

export interface IrisProfileTombstone {
  pubkey: string;
  profile_id?: IrisProfileId;
  removed_by_pubkey: string;
  removed_at: number;
  reason?: string;
}

export type IrisProfileRosterOp =
  | { op: 'add_facet'; facet: IrisProfileFacet }
  | { op: 'tombstone_facet'; pubkey: string; reason?: string }
  | { op: 'set_capabilities'; pubkey: string; capabilities: IrisProfileCapabilities }
  | { op: 'rotate_key_epoch'; epoch: number; wrapped_dck?: Record<string, string> }
  | { op: 'repair_key_wraps'; epoch: number; wrapped_dck?: Record<string, string> };

export interface IrisProfileRosterOpContent {
  schema: number;
  profile_id: IrisProfileId;
  actor_pubkey: string;
  actor_seq?: number;
  parents?: string[];
  client_nonce: string;
  created_at: number;
  op: IrisProfileRosterOp;
}

export interface SignedIrisProfileRosterOp {
  op_id: string;
  signer_pubkey: string;
  content: IrisProfileRosterOpContent;
  event_json: string;
}

export interface IrisProfileFacetAcceptanceContent {
  schema: number;
  profile_id: IrisProfileId;
  facet_pubkey: string;
  purposes: IrisProfileKeyPurpose[];
  roster_op_id?: string;
  client_nonce: string;
  accepted_at: number;
}

export interface SignedIrisProfileFacetAcceptance {
  acceptance_id: string;
  signer_pubkey: string;
  content: IrisProfileFacetAcceptanceContent;
  event_json: string;
}

export interface IrisProfileRosterProjection {
  profile_id: IrisProfileId;
  active_facets: Record<string, IrisProfileFacet>;
  tombstones: Record<string, IrisProfileTombstone>;
  key_epochs: Record<string, IrisProfileKeyEpoch>;
  accepted_op_ids: string[];
  rejected_op_ids: string[];
}

export interface ShareMember {
  profile_id: IrisProfileId;
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
  | { op: 'set_member_role'; profile_id: IrisProfileId; role: ShareRole }
  | { op: 'revoke_member'; profile_id: IrisProfileId; reason?: string };

export interface ShareMemberRosterOpContent {
  schema: number;
  share_id: IrisProfileId;
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
  share_id: IrisProfileId;
  members: Record<string, ShareMember>;
  accepted_op_ids: string[];
  rejected_op_ids: string[];
}

export interface ShareRecipient {
  profile_id: IrisProfileId;
  app_pubkey: string;
  role: ShareRole;
  label?: string;
  representative_npub_hint?: string;
  display_name?: string;
}

export interface ResolvedShareRecipient {
  profile_id: IrisProfileId;
  representative_pubkey: string;
  representative_npub: string;
  display_name?: string;
  app_pubkeys: string[];
  linked_social_pubkeys: string[];
}

export interface ShareRecipientProfileEvidence {
  profile_id: IrisProfileId;
  representative_pubkey?: string;
  representative_npub?: string;
  display_name?: string;
  roster_ops?: SignedIrisProfileRosterOp[];
  acceptances?: SignedIrisProfileFacetAcceptance[];
  facet_acceptances?: SignedIrisProfileFacetAcceptance[];
}

export interface SharedFolder {
  share_id: IrisProfileId;
  owner_profile_id: IrisProfileId;
  source_path: string;
  display_name: string;
  local_role: ShareRole;
  members?: Record<string, ShareMember>;
  pending_invites?: Record<string, PendingShareInvite>;
  member_ops?: SignedShareMemberRosterOp[];
  participant_profiles?: Record<string, IrisProfileId>;
  app_key_roots?: Record<string, DriveRootRef>;
  roster_ops?: SignedIrisProfileRosterOp[];
}

export interface ShareShortcut {
  share_id: IrisProfileId;
  path: string;
  target_path: string;
}

export interface SharedFolderMemberView {
  profile_id: IrisProfileId;
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
  share_id: IrisProfileId;
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
  recipient_profile_id: IrisProfileId;
  role: ShareRole;
  representative_npub_hint?: string;
  roster_checkpoint?: SignedShareRosterCheckpoint;
  created_at: number;
}

export interface ShareRosterCheckpointContent {
  schema: number;
  share_id: IrisProfileId;
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
  parents?: RootParent[];
  observed?: Record<string, RootObservation>;
}

export interface BuildIrisProfileRosterOpEventOptions {
  signerSecretKey: Uint8Array;
  profileId: IrisProfileId;
  op: IrisProfileRosterOp;
  parents?: string[];
  actorSeq?: number;
  createdAt?: number;
  clientNonce?: string;
}

export interface BuildIrisProfileFacetAcceptanceEventOptions {
  signerSecretKey: Uint8Array;
  profileId: IrisProfileId;
  purposes: IrisProfileKeyPurpose[];
  rosterOpId?: string;
  acceptedAt?: number;
  clientNonce?: string;
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
