/**
 * One change to a Drive that is not the open folder, such as My Drive from a
 * form or an album from Photos, made on the Drive's newest version: in turn
 * with every other change this page makes (driveWrites), under the lock the
 * tabs of this browser share (driveRootTabs), and worked out again on the
 * newer version when another change lands meanwhile.
 */
import { toHex, type CID } from '@hashtree/core';
import { saveOwnTreeRoot } from '../nostr';
import { getTreeRootSync } from '../stores/treeRoot';
import { flushPendingPublishes } from '../treeRootCache';
import { withDriveRootLock } from '../lib/driveRootTabs';
import { inTurn } from '../lib/driveWrites';

const ATTEMPTS = 4;

function sameCid(left: CID | null, right: CID | null): boolean {
  if (!left || !right) return left === right;
  return toHex(left.hash) === toHex(right.hash) && (left.key ? toHex(left.key) : '') === (right.key ? toHex(right.key) : '');
}

/**
 * `change` gets the Drive's root and gives the new one, or null to change
 * nothing. Never writes over a Drive this device has not loaded: that would
 * replace it. Resolves whether a new root was saved.
 */
export function changeDriveRoot(scope: string, treeName: string, change: (root: CID) => Promise<CID | null>): Promise<boolean> {
  return inTurn(() => withDriveRootLock(scope, treeName, async () => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const base = getTreeRootSync(scope, treeName);
      if (!base) throw new Error('The Drive has not loaded yet');
      const root = await change(base);
      if (!root) return false;
      // Another write landed while this one was worked out: work it out again on the newer Drive.
      if (!sameCid(getTreeRootSync(scope, treeName), base)) continue;
      if (!saveOwnTreeRoot(scope, treeName, root)) throw new Error('This Drive cannot be changed here');
      void flushPendingPublishes().catch(() => {});
      return true;
    }
    throw new Error('The Drive kept changing while saving');
  }));
}
