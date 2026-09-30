import { localIndexSource, verifyNostrEvent, type NostrEvent } from 'nostr-pubsub';
import { getDriveFipsRuntime } from '../src/lib/driveFipsRuntime';

/** Uses the app's real peer transport while bypassing relay publication. */
export async function publishThroughDrivePeers(event: NostrEvent): Promise<void> {
  const source = getDriveFipsRuntime()?.getNostrSource();
  if (!source?.publish) throw new Error('Peer event source is not ready');
  await source.publish(verifyNostrEvent(event), localIndexSource('drive-peer-proof'));
}
