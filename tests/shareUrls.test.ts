import { afterEach, describe, expect, it, vi } from 'vitest';
import { createShareUrlOptions, getCanonicalGitRepositoryUrl } from '../src/lib/shareUrls';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('shareUrls', () => {
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
