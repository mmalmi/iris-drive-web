import { expect, test } from './fixtures';
import { ensureLoggedIn, useLocalRelay, waitForAppReady, waitForRelayConnected } from './test-utils';

test('public follow preserves the signed contact list without requiring peer history', async ({page}) => {
  await page.goto('/');
  await waitForAppReady(page);
  await useLocalRelay(page);
  await ensureLoggedIn(page);
  await waitForRelayConnected(page);
  const result = await page.evaluate(async () => {
    const {nostr, nostrStore} = await import('/src/nostr/index.ts');
    const {followPubkey, unfollowPubkey} = await import('/src/stores/follows.ts');
    const {getWorkerAdapter} = await import('/src/workerAdapter.ts');
    const {getNostrRelayUrls} = await import('/src/nostr/client.ts');
    const existing = 'c'.repeat(64), target = 'b'.repeat(64);
    const tags = [['p', existing, 'wss://hint.invalid', 'friend'], ['client', 'iris'], ['t', 'keep']];
    const content = '{"keep":"this"}';
    await nostr.publishEvent({kind: 3, tags, content});
    const followed = await followPubkey(target);
    const removed = await unfollowPubkey(target);
    const history = await getWorkerAdapter()!.queryEvents!([{kinds:[3],authors:[nostrStore.getState().pubkey!]}], {
      cache:'cache-first',relays:getNostrRelayUrls(),
    });
    const latest = history.events.sort((a,b)=>b.created_at-a.created_at || a.id.localeCompare(b.id))[0];
    return {followed,removed,complete:history.complete,tags:latest?.tags,content:latest?.content,expectedTags:tags};
  });
  expect(result.followed).toBe(true);
  expect(result.removed).toBe(true);
  expect(result.complete).toBe(true);
  expect(result.tags).toEqual(result.expectedTags);
  expect(result.content).toBe('{"keep":"this"}');
});
