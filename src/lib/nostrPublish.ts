import { ndk, type NDKEvent } from '../nostr';

export async function publishEventWithFallback(event: NDKEvent): Promise<void> {
  const hasDirectRelays = ndk.pool.relays.size > 0 || (ndk.explicitRelayUrls?.length ?? 0) > 0;
  if (hasDirectRelays) {
    await event.publish();
    return;
  }

  await event.sign();
  const rawEvent = event.rawEvent();
  ndk.subManager.dispatchEvent(rawEvent, undefined, true);

  const { getWorkerAdapter, waitForWorkerAdapter } = await import('./workerInit');
  const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(5000);
  if (!adapter) {
    throw new Error('Worker adapter unavailable for event publish');
  }

  await adapter.publish(rawEvent as Parameters<typeof adapter.publish>[0]);
}
