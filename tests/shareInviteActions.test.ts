import { describe, expect, it, vi } from 'vitest';
import {
  acceptShareInviteThroughCore,
  addShareShortcutThroughCore,
} from '../src/drive/shareInviteActions';
import type { NativeShareActionResult } from '../src/drive/nativeShareActions';

describe('share invite actions', () => {
  it('accepts share invites through Rust core share actions', async () => {
    const dispatch = vi.fn(async (action) => {
      expect(action).toEqual({
        type: 'accept_share_invite',
        invite: 'iris-drive://share-invite/payload',
      });
      return {
        shares: [],
        share_id: '123e4567-e89b-42d3-a456-426614174000',
      } satisfies NativeShareActionResult;
    });

    const result = await acceptShareInviteThroughCore(
      'iris-drive://share-invite/payload',
      dispatch,
    );

    expect(result.share_id).toBe('123e4567-e89b-42d3-a456-426614174000');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('adds share shortcuts through Rust core share actions', async () => {
    const dispatch = vi.fn(async (action) => {
      expect(action).toEqual({
        type: 'add_share_shortcut',
        share_id: '123e4567-e89b-42d3-a456-426614174000',
      });
      return {
        shares: [],
        share_id: '123e4567-e89b-42d3-a456-426614174000',
        shortcut: {
          share_id: '123e4567-e89b-42d3-a456-426614174000',
          path: 'My Drive/Alpha',
          target_path: 'Shared with me/Alpha',
        },
      } satisfies NativeShareActionResult;
    });

    const result = await addShareShortcutThroughCore(
      '123e4567-e89b-42d3-a456-426614174000',
      dispatch,
    );

    expect(result.shortcut?.path).toBe('My Drive/Alpha');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
