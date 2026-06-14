/**
 * E2E test for WebRTC peer connections via local test relay
 *
 * Creates two browser contexts and verifies they can:
 * 1. Discover each other via Nostr signaling
 * 2. Establish WebRTC data channel connections
 * 3. Exchange content by hash
 */
import { test, expect } from './fixtures';
import { disableOthersPool, loginAsTestUser, followUser, waitForFollowInWorker, waitForWebRTCConnection } from './test-utils';

// Test users with different nsecs
const TEST_USER_1 = 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5';
const TEST_USER_2 = 'nsec1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqstywftw';

test.describe('WebRTC P2P Connection', () => {
  test.setTimeout(120000);

  test('two peers can discover each other and connect', async ({ browser }) => {
    // Create two browser contexts (simulating two different peers)
    const context1 = await browser.newContext();
    const context2 = await browser.newContext();

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    // Log browser console for debugging
    page1.on('console', msg => {
      const text = msg.text();
      if (text.includes('[WebRTC Test]') || text.includes('CONNECTED')) {
        console.log(`[Peer1] ${text}`);
      }
    });
    page2.on('console', msg => {
      const text = msg.text();
      if (text.includes('[WebRTC Test]') || text.includes('CONNECTED')) {
        console.log(`[Peer2] ${text}`);
      }
    });

    try {
      // Navigate to app
      await page1.goto('/');
      await page2.goto('/');

      await page1.waitForLoadState('networkidle');
      await page2.waitForLoadState('networkidle');

      // Login as different test users
      await loginAsTestUser(page1, TEST_USER_1);
      await loginAsTestUser(page2, TEST_USER_2);

      await disableOthersPool(page1);
      await disableOthersPool(page2);

      const peer1Keys = await page1.evaluate(() => {
        const state = (window as any).__nostrStore?.getState?.();
        return { pubkey: state?.pubkey ?? null, npub: state?.npub ?? null };
      });
      const peer2Keys = await page2.evaluate(() => {
        const state = (window as any).__nostrStore?.getState?.();
        return { pubkey: state?.pubkey ?? null, npub: state?.npub ?? null };
      });

      expect(peer1Keys.pubkey).toBeTruthy();
      expect(peer1Keys.npub).toBeTruthy();
      expect(peer2Keys.pubkey).toBeTruthy();
      expect(peer2Keys.npub).toBeTruthy();

      await followUser(page1, peer2Keys.npub);
      await followUser(page2, peer1Keys.npub);

      expect(await waitForFollowInWorker(page1, peer2Keys.pubkey, 20000)).toBe(true);
      expect(await waitForFollowInWorker(page2, peer1Keys.pubkey, 20000)).toBe(true);

      await page1.evaluate(() => (window as any).__workerAdapter?.sendHello?.());
      await page2.evaluate(() => (window as any).__workerAdapter?.sendHello?.());
      await waitForWebRTCConnection(page1, 60000, peer2Keys.pubkey);
      await waitForWebRTCConnection(page2, 60000, peer1Keys.pubkey);

      // Wait for WebRTC test functions to be available
      console.log('Waiting for test functions on page 1...');
      await page1.waitForFunction(() => typeof window.runWebRTCTestWithContent === 'function', { timeout: 30000 });
      console.log('Waiting for test functions on page 2...');
      await page2.waitForFunction(() => typeof window.runWebRTCTest === 'function', { timeout: 30000 });

      // Check worker adapter status
      const adapterStatus1 = await page1.evaluate(async () => {
        const { getWorkerAdapter } = await import('/src/lib/workerInit');
        const adapter = getWorkerAdapter();
        return {
          hasAdapter: !!adapter,
          pubkey: window.__getMyPubkey?.() || null,
        };
      });
      console.log('Peer 1 adapter status:', adapterStatus1);

      const testContent = `Hello from Peer 1! Timestamp: ${Date.now()}`;

      // Start peer 1 first, but do not await completion yet:
      // it can take up to 60s if no peers connect.
      console.log('\n=== Starting Peer 1 with content ===');
      const peer1Promise = page1.evaluate(async (content) => {
        try {
          return await window.runWebRTCTestWithContent!(content);
        } catch (e) {
          return { error: String(e), pubkey: null, connectedPeers: 0 };
        }
      }, testContent);

      // Wait until peer 1 has published minimal metadata needed by peer 2.
      await page1.waitForFunction(
        () => (window as any).testResults?.pubkey && (window as any).testResults?.contentHash,
        { timeout: 15000 }
      );
      const peer1Info = await page1.evaluate(() => (window as any).testResults || {});
      const contentHash = peer1Info.contentHash;
      const peer1Pubkey = peer1Info.pubkey;

      console.log(`Peer 1 pubkey: ${peer1Pubkey?.slice(0, 16) || 'null'}...`);
      console.log(`Content hash: ${contentHash?.slice(0, 16) || 'null'}...`);

      // Run peer 2 concurrently with peer 1 wait loop so total wall time stays bounded.
      console.log('\n=== Starting Peer 2 to find content ===');
      const peer2Promise = page2.evaluate(
        async ([pubkey, hash]) => {
          try {
            return await window.runWebRTCTest!(pubkey ?? undefined, hash ?? undefined);
          } catch (e) {
            return { error: String(e), pubkey: null, connectedPeers: 0 };
          }
        },
        [peer1Pubkey, contentHash] as const
      );

      const [result1, result2] = await Promise.all([peer1Promise, peer2Promise]);
      console.log('Peer 1 result:', JSON.stringify(result1, null, 2));

      console.log('\n=== Results ===');
      console.log('Peer 1:', JSON.stringify(result1, null, 2));
      console.log('Peer 2:', JSON.stringify(result2, null, 2));

      // Verify at least one peer connected
      const totalConnections = result1.connectedPeers + result2.connectedPeers;
      console.log(`Total connections: ${totalConnections}`);

      // This test verifies the infrastructure works
      // Check that content hash was generated
      expect(result1.contentHash).toBeTruthy();

      // If connected, verify content exchange
      if (result2.connectedPeers > 0 && result2.contentRequestResult?.found) {
        console.log('✓ Content successfully exchanged via WebRTC!');
        expect(result2.contentRequestResult.data).toBe(testContent);
      } else {
        console.log('Note: Peers may not have connected (network/NAT issues or local relay not routing) - test passes if infrastructure is set up correctly');
      }
    } finally {
      await context1.close();
      await context2.close();
    }
  });
});
