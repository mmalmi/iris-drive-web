import { describe, expect, it } from 'vitest';
import { nhashEncode } from '@hashtree/core';
import { buildSitesHref, findDirectorySiteEntry, isHtmlFilename } from '../src/lib/siteHref';

describe('site href helpers', () => {
  it('roots mutable site links at the current directory and enables auto-reload', () => {
    expect(buildSitesHref({
      route: {
        npub: 'npub1owner',
        treeName: 'public',
        path: ['apps', 'demo', 'index.html'],
        isPermalink: false,
        params: new URLSearchParams(),
      },
      siteRootPath: ['apps', 'demo'],
      entryPath: 'index.html',
      autoReloadMutable: true,
    })).toBe('https://sites.iris.to/#/npub1owner/public%2Fapps%2Fdemo/index.html?reload=1');
  });

  it('falls back to immutable nhash links when the current route is a permalink', () => {
    const cid = {
      hash: new Uint8Array(32).fill(0x11),
      key: new Uint8Array(32).fill(0x22),
    };
    expect(buildSitesHref({
      route: {
        path: ['index.html'],
        isPermalink: true,
        params: new URLSearchParams(),
      },
      siteRootCid: cid,
      entryPath: 'index.html',
      autoReloadMutable: true,
    })).toBe(`https://sites.iris.to/#/${nhashEncode(cid)}/index.html`);
  });

  it('uses immutable links when a tree route depends on a decryption key', () => {
    const cid = {
      hash: new Uint8Array(32).fill(0x33),
    };
    expect(buildSitesHref({
      route: {
        npub: 'npub1owner',
        treeName: 'private-site',
        path: ['index.html'],
        isPermalink: false,
        params: new URLSearchParams('k=abc123'),
      },
      siteRootCid: cid,
      entryPath: 'index.html',
      autoReloadMutable: true,
    })).toBe(`https://sites.iris.to/#/${nhashEncode(cid)}/index.html`);
  });

  it('detects site roots from directory entries', () => {
    expect(findDirectorySiteEntry([
      { name: 'README.md' },
      { name: 'Index.HTM' },
      { name: 'assets' },
    ])).toBe('Index.HTM');
  });

  it('only treats html files as standalone site entries', () => {
    expect(isHtmlFilename('index.html')).toBe(true);
    expect(isHtmlFilename('landing.HTM')).toBe(true);
    expect(isHtmlFilename('notes.md')).toBe(false);
  });
});
