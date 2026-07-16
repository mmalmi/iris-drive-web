import { expect, test } from './fixtures';
import { evaluateWithRetry, waitForAppReady, waitForWorkerAdapter } from './test-utils';

test('worker reads a missing block through the external P2P provider', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
  await waitForWorkerAdapter(page, 30_000);
  await page.waitForFunction(async () => {
    const { isFipsRuntimeReady } = await import('/src/lib/workerInit.ts');
    return isFipsRuntimeReady();
  }, undefined, { timeout: 30_000 });

  const result = await evaluateWithRetry(page, async () => {
    const win = window as typeof window & {
      __getWorkerAdapter?: () => {
        get(hash: Uint8Array): Promise<Uint8Array | null>;
        setP2PProvider(provider: {
          fetch(hashHex: string, peerId?: string, htl?: number): Promise<Uint8Array | null>;
          listPeerIds(): string[];
        } | null): void;
        webrtcProxy?: unknown;
      } | null;
      __workerAdapter?: {
        get(hash: Uint8Array): Promise<Uint8Array | null>;
        setP2PProvider(provider: {
          fetch(hashHex: string, peerId?: string, htl?: number): Promise<Uint8Array | null>;
          listPeerIds(): string[];
        } | null): void;
        webrtcProxy?: unknown;
      };
    };
    const adapter = win.__workerAdapter ?? win.__getWorkerAdapter?.();
    if (!adapter) throw new Error('worker adapter is not ready');

    const expected = new TextEncoder().encode(`fips-provider-${crypto.randomUUID()}`);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', expected));
    const hashHex = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const requests: Array<{ hashHex: string; peerId?: string; htl?: number }> = [];
    adapter.setP2PProvider({
      fetch: async (requestedHashHex, peerId, htl) => {
        requests.push({ hashHex: requestedHashHex, peerId, htl });
        return requestedHashHex === hashHex ? expected.slice() : null;
      },
      listPeerIds: () => ['fips-test-peer'],
    });

    const loaded = await adapter.get(digest);
    if (requests.length === 0) throw new Error('FIPS provider bridge is not ready');
    return {
      loaded: loaded ? new TextDecoder().decode(loaded) : null,
      expected: new TextDecoder().decode(expected),
      requests,
      legacyProxyActive: adapter.webrtcProxy != null,
    };
  }, undefined, 5);

  expect(result.requests).toEqual([{
    hashHex: expect.stringMatching(/^[0-9a-f]{64}$/),
    peerId: 'fips-test-peer',
    htl: 10,
  }]);
  expect(result.loaded).toBe(result.expected);
  expect(result.legacyProxyActive).toBe(false);
});
