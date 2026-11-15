import { FipsPubsubWireCodec, localIndexSource, verifyNostrEvent, type NostrEvent } from 'nostr-pubsub';
import { getDriveFipsRuntime } from '../src/lib/driveFipsRuntime';

/** Uses the app's real peer transport while bypassing relay publication. */
export async function publishThroughDrivePeers(event: NostrEvent): Promise<void> {
  const source = getDriveFipsRuntime()?.getNostrSource();
  if (!source?.publish) throw new Error('Peer event source is not ready');
  await source.publish(verifyNostrEvent(event), localIndexSource('drive-peer-proof'));
}

/** Records the Negentropy `sync` frames this page sends and receives on the FIPS nostr feed. */
export function recordFeedSyncFrames(): { sent: string[]; received: string[] } {
  const frames = { sent: [] as string[], received: [] as string[] };
  const codec = FipsPubsubWireCodec.prototype;
  const encode = codec.encodeFrame;
  const decode = codec.decodeFrame;
  codec.encodeFrame = function (message) {
    if (message.type === 'sync') frames.sent.push(message.action);
    return encode.call(this, message);
  };
  codec.decodeFrame = function (frame) {
    const message = decode.call(this, frame);
    if (message.type === 'sync') frames.received.push(message.action);
    return message;
  };
  return frames;
}
