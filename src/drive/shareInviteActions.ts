import {
  dispatchNativeShareAction,
  type NativeShareActionResult,
} from './nativeShareActions';

export type ShareInviteDispatch = typeof dispatchNativeShareAction;

export async function acceptShareInviteThroughCore(
  invite: string,
  dispatch: ShareInviteDispatch = dispatchNativeShareAction,
): Promise<NativeShareActionResult> {
  return dispatch({
    type: 'accept_share_invite',
    invite,
  });
}

export async function addShareShortcutThroughCore(
  shareId: string,
  dispatch: ShareInviteDispatch = dispatchNativeShareAction,
): Promise<NativeShareActionResult> {
  return dispatch({
    type: 'add_share_shortcut',
    share_id: shareId,
  });
}
