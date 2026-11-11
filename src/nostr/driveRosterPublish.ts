import type { SignedNostrIdentityRosterOp } from '../drive/protocol';

const DEFAULT_PUBLISH_CONCURRENCY = 32;

/** Publish every signed operation of a roster history, a batch at a time. */
export async function publishDriveRosterHistory(
  rosterOps: readonly SignedNostrIdentityRosterOp[],
  publishEventJson: (eventJson: string) => Promise<void>,
  concurrency = DEFAULT_PUBLISH_CONCURRENCY,
): Promise<void> {
  const batchSize = Math.max(1, Math.floor(concurrency));
  for (let offset = 0; offset < rosterOps.length; offset += batchSize) {
    await Promise.all(
      rosterOps.slice(offset, offset + batchSize)
        .map((op) => publishEventJson(op.event_json)),
    );
  }
}
