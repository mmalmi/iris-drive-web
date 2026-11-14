/**
 * Changes this page makes to a Drive's root, one at a time.
 *
 * A change reads the root, works out a new one and saves it. Two that
 * overlapped both started from the same old root, and the one saved last
 * dropped what the other had added: a folder made while a file uploaded was
 * gone. A change run here reads the root only when the one before it has
 * saved, so each builds on the last.
 */
let last: Promise<unknown> = Promise.resolve();

export function inTurn<T>(change: () => Promise<T>): Promise<T> {
  const turn = last.then(change, change);
  last = turn.catch(() => undefined);
  return turn;
}
