import type { SignedNostrIdentityRosterOp } from '../drive/protocol';

const DEFAULT_PUBLISH_CONCURRENCY = 32;

/** Await durable publication of every signed operation in a roster history. */
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

/** Do not expose local profile state until its complete trust anchor is published. */
export async function publishDriveRosterThenActivate<T>(
  rosterOps: readonly SignedNostrIdentityRosterOp[],
  publishEventJson: (eventJson: string) => Promise<void>,
  activate: () => T | Promise<T>,
): Promise<T> {
  await publishDriveRosterHistory(rosterOps, publishEventJson);
  return activate();
}
