// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { generateProxyUrlAsyncMock, getNpubFileUrlMock } = vi.hoisted(() => ({
  generateProxyUrlAsyncMock: vi.fn(),
  getNpubFileUrlMock: vi.fn((npub: string, treeName: string, path: string) => {
    const encodedTreeName = encodeURIComponent(treeName);
    const encodedPath = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    return `/htree/${npub}/${encodedTreeName}${encodedPath ? `/${encodedPath}` : ''}?htree_c=test-client`;
  }),
}));

vi.mock('../src/utils/imgproxy', async () => {
  const actual = await vi.importActual<typeof import('../src/utils/imgproxy')>('../src/utils/imgproxy');
  return {
    ...actual,
    generateProxyUrlAsync: generateProxyUrlAsyncMock,
  };
});

vi.mock('../src/lib/mediaUrl', () => ({
  getNpubFileUrl: getNpubFileUrlMock,
}));

import { renderMarkdownHtml } from '../src/lib/markdown';

describe('renderMarkdownHtml', () => {
  beforeEach(() => {
    generateProxyUrlAsyncMock.mockReset();
    getNpubFileUrlMock.mockClear();
  });

  it('rewrites repo-relative links to hash routes', async () => {
    const html = await renderMarkdownHtml('[Guide](docs/intro.md)', {
      routeContext: {
        npub: 'npub1example',
        treeName: 'repo',
        basePath: ['guides'],
      },
    });

    expect(html).toContain('href="#/npub1example/repo/guides/docs/intro.md"');
  });

  it('lets callers rewrite markdown links before repo-relative routing', async () => {
    const html = await renderMarkdownHtml('[Download](assets/app.dmg)', {
      routeContext: {
        npub: 'npub1example',
        treeName: 'repo',
        basePath: [],
      },
      resolveLinkHref: href => href === 'assets/app.dmg'
        ? '/htree/nhash1asset/app.dmg?download=1'
        : null,
    });

    expect(html).toContain('href="/htree/nhash1asset/app.dmg?download=1"');
    expect(html).not.toContain('href="#/npub1example/repo/assets/app.dmg"');
  });

  it('rewrites repo-relative markdown images to htree media URLs', async () => {
    const html = await renderMarkdownHtml('![Preview](public/squirreldisk.png)', {
      routeContext: {
        npub: 'npub1example',
        treeName: 'repo',
        basePath: [],
      },
    });

    expect(html).toContain('src="/htree/npub1example/repo/public/squirreldisk.png?htree_c=test-client"');
  });

  it('resolves nested relative markdown images against the markdown file directory', async () => {
    const html = await renderMarkdownHtml('![Preview](../assets/preview%20image.png)', {
      routeContext: {
        npub: 'npub1example',
        treeName: 'repo',
        basePath: ['docs', 'guides'],
      },
    });

    expect(html).toContain('src="/htree/npub1example/repo/docs/assets/preview%20image.png?htree_c=test-client"');
  });

  it('resolves root-relative markdown images from the tree root', async () => {
    const html = await renderMarkdownHtml('![Preview](/public/squirreldisk.png)', {
      routeContext: {
        npub: 'npub1example',
        treeName: 'repo',
        basePath: ['docs'],
      },
    });

    expect(html).toContain('src="/htree/npub1example/repo/public/squirreldisk.png?htree_c=test-client"');
  });

  it('does not proxy htree markdown images', async () => {
    const html = await renderMarkdownHtml('![Preview](/htree/npub1example/repo/public/squirreldisk.png)', {
      proxyRemoteImages: true,
    });

    expect(html).toContain('src="/htree/npub1example/repo/public/squirreldisk.png"');
    expect(generateProxyUrlAsyncMock).not.toHaveBeenCalled();
  });

  it('proxies remote markdown images when imgproxy is enabled', async () => {
    generateProxyUrlAsyncMock.mockResolvedValue('https://imgproxy.iris.to/example');

    const html = await renderMarkdownHtml('![Preview](https://example.com/image.png)', {
      proxyRemoteImages: true,
    });

    expect(html).toContain('src="https://imgproxy.iris.to/example"');
    expect(html).not.toContain('src="https://example.com/image.png"');
    expect(generateProxyUrlAsyncMock).toHaveBeenCalledWith('https://example.com/image.png', {}, undefined);
  });

  it('blocks remote markdown images when imgproxy is disabled', async () => {
    const html = await renderMarkdownHtml('![Preview](https://example.com/image.png)');

    expect(html).toContain('[remote image blocked: Preview]');
    expect(html).not.toContain('<img');
    expect(generateProxyUrlAsyncMock).not.toHaveBeenCalled();
  });

  it('blocks remote markdown images when proxy generation falls back to the original URL', async () => {
    generateProxyUrlAsyncMock.mockResolvedValue('https://example.com/image.png');

    const html = await renderMarkdownHtml('![Preview](https://example.com/image.png)', {
      proxyRemoteImages: true,
    });

    expect(html).toContain('[remote image blocked: Preview]');
    expect(html).not.toContain('<img');
  });
});
