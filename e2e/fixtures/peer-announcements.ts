import { openBrowserAnnouncements } from '@hashtree/fips-transport/browser';
import { IndexedDbEventBus, NostrRuntime, RetainedPeerDiscovery, localIndexSource } from 'nostr-pubsub';
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure';
const name = 'peer-announcement-browser-fixture';
const policy = { maxEvents: 256, filters: [{ kinds: [37195], '#d': ['fixture'] }] };
export async function publish(author: number, age = 0) {
  const store = await IndexedDbEventBus.open(name, policy);
  try {
    const now = Math.floor(Date.now() / 1000);
    const event = finalizeEvent({ kind: 37195, content: 'peer-' + author, created_at: now - age,
      tags: [['d', 'fixture'], ['expiration', String(now - age + 60)]] }, new Uint8Array(32).fill(author));
    await store.publish(event, localIndexSource('fixture'));
    return event.id;
  } finally { store.close(); }
}
export async function discover() {
  const store = await IndexedDbEventBus.open(name, policy);
  const runtime = new NostrRuntime({ relays: [] });
  const errors: string[] = [], received: string[] = [];
  const discovery = new RetainedPeerDiscovery(runtime, store, error => errors.push(error.message));
  try {
    await discovery.subscribe(policy.filters[0], event => received.push(event.id));
    return { received, errors, replay: (await store.query(policy.filters)).events.map(item => item.event.id) };
  } finally { await discovery.close(); await runtime.close(); store.close(); }
}
export async function fillAndMeasure() {
  const store = await IndexedDbEventBus.open(name, policy);
  const started = performance.now();
  const now = Math.floor(Date.now() / 1000);
  try {
    for (let index = 0; index < 270; index++) {
      const event = finalizeEvent({ kind: 37195, content: 'peer-' + index, created_at: now,
        tags: [['d', 'fixture'], ['expiration', String(now + 3600)]] }, generateSecretKey());
      await store.publish(event, localIndexSource('capacity-fixture'));
    }
    return { count: (await store.query(policy.filters)).events.length, elapsed: performance.now() - started };
  } finally { store.close(); }
}
export async function rejectChangedDiskEvent() {
  const store = await IndexedDbEventBus.open(name, policy);
  try {
    const before = (await store.query(policy.filters)).events[0]?.event;
    if (!before) throw new Error('Missing stored fixture');
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = database.transaction('snapshots', 'readwrite');
        tx.objectStore('snapshots').put({ version: 1, events: [{ ...before, content: 'tampered' }] }, 'events');
        tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
      });
    } finally { database.close(); }
    return (await store.query(policy.filters)).events.length;
  } finally { store.close(); }
}
export async function sharedProviderRestart() {
  const errors: string[] = [];
  let provider = await openBrowserAnnouncements('fixture-device', 'fixture-shared', [], undefined, error => errors.push(error.message));
  const now = Math.floor(Date.now() / 1000);
  const event = finalizeEvent({ kind: 37195, content: 'shared', created_at: now,
    tags: [['d', 'fixture-shared'], ['expiration', String(now + 60)]] }, new Uint8Array(32).fill(18));
  await provider.discovery.publish(event);
  await provider.close();
  provider = await openBrowserAnnouncements('fixture-device', 'fixture-shared', [], undefined, error => errors.push(error.message));
  try {
    const received: string[] = [];
    await provider.discovery.subscribe({ kinds: [37195], '#d': ['fixture-shared'] }, event => received.push(event.id));
    const report = await provider.retained.query([{ kinds: [37195] }]);
    return { expected: event.id, received, replay: report.events.map(item => item.event.id), errors };
  } finally { await provider.close(); }
}
Object.assign(window, { peerAnnouncementFixture: { publish, discover, fillAndMeasure, rejectChangedDiskEvent, sharedProviderRestart } });
