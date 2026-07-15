import { describe, expect, it } from 'vitest';
import { shouldShowNhashFileBrowser } from '../src/lib/nhashRouteLayout';
import { matchDirectContentRoute } from '../src/lib/directContentRoute';

const FILE_NHASH = 'nhash1qqsyktrn6c5r444rhjt2qfv6a6uu5hcsrlcvk202whqhxyk3fwkl83s9yr8ngvg5489t2sqnpzqyk7um2ug688j42y57375qex7vgpc384vdv9mr60t';

describe('shouldShowNhashFileBrowser', () => {
  it('hides the directory browser for a direct nhash file', () => {
    expect(shouldShowNhashFileBrowser({
      isFullscreen: false,
      isViewingFile: true,
    })).toBe(false);
  });

  it('keeps the browser for an nhash directory', () => {
    expect(shouldShowNhashFileBrowser({
      isFullscreen: false,
      isViewingFile: false,
    })).toBe(true);
  });

  it('hides all browser chrome in fullscreen mode', () => {
    expect(shouldShowNhashFileBrowser({
      isFullscreen: true,
      isViewingFile: false,
    })).toBe(false);
  });
});

describe('matchDirectContentRoute', () => {
  it('routes an nhash filename before the generic npub/tree pattern', () => {
    expect(matchDirectContentRoute(`/${FILE_NHASH}/freenet.pdf`)).toEqual({
      id: FILE_NHASH,
      wild: 'freenet.pdf',
    });
  });

  it('leaves ordinary tree routes to the generic router', () => {
    expect(matchDirectContentRoute('/npub1example/main/file.pdf')).toBeNull();
  });
});
