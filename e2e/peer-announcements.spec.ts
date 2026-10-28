import { expect, test } from '@playwright/test';

type Fixture = { sharedProviderRestart(): Promise<{ expected: string; received: string[]; replay: string[]; errors: string[] }>; rejectChangedDiskEvent(): Promise<number>; publish(author: number, age?: number): Promise<string>;
  fillAndMeasure(): Promise<{ count: number; elapsed: number }>;
  discover(): Promise<{ received: string[]; replay: string[]; errors: string[] }> };
declare global { interface Window { peerAnnouncementFixture: Fixture } }
const fixture = '/e2e/fixtures/peer-announcements.html';

test('disk announcements survive reload without relays, serialize across tabs, and expire', async ({ page, context }) => {
  const sockets: string[] = [];
  context.on('page', tab => tab.on('websocket', socket => sockets.push(socket.url())));
  page.on('websocket', socket => sockets.push(socket.url()));
  await page.goto(fixture);
  await page.waitForFunction(() => !!window.peerAnnouncementFixture);
  const first = await page.evaluate(() => window.peerAnnouncementFixture.publish(11));
  await page.reload();
  await page.waitForFunction(() => !!window.peerAnnouncementFixture);
  expect(await page.evaluate(() => window.peerAnnouncementFixture.discover()))
    .toEqual({ received: [first], replay: [first], errors: [] });
  const second = await context.newPage();
  await second.goto(fixture);
  await second.waitForFunction(() => !!window.peerAnnouncementFixture);
  const ids = await Promise.all([
    page.evaluate(() => window.peerAnnouncementFixture.publish(12)),
    second.evaluate(() => window.peerAnnouncementFixture.publish(13)),
  ]);
  const after = await page.evaluate(() => window.peerAnnouncementFixture.discover());
  expect(after.received.sort()).toEqual([first, ...ids].sort());
  expect(after.replay.sort()).toEqual([first, ...ids].sort());
  await page.clock.setFixedTime(Date.now() + 61_000);
  expect(await page.evaluate(() => window.peerAnnouncementFixture.discover()))
    .toEqual({ received: [], replay: [], errors: [] });
  // Vite's development reload socket is the only permitted socket.
  expect(sockets.every(url => new URL(url).hostname === '127.0.0.1' || new URL(url).hostname === 'localhost')).toBe(true);
});

test('browser announcement cache stays bounded at the consumer limit', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.goto(fixture);
  await page.waitForFunction(() => !!window.peerAnnouncementFixture);
  const filled = await page.evaluate(() => window.peerAnnouncementFixture.fillAndMeasure());
  expect(filled.count).toBe(256);
  await page.reload();
  await page.waitForFunction(() => !!window.peerAnnouncementFixture);
  const restored = await page.evaluate(async () => {
    const started = performance.now();
    const result = await window.peerAnnouncementFixture.discover();
    return { count: result.received.length, errors: result.errors, elapsed: performance.now() - started };
  });
  expect(restored.count).toBe(256);
  expect(restored.errors).toEqual([]);
  console.log('Peer cache capacity:', JSON.stringify({ filled, restored }));
  await info.attach('peer-cache-capacity', { contentType: 'application/json',
    body: JSON.stringify({ filled, restored }) });
});

test('an already verified disk event is rejected if another tab changes its bytes', async ({ page }) => {
  await page.goto(fixture);
  await page.waitForFunction(() => !!window.peerAnnouncementFixture);
  await page.evaluate(() => window.peerAnnouncementFixture.publish(14));
  expect(await page.evaluate(() => window.peerAnnouncementFixture.rejectChangedDiskEvent())).toBe(0);
});

test('the released shared Hashtree provider restores and replays without relays', async ({ page }) => {
  await page.goto(fixture);
  await page.waitForFunction(() => !!window.peerAnnouncementFixture);
  const result = await page.evaluate(() => window.peerAnnouncementFixture.sharedProviderRestart());
  expect(result.received).toEqual([result.expected]);
  expect(result.replay).toEqual([result.expected]);
  expect(result.errors).toEqual([]);
});
