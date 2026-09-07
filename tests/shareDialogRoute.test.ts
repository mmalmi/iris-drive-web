import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildShareDialogRequest,
  parseShareDialogPath,
  shareDialogRequestWithRecipientHint,
} from '../src/drive/shareDialog';

const appRoot = path.resolve(__dirname, '..');

describe('share dialog route', () => {
  it('parses drive.iris.to share paths into native app handoff URLs', () => {
    const parsed = parseShareDialogPath('/share?path=My%20Drive%2FProjects&name=Projects');

    expect(parsed).toEqual({
      source_path: 'My Drive/Projects',
      display_name: 'Projects',
      app_url: 'iris-drive://share?path=My+Drive%2FProjects&name=Projects',
      web_path: '/share?path=My+Drive%2FProjects&name=Projects',
    });
    expect(parseShareDialogPath('https://drive.iris.to/share?path=%2FShared+Source')?.source_path)
      .toBe('/Shared Source');
    expect(parseShareDialogPath('iris-drive://share?path=Projects%2FAlpha')?.app_url)
      .toBe('iris-drive://share?path=Projects%2FAlpha');
    expect(parseShareDialogPath('/share?name=Missing')).toBeNull();
    expect(buildShareDialogRequest('  Photos  ', '  Trip  ')?.web_path)
      .toBe('/share?path=Photos&name=Trip');
  });

  it('adds selected recipient hints to handoff URLs without granting authority', () => {
    const request = buildShareDialogRequest('Projects/Alpha', 'Alpha');
    expect(request).not.toBeNull();

    const hinted = shareDialogRequestWithRecipientHint(request!, {
      representative_npub: 'npub1alice',
      display_name: 'Alice',
      nostr_identity_id: '123e4567-e89b-42d3-a456-426614174000',
    });

    expect(hinted.app_url).toBe(
      'iris-drive://share?path=Projects%2FAlpha&name=Alpha&recipient_npub=npub1alice&recipient_name=Alice&recipient_profile=123e4567-e89b-42d3-a456-426614174000',
    );
    expect(hinted.web_path).toContain('recipient_npub=npub1alice');
  });

  it('routes share dialog links without treating them as identity authority', () => {
    const router = fs.readFileSync(path.join(appRoot, 'src/components/Router.svelte'), 'utf8');
    const route = fs.readFileSync(path.join(appRoot, 'src/routes/ShareDialogRoute.svelte'), 'utf8');
    const actions = fs.readFileSync(path.join(appRoot, 'src/drive/shareDialogActions.ts'), 'utf8');

    expect(router).toContain("{ pattern: '/share', id: 'shareDialog' }");
    expect(router).toContain('<ShareDialogRoute />');
    expect(route).toContain('parseShareDialogPath');
    expect(route).toContain('searchShareContacts');
    expect(route).toContain('nativeShareActionEndpoint');
    expect(route).toContain('createShareWithOptionalRecipientEvidence');
    expect(route).toContain('repairShareKeyWraps');
    expect(route).toContain('revokeShareMember');
    expect(route).toContain('setShareMemberRole');
    expect(route).toContain('shareDialogRequestWithRecipientHint');
    expect(route).toContain('data-testid="share-dialog-recipient-search"');
    expect(route).toContain('data-testid="share-dialog-create-share"');
    expect(route).toContain('data-testid="share-dialog-repair-wraps"');
    expect(route).toContain('data-testid="share-dialog-revoke-member"');
    expect(route).toContain('data-testid="share-dialog-member-role"');
    expect(route).toContain('data-testid="share-dialog-pending-invite-row"');
    expect(route).toContain('data-testid="share-dialog-open-native"');
    expect(route).toContain('testId="share-dialog-copy-native-url"');
    expect(route).toContain('shareRepairText(createdShare)');
    expect(route).toContain('shareRoleLabel(createdShare)');
    expect(route).toContain('shareKeyStatusLabel(createdShare)');
    expect(route).toContain('shareMemberDetail(member)');
    expect(route).not.toContain('member.representative_npub_hint || member.profile_id');
    expect(route).not.toContain('${member.profile_id}');
    expect(route).not.toContain('createdShare.missing_key_wrap_pubkeys.join');
    expect(actions).toContain('dispatchNativeShareAction');
    expect(actions).toContain("type: 'create_share'");
    expect(actions).toContain("type: 'invite_share_member_from_evidence'");
    expect(actions).toContain("type: 'record_pending_share_invite'");
    expect(actions).toContain("type: 'repair_share_wraps'");
    expect(actions).toContain("type: 'revoke_share_member'");
    expect(actions).toContain("type: 'set_share_member_role'");
    expect(actions).toContain('recipient_evidence_json');
    expect(actions).toContain("role: 'reader'");
    expect(route).not.toContain('function createShare(');
    expect(route).not.toContain('function inviteShare(');
    expect(actions).not.toContain("type: 'invite_share_member'");
    expect(actions).not.toContain('app_key:');
  });

  it('keeps direct drive.iris.to share paths routable on first load', () => {
    const routerStore = fs.readFileSync(path.join(appRoot, 'src/lib/router.svelte.ts'), 'utf8');

    expect(routerStore).toContain("pathname === '/share'");
    expect(routerStore).toContain("pathname.startsWith('/share-invite/')");
    expect(routerStore).toContain('return `${window.location.pathname}${window.location.search}`;');
  });
});
