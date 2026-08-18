import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const appRoot = path.resolve(__dirname, '..');

describe('share invite route', () => {
  it('routes share invite payloads to the Iris Drive invite view', () => {
    const router = fs.readFileSync(path.join(appRoot, 'src/components/Router.svelte'), 'utf8');
    const route = fs.readFileSync(path.join(appRoot, 'src/routes/ShareInviteRoute.svelte'), 'utf8');

    expect(router).toContain("{ pattern: '/share-invite/:payload', id: 'shareInvite' }");
    expect(router).toContain('<ShareInviteRoute payload={route.params.payload || \'\'} />');
    expect(route).toContain('projectSharedFolderView');
    expect(route).toContain('SHARE_INVITE_PREFIX');
    expect(route).toContain('nativeShareActionEndpoint');
    expect(route).toContain('acceptShareInviteThroughCore');
    expect(route).toContain('addShareShortcutThroughCore');
    expect(route).toContain('acceptShareInvite');
    expect(route).toContain('data-testid="share-invite-accept"');
    expect(route).toContain('data-testid="share-invite-add-shortcut"');
    expect(route).toContain('inviteDetail');
    expect(route).not.toContain('{parsed.bundle.recipient_profile_id}');
  });

  it('keeps direct drive.iris.to share invite paths routable on first load', () => {
    const routerStore = fs.readFileSync(path.join(appRoot, 'src/lib/router.svelte.ts'), 'utf8');

    expect(routerStore).toContain('directPathIsRoutable(window.location.pathname)');
    expect(routerStore).toContain("pathname.startsWith('/share-invite/')");
    expect(routerStore).toContain('return `${window.location.pathname}${window.location.search}`;');
  });

  it('surfaces accepted share records from the main drive folder list', () => {
    const fileBrowserTreeList = fs.readFileSync(path.join(appRoot, 'src/components/FileBrowserTreeList.svelte'), 'utf8');
    const sharedPanel = fs.readFileSync(path.join(appRoot, 'src/components/SharedWithMePanel.svelte'), 'utf8');

    expect(fileBrowserTreeList).toContain('SharedWithMePanel');
    expect(sharedPanel).toContain('data-testid="shared-with-me-panel"');
    expect(sharedPanel).toContain('nativeShareActionEndpoint');
    expect(sharedPanel).toContain('refreshNativeShareState');
    expect(sharedPanel).toContain('addShareShortcutThroughCore');
    expect(sharedPanel).toContain('projectAcceptedShareViews');
    expect(sharedPanel).toContain('addShareShortcut');
  });

  it('renders core-owned share source and repair metadata in Shared with me', () => {
    const sharedPanel = fs.readFileSync(path.join(appRoot, 'src/components/SharedWithMePanel.svelte'), 'utf8');

    expect(sharedPanel).toContain('share.source_path');
    expect(sharedPanel).toContain('share.participant_count');
    expect(sharedPanel).toContain('share.missing_key_wrap_count');
    expect(sharedPanel).toContain("'role_label' in share");
    expect(sharedPanel).toContain("'key_status_label' in share");
    expect(sharedPanel).not.toContain('share.missing_key_wrap_pubkeys.join');
  });
});
