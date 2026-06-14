import { describe, expect, it, vi } from 'vitest';
import {
  createShareWithOptionalRecipientEvidence,
  repairShareKeyWraps,
  revokeShareMember,
  setShareMemberRole,
} from '../src/drive/shareDialogActions';
import type { NativeShareActionResult } from '../src/drive/nativeShareActions';

describe('share dialog actions', () => {
  it('creates a share then invites selected recipients by passing evidence to Rust core', async () => {
    const calls: unknown[] = [];
    const dispatch = vi.fn(async (action) => {
      calls.push(action);
      if (action.type === 'create_share') {
        return {
          shares: [],
          share_id: '123e4567-e89b-42d3-a456-426614174000',
        } satisfies NativeShareActionResult;
      }
      return {
        shares: [{
          share_id: '123e4567-e89b-42d3-a456-426614174000',
          display_name: 'Alpha',
          source_path: 'Projects/Alpha',
          shared_with_me_path: 'Shared with me/Alpha',
          local_role: 'admin',
          current_app_pubkey: 'a'.repeat(64),
          key_status: 'available',
          write_authorization: 'authorized',
          can_write: true,
          can_admin: true,
          has_current_key_wrap: true,
          key_unavailable: false,
          repair_needed: false,
          missing_key_wrap_count: 0,
          missing_key_wrap_pubkeys: [],
          participant_count: 2,
          app_key_count: 2,
          members: [],
          shortcut_paths: [],
        }],
      } satisfies NativeShareActionResult;
    });

    const result = await createShareWithOptionalRecipientEvidence(
      {
        source_path: 'Projects/Alpha',
        display_name: 'Alpha',
        app_url: 'iris-drive://share?path=Projects%2FAlpha',
        web_path: '/share?path=Projects%2FAlpha',
      },
      'Alpha',
      {
        representative_npub: 'npub1alice',
        pubkey: 'b'.repeat(64),
        display_name: 'Alice',
        iris_profile_id: '123e4567-e89b-42d3-a456-426614174011',
        linked_npubs: ['npub1alice'],
        recipient_evidence_json: '{"profile_id":"123e4567-e89b-42d3-a456-426614174011"}',
        score: 1,
      },
      dispatch,
    );

    expect(result.invited).toBe(true);
    expect(calls).toEqual([
      {
        type: 'create_share',
        source_path: 'Projects/Alpha',
        display_name: 'Alpha',
      },
      {
        type: 'invite_share_member_from_evidence',
        share_id: '123e4567-e89b-42d3-a456-426614174000',
        evidence_json: '{"profile_id":"123e4567-e89b-42d3-a456-426614174011"}',
        role: 'reader',
        display_name: 'Alice',
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain('"app_key"');
  });

  it('records a pending invite through Rust core when selected contact evidence is missing', async () => {
    const calls: unknown[] = [];
    const dispatch = vi.fn(async (action) => {
      calls.push(action);
      return {
        shares: [],
        share_id: '123e4567-e89b-42d3-a456-426614174000',
      } satisfies NativeShareActionResult;
    });

    const result = await createShareWithOptionalRecipientEvidence(
      {
        source_path: 'Projects/Alpha',
        display_name: 'Alpha',
        app_url: 'iris-drive://share?path=Projects%2FAlpha',
        web_path: '/share?path=Projects%2FAlpha',
      },
      'Alpha',
      {
        representative_npub: 'npub1alice',
        pubkey: 'b'.repeat(64),
        display_name: 'Alice',
        linked_npubs: ['npub1alice'],
        score: 1,
      },
      dispatch,
    );

    expect(result.invited).toBe(true);
    expect(calls).toEqual([
      {
        type: 'create_share',
        source_path: 'Projects/Alpha',
        display_name: 'Alpha',
      },
      {
        type: 'record_pending_share_invite',
        share_id: '123e4567-e89b-42d3-a456-426614174000',
        representative_npub_hint: 'npub1alice',
        role: 'reader',
        display_name: 'Alice',
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain('"app_key"');
  });

  it('repairs missing share key wraps through Rust core share actions', async () => {
    const dispatch = vi.fn(async (action) => {
      expect(action).toEqual({
        type: 'repair_share_wraps',
        share_id: '123e4567-e89b-42d3-a456-426614174000',
      });
      return {
        shares: [],
        share_id: '123e4567-e89b-42d3-a456-426614174000',
        repaired_key_wrap_count: 2,
        remaining_missing_key_wrap_count: 0,
      } satisfies NativeShareActionResult;
    });

    const result = await repairShareKeyWraps(
      '123e4567-e89b-42d3-a456-426614174000',
      dispatch,
    );

    expect(result.repaired_key_wrap_count).toBe(2);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('revokes share members through Rust core share actions', async () => {
    const dispatch = vi.fn(async (action) => {
      expect(action).toEqual({
        type: 'revoke_share_member',
        share_id: '123e4567-e89b-42d3-a456-426614174000',
        profile_id: '123e4567-e89b-42d3-a456-426614174011',
        reason: 'Removed from share',
      });
      return {
        shares: [],
        share_id: '123e4567-e89b-42d3-a456-426614174000',
        profile_id: '123e4567-e89b-42d3-a456-426614174011',
        revoked_app_pubkeys: ['a'.repeat(64)],
      } satisfies NativeShareActionResult;
    });

    const result = await revokeShareMember(
      '123e4567-e89b-42d3-a456-426614174000',
      '123e4567-e89b-42d3-a456-426614174011',
      dispatch,
    );

    expect(result.profile_id).toBe('123e4567-e89b-42d3-a456-426614174011');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('updates share member roles through Rust core share actions', async () => {
    const dispatch = vi.fn(async (action) => {
      expect(action).toEqual({
        type: 'set_share_member_role',
        share_id: '123e4567-e89b-42d3-a456-426614174000',
        profile_id: '123e4567-e89b-42d3-a456-426614174011',
        role: 'editor',
      });
      return {
        shares: [],
        share_id: '123e4567-e89b-42d3-a456-426614174000',
        profile_id: '123e4567-e89b-42d3-a456-426614174011',
        role: 'editor',
      } satisfies NativeShareActionResult;
    });

    const result = await setShareMemberRole(
      '123e4567-e89b-42d3-a456-426614174000',
      '123e4567-e89b-42d3-a456-426614174011',
      'editor',
      dispatch,
    );

    expect(result.role).toBe('editor');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
