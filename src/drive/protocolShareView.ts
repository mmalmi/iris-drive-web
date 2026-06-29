import type { PendingShareInviteView, ShareShortcut, SharedFolder, SharedFolderView } from './protocolTypes';
import { projectNostrIdentityRoster } from './protocolProfileProjection';
import {
  activeShareKeyRecipients,
  shareKeyStatus,
  shareMemberViews,
  sharedFolderAppKeyCanAdmin,
  sharedFolderAppKeyWriteAuthorizationWithProjection,
} from './protocolShareAccess';
import {
  sanitizeProviderName,
  shareKeyStatusLabel,
  shareMemberStatusLabel,
  shareRoleLabel,
  shareRootWriteAuthorizationLabel,
} from './protocolShareBase';

export function projectSharedFolderView(
  folder: SharedFolder,
  shortcuts: ShareShortcut[],
  currentAppKeyPubkey: string,
): SharedFolderView {
  const projection = projectNostrIdentityRoster(folder.share_id, folder.roster_ops ?? []);
  const epochNumbers = Object.keys(projection.secret_epochs).map((epoch) => Number(epoch));
  const currentKeyEpoch = epochNumbers.length ? Math.max(...epochNumbers) : undefined;
  const missing = currentKeyEpoch === undefined
    ? []
    : activeShareKeyRecipients(folder, projection)
      .filter((pubkey) => !projection.secret_epochs[String(currentKeyEpoch)]?.wrapped_secrets[pubkey]);
  const keyStatus = shareKeyStatus(folder, projection, currentAppKeyPubkey, currentKeyEpoch, missing);
  const writeAuthorization = sharedFolderAppKeyWriteAuthorizationWithProjection(
    folder,
    projection,
    currentAppKeyPubkey,
  );
  const canAdmin = sharedFolderAppKeyCanAdmin(folder, projection, currentAppKeyPubkey);
  const localRole = canAdmin ? 'admin' : writeAuthorization === 'authorized' ? 'editor' : 'reader';
  const members = shareMemberViews(folder, projection, currentAppKeyPubkey, canAdmin);
  const shortcutPaths = shortcuts
    .filter((shortcut) => shortcut.share_id === folder.share_id)
    .map((shortcut) => shortcut.path)
    .sort();
  return {
    share_id: folder.share_id,
    display_name: folder.display_name,
    source_path: folder.source_path,
    shared_with_me_path: `Shared with me/${sanitizeProviderName(folder.display_name)}`,
    local_role: localRole,
    local_role_label: shareRoleLabel(localRole),
    key_status: keyStatus,
    key_status_label: shareKeyStatusLabel(keyStatus),
    write_authorization: writeAuthorization,
    write_authorization_label: shareRootWriteAuthorizationLabel(writeAuthorization),
    can_write: writeAuthorization === 'authorized',
    can_admin: canAdmin,
    current_key_epoch: currentKeyEpoch,
    has_current_key_wrap: keyStatus === 'available' || keyStatus === 'repair_needed',
    key_unavailable: keyStatus === 'key_unavailable',
    repair_needed: missing.length > 0,
    missing_key_wrap_count: missing.length,
    missing_key_wrap_pubkeys: missing,
    participant_count: members.filter((member) => member.status === 'active').length,
    app_key_count: Object.keys(projection.active_facets).length,
    members,
    pending_invites: pendingShareInviteViews(folder),
    shortcut_paths: shortcutPaths,
  };
}

function pendingShareInviteViews(folder: SharedFolder): PendingShareInviteView[] {
  return Object.values(folder.pending_invites ?? {})
    .map((invite) => ({
      representative_npub_hint: invite.representative_npub_hint,
      role: invite.role,
      role_label: shareRoleLabel(invite.role),
      status: 'pending' as const,
      status_label: shareMemberStatusLabel('pending'),
      display_name: invite.display_name?.trim() || invite.representative_npub_hint,
      created_at: invite.created_at,
    }))
    .sort((a, b) => (
      a.display_name.localeCompare(b.display_name)
      || a.representative_npub_hint.localeCompare(b.representative_npub_hint)
    ));
}
