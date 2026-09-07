import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDriveShareLinkVariants,
  createShareUrlOptions,
  getCanonicalGitRepositoryUrl,
} from '../src/lib/shareUrls';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shareUrls', () => {
  it('shares profile-scoped files only through their immutable snapshot URL', () => {
    const profileId = '89f3d04f-41fb-437b-9339-75df537bf291';
    const permalinkUrl = '#/nhash1revision/squirreldisk.png';

    expect(createDriveShareLinkVariants({
      permalinkUrl,
      currentUrl: `https://drive.iris.to/#/${profileId}/main/squirreldisk.png`,
      routeScope: profileId,
      isPermalink: false,
    })).toEqual([
      {
        id: 'snapshot',
        label: 'Snapshot',
        url: permalinkUrl,
      },
    ]);
  });

  it('offers both the immutable snapshot and mutable latest URL for public npub routes', () => {
    expect(createDriveShareLinkVariants({
      permalinkUrl: '#/nhash1revision/share.txt',
      currentUrl: 'https://drive.iris.to/#/npub1owner/main/share.txt?edit=1',
      routeScope: 'npub1owner',
      isPermalink: false,
    })).toEqual([
      {
        id: 'snapshot',
        label: 'Snapshot',
        url: '#/nhash1revision/share.txt',
      },
      {
        id: 'latest',
        label: 'Latest',
        url: 'https://drive.iris.to/#/npub1owner/main/share.txt',
      },
    ]);
  });

  it('does not expose a profile UUID while its permalink is still resolving', () => {
    const profileId = '89f3d04f-41fb-437b-9339-75df537bf291';

    expect(createDriveShareLinkVariants({
      permalinkUrl: null,
      currentUrl: `https://drive.iris.to/#/${profileId}/main/squirreldisk.png`,
      routeScope: profileId,
      isPermalink: false,
    })).toEqual([]);
  });

  it('maps hosted drive routes to web and htree app URLs', () => {
    expect(createShareUrlOptions('files', 'https://drive.iris.to/#/npub1owner/main/share.txt?k=abc')).toEqual([
      {
        id: 'web',
        label: 'Web URL',
        url: 'https://drive.iris.to/#/npub1owner/main/share.txt?k=abc',
      },
      {
        id: 'htree',
        label: 'htree URL',
        url: 'htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/drive#/npub1owner/main/share.txt?k=abc',
      },
    ]);
  });

  it('uses the default app URLs at the app root', () => {
    expect(createShareUrlOptions('files', 'http://localhost:5173/#/')).toEqual([
      {
        id: 'web',
        label: 'Web URL',
        url: 'https://drive.iris.to',
      },
      {
        id: 'htree',
        label: 'htree URL',
        url: 'htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/drive',
      },
    ]);
  });

  it('builds canonical source repository URLs for web contexts by default', () => {
    expect(getCanonicalGitRepositoryUrl()).toBe(
      'https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-drive-web',
    );
    expect(getCanonicalGitRepositoryUrl('iris-drive-web/src')).toBe(
      'https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-drive-web/src',
    );
  });

  it('uses htree repository URLs when running inside Iris native or an htree page', () => {
    vi.stubGlobal('window', {
      __HTREE_SERVER_URL__: 'http://127.0.0.1:21417',
      location: {
        protocol: 'https:',
        hostname: 'drive.iris.to',
        search: '',
      },
    });

    expect(getCanonicalGitRepositoryUrl()).toBe(
      'htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/git/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-drive-web',
    );

    vi.stubGlobal('window', {
      location: {
        protocol: 'htree:',
        hostname: 'self',
        search: '',
      },
    });

    expect(getCanonicalGitRepositoryUrl('iris-drive-web/src')).toBe(
      'htree://npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/git/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/iris-drive-web/src',
    );
  });
});
