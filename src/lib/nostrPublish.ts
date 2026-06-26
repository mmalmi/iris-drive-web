import { ndk, type NDKEvent } from '../nostr';

export async function publishEventWithFallback(event: NDKEvent): Promise<void> {
  await event.sign();
  const rawEvent = event.rawEvent();
  ndk.subManager.dispatchEvent(rawEvent, undefined, true);

  const hasDirectRelays = ndk.pool.relays.size > 0 || (ndk.explicitRelayUrls?.length ?? 0) > 0;
  let directError: unknown = null;
  if (hasDirectRelays) {
    try {
      await event.publish();
    } catch (error) {
      directError = error;
    }
  }

  const { getWorkerAdapter, waitForWorkerAdapter } = await import('./workerInit');
  const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(5000);
  if (adapter) {
    await adapter.publish(rawEvent as Parameters<typeof adapter.publish>[0]);
    return;
  }

  if (directError) throw directError;
  if (!hasDirectRelays) {
    throw new Error('Worker adapter unavailable for event publish');
  }
}
