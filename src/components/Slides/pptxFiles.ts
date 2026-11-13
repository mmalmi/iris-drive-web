/**
 * The PowerPoint file a route asks to bring in (`?import=<file name>`), read
 * from the folder the deck is in. Loaded only when a route asks.
 */
import { get } from 'svelte/store';
import { LinkType, type CID } from '@hashtree/core';
import { getTree } from '../../store';
import { routeStore, treeRootStore } from '../../stores';

async function readFrom(root: CID | null, name: string): Promise<Uint8Array | null> {
  if (!root) return null;
  const tree = getTree();
  const found = await tree.resolvePath(root, [...get(routeStore).path.slice(0, -1), name]).catch(() => null);
  if (!found || found.type === LinkType.Dir) return null;
  return await tree.readFile(found.cid);
}

/**
 * The bytes of a file beside the deck, in the folder the deck is in; null
 * when there is no such file. A file just put there may reach this page's
 * view of the Drive a moment later, so newer views are looked in for a while.
 */
export async function readSiblingFile(name: string, waitMs = 15_000): Promise<Uint8Array | null> {
  const now = await readFrom(get(treeRootStore), name);
  if (now) return now;
  return await new Promise((resolve) => {
    let done = false;
    let first = true;
    const finish = (bytes: Uint8Array | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      queueMicrotask(() => unsubscribe());
      resolve(bytes);
    };
    const timer = setTimeout(() => finish(null), waitMs);
    const unsubscribe = treeRootStore.subscribe((root) => {
      if (first) {
        first = false;
        return;
      }
      void readFrom(root, name).then(bytes => bytes && finish(bytes));
    });
  });
}

/** Takes `import` out of the address, so a reload does not bring the file in again. */
export function forgetImportRequest(): void {
  const [base, query = ''] = window.location.hash.split('?');
  const params = new URLSearchParams(query);
  if (!params.has('import')) return;
  params.delete('import');
  const rest = params.toString();
  history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${base}${rest ? `?${rest}` : ''}`);
}
