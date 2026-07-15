import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const appRoot = path.resolve(__dirname, '..');

describe('Drive UI identity labels', () => {
  it('renders a human-friendly identity name instead of a profile UUID', () => {
    const browser = fs.readFileSync(path.join(appRoot, 'src/components/FileBrowser.svelte'), 'utf8');
    const treeList = fs.readFileSync(path.join(appRoot, 'src/components/FileBrowserTreeList.svelte'), 'utf8');

    for (const source of [browser, treeList]) {
      expect(source).toContain('<IdentityName');
      expect(source).not.toContain('{viewedNostrIdentityId}</span>');
      expect(source).not.toContain('title={viewedNostrIdentityId}');
    }

    const profile = fs.readFileSync(path.join(appRoot, 'src/components/ProfileView.svelte'), 'utf8');
    expect(profile).toContain('{#if !viewedNostrIdentityId}');
    expect(profile).toContain('<IdentityName profileId={viewedNostrIdentityId}');
  });
});
