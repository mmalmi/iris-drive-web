import { WebSocket } from 'ws';
import { finalizeEvent, generateSecretKey, getPublicKey, nip19, nip44, verifyEvent } from 'nostr-tools';
import { NostrRuntime } from 'nostr-pubsub';
import { expect, test } from './fixtures';
import { waitForAppReady, waitForWorkerAdapter } from './test-utils';

function peer(relayUrl: string) {
  return new NostrRuntime({ relays: [relayUrl], websocketImplementation: WebSocket as unknown as typeof globalThis.WebSocket });
}

test('preserves an existing secret-key session and durable events across a disconnected reload', async ({ page, context, relayUrl }) => {
  const key = generateSecretKey(); const pubkey = getPublicKey(key); const nsec = nip19.nsecEncode(key);
  await page.addInitScript(({ pubkey, nsec }) => {
    if (sessionStorage.getItem('runtime-session-seeded')) return;
    sessionStorage.setItem('runtime-session-seeded', '1');
    localStorage.setItem('hashtree:nsec', nsec);
    localStorage.setItem('hashtree:loginType', 'nsec');
    localStorage.setItem('hashtree:activeAccount', pubkey);
    localStorage.setItem('hashtree:accounts', JSON.stringify([{ pubkey, nsec, type: 'nsec', addedAt: 100 }]));
  }, { pubkey, nsec });
  let disconnected = true;
  await context.routeWebSocket(url => url.hostname === 'localhost' && url.port === new URL(relayUrl).port, socket => {
    if (disconnected) socket.close(); else socket.connectToServer();
  });
  await page.goto('/'); await waitForAppReady(page); await waitForWorkerAdapter(page);
  const pending = await page.evaluate(async () => {
    const { nostr, nostrStore } = await import('/src/nostr');
    const { waitForWorkerAdapter } = await import('/src/lib/workerInit.ts');
    const adapter = await waitForWorkerAdapter();
    const { settingsStore } = await import('/src/stores/settings.ts');
    settingsStore.setNetworkSettings({ relays: [] });
    await adapter!.setRelays([]);
    const event = await nostr.signEvent({ kind: 1, content: `offline-${crypto.randomUUID()}` });
    const receipt = await nostr.publish(event);
    return { id: event.id, pubkey: nostrStore.getState().pubkey, receipt };
  });
  expect(pending.pubkey).toBe(pubkey);
  expect(pending.receipt).toMatchObject({ accepted: false, queued: true });
  await page.reload(); await waitForAppReady(page); await waitForWorkerAdapter(page);
  const restored = await page.evaluate(async id => {
    const { nostrStore } = await import('/src/nostr');
    const { waitForWorkerAdapter } = await import('/src/lib/workerInit.ts');
    const adapter = await waitForWorkerAdapter();
    const cached = await adapter!.queryEvents!([{ ids: [id] }], { cache: 'cache-only' });
    return { pubkey: nostrStore.getState().pubkey, key: localStorage.getItem('hashtree:nsec'), cached };
  }, pending.id);
  expect(restored.pubkey).toBe(pubkey); expect(restored.key).toBe(nsec);
  expect(restored.cached.complete).toBe(true); expect(restored.cached.events.map(event => event.id)).toContain(pending.id);
  disconnected = false;
  await page.evaluate(async relay => {
    const { waitForWorkerAdapter } = await import('/src/lib/workerInit.ts');
    const { settingsStore } = await import('/src/stores/settings.ts');
    settingsStore.setNetworkSettings({ relays: [relay] });
    await (await waitForWorkerAdapter())!.setRelays([relay]);
  }, relayUrl);
  const observer = peer(relayUrl);
  try {
    await expect.poll(async () => (await observer.query([{ ids: [pending.id] }], { cache: 'network-only', deadline: Date.now() + 1000 })).events.map(event => event.id), { timeout: 15000 }).toContain(pending.id);
  } finally { await observer.close(); }
});

test('remote recovery signs through pubsub using the selected signer relay', async ({ page, relayUrl }) => {
  const bunkerKey = generateSecretKey(); const signerKey = generateSecretKey(); const bunkerPubkey = getPublicKey(bunkerKey);
  const server = peer(relayUrl);
  let requests = 0;
  server.subscribe([{ kinds: [24133], '#p': [bunkerPubkey] }], { onEvent: async event => {
    const conversation = nip44.v2.utils.getConversationKey(bunkerKey, event.pubkey);
    const request = JSON.parse(nip44.v2.decrypt(event.content, conversation)); requests++;
    const result = request.method === 'connect' ? 'ack'
      : request.method === 'get_public_key' ? getPublicKey(signerKey)
        : request.method === 'sign_event' ? JSON.stringify(finalizeEvent(JSON.parse(request.params[0]), signerKey)) : null;
    if (!result) return;
    await server.publish(finalizeEvent({ kind: 24133, created_at: Math.floor(Date.now() / 1000), tags: [['p', event.pubkey]],
      content: nip44.v2.encrypt(JSON.stringify({ id: request.id, result }), conversation) }, bunkerKey), { requireAck: true });
  } }, { cache: 'network-only' });
  try {
    await page.goto('/'); await waitForAppReady(page);
    const event = await page.evaluate(async ({ connection, relayUrl }) => {
      const { createRemoteRecoverySigner } = await import('/src/nostr/remoteRecovery.ts');
      const signer = await createRemoteRecoverySigner(connection, relayUrl);
      try { return await signer.signEvent({ kind: 0, created_at: 100, tags: [], content: 'restored remote signer' }); }
      finally { await signer.close(); }
    }, { connection: `bunker://${bunkerPubkey}?relay=${encodeURIComponent(relayUrl)}`, relayUrl });
    expect(verifyEvent(event)).toBe(true); expect(event.pubkey).toBe(getPublicKey(signerKey));
    expect(event.content).toBe('restored remote signer'); expect(requests).toBeGreaterThanOrEqual(3);
  } finally { await server.close(); }
});
