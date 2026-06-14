import type { CID, HashTree } from '@hashtree/core';
import { buildSyntheticPlayableMediaFileName } from './playableMedia';

const DIRECT_MEDIA_PROBE_BYTES = 64;

export async function readDirectPlayableMediaFileName(
  tree: Pick<HashTree, 'readFileRange'>,
  rootCid: CID,
  timeoutMs: number = 15000,
): Promise<string | null> {
  const bytes = await Promise.race([
    tree.readFileRange(rootCid, 0, DIRECT_MEDIA_PROBE_BYTES),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
  ]);

  if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
    return null;
  }

  return buildSyntheticPlayableMediaFileName(bytes);
}
