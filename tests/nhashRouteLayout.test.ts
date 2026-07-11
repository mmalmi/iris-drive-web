import { describe, expect, it } from 'vitest';
import { shouldShowNhashFileBrowser } from '../src/lib/nhashRouteLayout';

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
