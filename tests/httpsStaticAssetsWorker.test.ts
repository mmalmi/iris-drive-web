import { describe, expect, it, vi } from 'vitest';
import worker from '../scripts/https-static-assets-worker.mjs';

describe('HTTPS static assets Worker', () => {
  it('redirects plain HTTP requests to the same HTTPS URL', async () => {
    const response = await worker.fetch(
      new Request('http://drive.iris.to/#/demo'),
      { ASSETS: { fetch: vi.fn() } },
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://drive.iris.to/#/demo');
  });

  it('redirects requests marked as HTTP by Cloudflare forwarding headers', async () => {
    const response = await worker.fetch(
      new Request('https://drive.iris.to/', {
        headers: { 'cf-visitor': '{"scheme":"http"}' },
      }),
      { ASSETS: { fetch: vi.fn() } },
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://drive.iris.to/');
  });

  it('redirects Cloudflare requests with no TLS version', async () => {
    const request = new Request('https://drive.iris.to/');
    Object.defineProperty(request, 'cf', {
      value: {},
    });

    const response = await worker.fetch(
      request,
      { ASSETS: { fetch: vi.fn() } },
    );

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://drive.iris.to/');
  });

  it('serves HTTPS requests from static assets', async () => {
    const assetResponse = new Response('drive');
    const fetch = vi.fn().mockResolvedValue(assetResponse);

    const response = await worker.fetch(
      new Request('https://drive.iris.to/'),
      { ASSETS: { fetch } },
    );

    expect(response).toBe(assetResponse);
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('Drive links opened in the address bar', () => {
  it.each(['/approve-device/AbC_123-x', '/share-invite/Invite', '/share-join/Join', '/share?path=Photos%2FTrip&name=Trip'])(
    'opens %s in the root app shell', async (path) => {
      const fetch = vi.fn();
      const response = await worker.fetch(new Request('https://drive.iris.to' + path), { ASSETS: { fetch } });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe('https://drive.iris.to/#' + path);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each(['/approve-device-extra/code', '/assets/missing.js', '/htree/nhash/file.jpg'])(
    'leaves %s to the original asset handler', async (path) => {
      const asset = new Response(null, { status: 404 });
      const request = new Request('https://drive.iris.to' + path);
      const fetch = vi.fn().mockResolvedValue(asset);
      expect(await worker.fetch(request, { ASSETS: { fetch } })).toBe(asset);
      expect(fetch).toHaveBeenCalledWith(request);
    },
  );
});
