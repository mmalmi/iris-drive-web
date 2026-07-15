/**
 * Media Streaming Setup
 *
 * Connects the page service worker to the active hashtree backend runtime so
 * media requests can be served through `/htree/...` URLs.
 */

import { isHtreeDebugEnabled, logHtreeDebug } from './htreeDebug';
import { getHtreeRuntime } from './htreeRuntime';
import { getWorkerAdapter, waitForWorkerAdapter } from './workerInit';

let isSetup = false;

async function registerMediaPort(port: MessagePort, debug?: boolean): Promise<void> {
  const adapter = getWorkerAdapter() ?? await waitForWorkerAdapter(10000);
  if (!adapter) {
    throw new Error('Worker adapter not initialized');
  }
  adapter.registerMediaPort(port, debug);
}

export async function setupMediaStreaming(): Promise<boolean> {
  logHtreeDebug('media:setup:begin');

  try {
    const ready = await getHtreeRuntime().media.ensureReady({
      registerMediaPort,
      debug: isHtreeDebugEnabled(),
      attempts: 1,
    });
    isSetup = ready;
    logHtreeDebug(ready ? 'media:setup:complete' : 'media:setup:not-ready');
    return ready;
  } catch (error) {
    isSetup = false;
    console.error('[MediaStreaming] Setup failed:', error);
    logHtreeDebug('media:setup:error', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function ensureMediaStreamingReady(attempts = 3, delayMs = 500): Promise<boolean> {
  logHtreeDebug('media:ensure:attempt', { attempts });

  try {
    const ready = await getHtreeRuntime().media.ensureReady({
      registerMediaPort,
      debug: isHtreeDebugEnabled(),
      attempts,
      delayMs,
    });
    isSetup = ready;
    logHtreeDebug(ready ? 'media:ensure:ready' : 'media:ensure:failed', { attempts });
    return ready;
  } catch (error) {
    isSetup = false;
    logHtreeDebug('media:ensure:error', {
      attempts,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Check if media streaming is set up
 */
export function isMediaStreamingSetup(): boolean {
  return isSetup;
}

/**
 * Reset media streaming (for testing/cleanup)
 */
export function resetMediaStreaming(): void {
  isSetup = false;
  getHtreeRuntime().media.reset();
}
