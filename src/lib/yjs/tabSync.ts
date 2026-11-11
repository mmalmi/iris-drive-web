/**
 * Keeps one document consistent across tabs of the same browser.
 *
 * Tabs share a device key, so they would write to the same Drive root and to
 * the same document folder. Exactly one tab saves at a time; the others pass
 * their edits to it and show its edits at once.
 */
import * as Y from 'yjs';
import { STORED_ORIGIN } from './documentStore';

/** Transaction origin of edits received from another tab. */
export const TAB_ORIGIN = 'tab';

type TabMessage =
  | { type: 'update'; update: Uint8Array }
  | { type: 'hello' };

export interface TabSyncOptions {
  /** Identifies the document; tabs with the same key share edits. */
  key: string;
  ydoc: Y.Doc;
  /** Called when this tab starts being the one that saves. */
  onSaver: () => void;
}

/** Returns a function that disconnects this tab. */
export function connectDocumentTabs(options: TabSyncOptions): () => void {
  const { ydoc } = options;
  let closed = false;
  let releaseLock: (() => void) | undefined;
  const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(`irisdoc:${options.key}`);

  const onUpdate = (update: Uint8Array, origin: unknown) => {
    // Stored updates reach every tab through its own view of the Drive.
    if (origin === STORED_ORIGIN || origin === TAB_ORIGIN) return;
    channel?.postMessage({ type: 'update', update } satisfies TabMessage);
  };
  ydoc.on('update', onUpdate);

  if (channel) {
    channel.onmessage = (event: MessageEvent<TabMessage>) => {
      if (closed) return;
      if (event.data.type === 'update') {
        Y.applyUpdate(ydoc, new Uint8Array(event.data.update), TAB_ORIGIN);
      } else {
        // A tab that just opened asks for edits that are not stored yet.
        channel.postMessage({ type: 'update', update: Y.encodeStateAsUpdate(ydoc) } satisfies TabMessage);
      }
    };
    channel.postMessage({ type: 'hello' } satisfies TabMessage);
  }

  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks) {
    void locks.request(`irisdoc-saver:${options.key}`, () => {
      if (closed) return undefined;
      options.onSaver();
      return new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
    }).catch(() => {
      if (!closed) options.onSaver();
    });
  } else {
    options.onSaver();
  }

  return () => {
    closed = true;
    ydoc.off('update', onUpdate);
    channel?.close();
    releaseLock?.();
  };
}
