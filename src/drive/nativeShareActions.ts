import {
  canUseInjectedHtreeServerUrl,
  getInjectedHtreeServerUrl,
} from '../lib/nativeHtree';
import type {
  NostrIdentityId,
  ShareRole,
  ShareShortcut,
} from './protocol';

export type NativeShareAction =
  | { type: 'create_share'; source_path: string; display_name?: string }
  | {
    type: 'invite_share_member';
    share_id: NostrIdentityId;
    profile_id: NostrIdentityId;
    app_key: string;
    role: ShareRole;
    representative_npub_hint?: string;
    display_name?: string;
    label?: string;
  }
  | {
    type: 'invite_share_member_from_evidence';
    share_id: NostrIdentityId;
    evidence_json: string;
    role: ShareRole;
    display_name?: string;
  }
  | {
    type: 'record_pending_share_invite';
    share_id: NostrIdentityId;
    representative_npub_hint: string;
    role: ShareRole;
    display_name?: string;
  }
  | { type: 'accept_share_invite'; invite: string }
  | { type: 'revoke_share_member'; share_id: NostrIdentityId; profile_id: NostrIdentityId; reason?: string }
  | { type: 'set_share_member_role'; share_id: NostrIdentityId; profile_id: NostrIdentityId; role: ShareRole }
  | {
    type: 'add_share_shortcut';
    share_id: NostrIdentityId;
    path?: string;
    parent?: string;
    target_path?: string;
  }
  | { type: 'repair_share_wraps'; share_id: NostrIdentityId };

export interface NativeShareMemberView {
  profile_id: NostrIdentityId;
  role: ShareRole;
  role_label?: string;
  status: 'pending' | 'active' | 'revoked';
  status_label?: string;
  display_name: string;
  representative_npub_hint?: string;
  app_key_count: number;
  can_revoke: boolean;
  can_change_role: boolean;
}

export interface NativePendingShareInviteView {
  representative_npub_hint: string;
  role: ShareRole;
  role_label?: string;
  status: 'pending';
  status_label?: string;
  display_name: string;
  created_at: number;
}

export interface NativeSharedFolderView {
  share_id: NostrIdentityId;
  display_name: string;
  source_path: string;
  shared_with_me_path: string;
  local_role: ShareRole;
  local_role_label?: string;
  role_label?: string;
  current_app_pubkey: string;
  key_status: 'available' | 'repair_needed' | 'key_unavailable' | 'no_key_epoch' | 'not_a_recipient' | 'revoked';
  key_status_label?: string;
  write_authorization: string;
  write_authorization_label?: string;
  can_write: boolean;
  can_admin: boolean;
  current_key_epoch?: number;
  has_current_key_wrap: boolean;
  key_unavailable: boolean;
  repair_needed: boolean;
  missing_key_wrap_count: number;
  missing_key_wraps?: string[];
  missing_key_wrap_pubkeys: string[];
  participant_count: number;
  app_key_count: number;
  members: NativeShareMemberView[];
  pending_invites?: NativePendingShareInviteView[];
  shortcut_paths: string[];
}

export interface NativeShareActionResult {
  shares: NativeSharedFolderView[];
  share_id?: NostrIdentityId;
  profile_id?: NostrIdentityId;
  role?: ShareRole;
  epoch?: number;
  last_share_invite?: string;
  shortcut?: ShareShortcut;
  repaired_key_wrap_count?: number;
  remaining_missing_key_wrap_count?: number;
  revoked_app_pubkeys?: string[];
  repaired_key_wrap_pubkeys?: string[];
  remaining_missing_key_wrap_pubkeys?: string[];
}

const SHARE_ACTION_PATH = '/api/iris-drive/share-action';

export function nativeShareActionEndpoint(): string | null {
  if (canUseInjectedHtreeServerUrl()) {
    const serverUrl = getInjectedHtreeServerUrl();
    return serverUrl ? `${serverUrl.replace(/\/+$/, '')}${SHARE_ACTION_PATH}` : null;
  }
  if (canUseSameOriginShareActions()) {
    return SHARE_ACTION_PATH;
  }
  return null;
}

export function canUseNativeShareActions(): boolean {
  return nativeShareActionEndpoint() !== null;
}

export async function dispatchNativeShareAction(
  action: NativeShareAction,
): Promise<NativeShareActionResult> {
  const endpoint = nativeShareActionEndpoint();
  if (!endpoint) {
    throw new Error('Iris Drive share actions are unavailable');
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(action),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `share action failed with ${response.status}`);
  }
  return JSON.parse(text) as NativeShareActionResult;
}

export async function fetchNativeShareState(): Promise<NativeShareActionResult> {
  const endpoint = nativeShareActionEndpoint();
  if (!endpoint) {
    throw new Error('Iris Drive share actions are unavailable');
  }
  const response = await fetch(endpoint, {
    method: 'GET',
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `share state failed with ${response.status}`);
  }
  return JSON.parse(text) as NativeShareActionResult;
}

function canUseSameOriginShareActions(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.protocol !== 'http:') return false;
  const host = window.location.hostname.toLowerCase();
  return host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host === '[::1]'
    || host.endsWith('.drive.iris.localhost')
    || host.endsWith('.iris.localhost')
    || host.endsWith('.iris.local');
}
