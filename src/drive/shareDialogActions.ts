import type { RankedShareContact } from './shareContacts';
import type { ShareDialogRequest } from './shareDialog';
import type { ShareRole } from './protocol';
import {
  dispatchNativeShareAction,
  type NativeShareActionResult,
} from './nativeShareActions';

export interface ShareDialogMutationResult {
  result: NativeShareActionResult;
  share_id: string;
  invited: boolean;
}

export type ShareDialogDispatch = typeof dispatchNativeShareAction;

export async function createShareWithOptionalRecipientEvidence(
  request: ShareDialogRequest,
  displayName: string,
  recipient: RankedShareContact | null,
  dispatch: ShareDialogDispatch = dispatchNativeShareAction,
): Promise<ShareDialogMutationResult> {
  let result = await dispatch({
    type: 'create_share',
    source_path: request.source_path,
    display_name: displayName,
  });
  const shareId = result.share_id ?? result.shares.at(-1)?.share_id ?? '';
  const evidenceJson = recipient?.recipient_evidence_json;
  if (shareId && evidenceJson) {
    result = await dispatch({
      type: 'invite_share_member_from_evidence',
      share_id: shareId,
      evidence_json: evidenceJson,
      role: 'reader',
      display_name: recipient.display_name,
    });
  } else if (shareId && recipient?.representative_npub) {
    result = await dispatch({
      type: 'record_pending_share_invite',
      share_id: shareId,
      representative_npub_hint: recipient.representative_npub,
      role: 'reader',
      display_name: recipient.display_name,
    });
  }
  return {
    result,
    share_id: shareId,
    invited: Boolean(shareId && recipient),
  };
}

export async function repairShareKeyWraps(
  shareId: string,
  dispatch: ShareDialogDispatch = dispatchNativeShareAction,
): Promise<NativeShareActionResult> {
  return dispatch({
    type: 'repair_share_wraps',
    share_id: shareId,
  });
}

export async function revokeShareMember(
  shareId: string,
  profileId: string,
  dispatch: ShareDialogDispatch = dispatchNativeShareAction,
): Promise<NativeShareActionResult> {
  return dispatch({
    type: 'revoke_share_member',
    share_id: shareId,
    profile_id: profileId,
    reason: 'Removed from share',
  });
}

export async function setShareMemberRole(
  shareId: string,
  profileId: string,
  role: ShareRole,
  dispatch: ShareDialogDispatch = dispatchNativeShareAction,
): Promise<NativeShareActionResult> {
  return dispatch({
    type: 'set_share_member_role',
    share_id: shareId,
    profile_id: profileId,
    role,
  });
}
