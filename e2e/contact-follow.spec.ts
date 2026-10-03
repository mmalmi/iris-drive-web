import { test, expect } from './fixtures';
import { nip19 } from 'nostr-tools';
import { ensureLoggedIn, waitForAppReady, waitForRelayConnected } from './test-utils';

const existing = '11'.repeat(32);
const contact = '22'.repeat(32);
const tags = [['p', existing, 'wss://hint.invalid', 'Saved name'], ['client', 'iris-test']];
const content = '{"keep":"contact metadata"}';

test('public follow and unfollow preserve relay contact metadata through the real worker', async ({ page }) => {
  await page.goto('/#/');
  await waitForAppReady(page);
  await ensureLoggedIn(page, 30_000);
  await waitForRelayConnected(page);
  await page.evaluate(async ({ tags, content }) => {
    const { nostr } = await import('/src/nostr/client.ts');
    await nostr.publishEvent({ kind: 3, tags, content, created_at: Math.floor(Date.now() / 1000) });
  }, { tags, content });

  const latest = () => page.evaluate(async () => {
    const { getWorkerAdapter } = await import('/src/workerAdapter.ts');
    const { getNostrRelayUrls } = await import('/src/nostr/client.ts');
    const { nostrStore } = await import('/src/nostr/index.ts');
    const adapter = getWorkerAdapter();
    const pubkey = nostrStore.getState().pubkey;
    if (!adapter?.queryEvents || !pubkey) throw new Error('Signed-in worker not ready');
    const result = await adapter.queryEvents([{ kinds: [3], authors: [pubkey] }], {
      cache: 'network-only', relays: getNostrRelayUrls(), deadline: Date.now() + 10_000,
    });
    const head = result.events.sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
    return { complete: result.complete, tags: head?.tags, content: head?.content };
  });
  await expect.poll(latest).toEqual({ complete: true, tags, content });
  expect(await page.evaluate(async contact => {
    const { followPubkey } = await import('/src/stores/follows.ts');
    return followPubkey(contact);
  }, contact)).toBe(true);
  await expect.poll(latest).toEqual({ complete: true, tags: [...tags, ['p', contact]], content });
  const ownNpub = await page.evaluate(async () => {
    const { nostrStore } = await import('/src/nostr/index.ts');
    return nostrStore.getState().npub;
  });
  await page.evaluate(npub => { window.location.hash = `/${npub}/follows`; }, ownNpub);
  const badge = page.locator('[data-testid="social-distance-badge"][title="Following"]').first();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveCSS('background-color', 'rgb(10, 132, 255)');
  const geometry = await badge.evaluate(element => {
    const check = element.getBoundingClientRect();
    if (!element.parentElement) throw new Error('Avatar wrapper missing');
    const avatar = element.parentElement.getBoundingClientRect();
    return { checkX: check.x + check.width / 2, checkY: check.y + check.height / 2,
      avatarX: avatar.x + avatar.width / 2, avatarY: avatar.y + avatar.height / 2 };
  });
  expect(geometry.checkX).toBeGreaterThan(geometry.avatarX);
  expect(geometry.checkY).toBeLessThan(geometry.avatarY);
  await page.evaluate(npub => { window.location.hash = `/${npub}/profile`; }, nip19.npubEncode(contact));
  const profileAvatar = page.locator('[data-testid="profile-avatar"]:visible');
  const profileHeader = profileAvatar.locator('..');
  const explanation = profileHeader.getByTestId('profile-follow-explanation');
  await expect(explanation).toContainText(/You follow them|Followed by/);
  await expect(explanation.getByTestId('social-distance-badge')).toHaveCount(1);
  await expect(profileAvatar).toBeVisible();
  await expect(profileAvatar.getByTestId('social-distance-badge')).toHaveCount(0);
  await expect(profileHeader.locator('h1').getByTestId('social-distance-badge')).toHaveCount(0);
  await expect(profileHeader.getByTestId('social-distance-badge')).toHaveCount(1);
  await page.screenshot({path:test.info().outputPath('profile-social-badge.png')});
  expect(await page.evaluate(async contact => {
    const { unfollowPubkey } = await import('/src/stores/follows.ts');
    return unfollowPubkey(contact);
  }, contact)).toBe(true);
  await expect.poll(latest).toEqual({ complete: true, tags, content });
});
