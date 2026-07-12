import { expect } from '../fixtures';

/**
 * Filter out noisy errors from relays that are irrelevant to tests.
 * - rate-limited: Some relays rate-limit nostr events
 * - pow: Some relays require Proof of Work on events (e.g., "pow: 28 bits needed")
 */
export function setupPageErrorHandler(page: any) {
  page.on('pageerror', (err: Error) => {
    const msg = err.message;
    if (!msg.includes('rate-limited') && !msg.includes('pow:') && !msg.includes('bits needed')) {
      console.log('Page error:', msg);
    }
  });
}

export async function waitForTestHelpers(page: any, timeoutMs: number = 60000) {
  await page.waitForFunction(
    () => (window as any).__testHelpersReady === true,
    undefined,
    { timeout: timeoutMs }
  );
}

export async function waitForAppShell(page: any, timeoutMs: number = 60000) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt < timeoutMs) {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    try {
      await expect(page.locator('header').first()).toBeVisible({
        timeout: Math.min(remainingMs, 8000),
      });
      return;
    } catch (err) {
      lastError = err;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      break;
    }

    const currentUrl = page.url();
    try {
      if (!currentUrl || currentUrl === 'about:blank') {
        await page.goto('/', {
          waitUntil: 'domcontentloaded',
          timeout: Math.min(timeoutMs - (Date.now() - startedAt), 15000),
        });
      } else {
        await page.reload({
          waitUntil: 'domcontentloaded',
          timeout: Math.min(timeoutMs - (Date.now() - startedAt), 15000),
        });
      }
    } catch {
      await page.waitForTimeout(500).catch(() => {});
    }
  }

  throw lastError ?? new Error('Timed out waiting for app shell');
}

export async function waitForWorkerAdapter(page: any, timeoutMs: number = 60000) {
  await page.waitForFunction(
    () => {
      const win = window as any;
      return !!win.__workerAdapter
        || (typeof win.__getWorkerAdapter === 'function' && !!win.__getWorkerAdapter());
    },
    undefined,
    { timeout: timeoutMs }
  );
}

export async function waitForOptionalWorkerAdapter(page: any, timeoutMs: number = 60000) {
  await waitForWorkerAdapter(page, Math.min(timeoutMs, 5000)).catch(() => {});
}

function isTransientNavigationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return [
    'net::ERR_ADDRESS_INVALID',
    'net::ERR_CONNECTION_REFUSED',
    'net::ERR_CONNECTION_RESET',
    'net::ERR_CONNECTION_CLOSED',
    'net::ERR_EMPTY_RESPONSE',
    'net::ERR_NETWORK_CHANGED',
    'Target page, context or browser has been closed',
  ].some((snippet) => message.includes(snippet));
}

function resolveNavigationRetries(url: string, retries?: number): number {
  if (typeof retries === 'number') {
    return Math.max(0, retries);
  }
  // Local e2e servers can restart transiently under heavy suite load.
  return url.startsWith('/') || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/.test(url) ? 30 : 2;
}

export async function evaluateWithRetry<T, R>(
  page: any,
  fn: (arg: T) => Promise<R> | R,
  arg: T,
  retries: number = 3
): Promise<R> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await page.evaluate(fn, arg);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      const transientAppReadiness = message.includes('worker adapter is not ready')
        || message.includes('FIPS provider bridge is not ready');
      if (!message.includes('Execution context was destroyed') && !transientAppReadiness) {
        throw err;
      }
      await page.waitForLoadState('domcontentloaded');
      await page.waitForFunction(() => document.readyState === 'complete', { timeout: 5000 }).catch(() => {});
      if (transientAppReadiness) {
        await waitForWorkerAdapter(page, 10_000).catch(() => {});
      }
    }
  }
  throw lastError ?? new Error('Failed to evaluate after retries');
}

/**
 * Wait for the app to be ready (header visible).
 * Call this after page.reload() before calling disableOthersPool or configureBlossomServers.
 */
export async function waitForAppReady(page: any, timeoutMs: number = 60000) {
  await waitForAppShell(page, timeoutMs);
  await waitForTestHelpers(page, timeoutMs);
  await waitForOptionalWorkerAdapter(page, timeoutMs);
}

export async function safeGoto(
  page: any,
  url: string,
  options?: { waitUntil?: 'domcontentloaded' | 'load' | 'networkidle'; timeoutMs?: number; retries?: number; delayMs?: number }
): Promise<void> {
  const waitUntil = options?.waitUntil ?? 'domcontentloaded';
  const timeoutMs = options?.timeoutMs ?? 60000;
  const retries = resolveNavigationRetries(url, options?.retries);
  const delayMs = options?.delayMs ?? 1000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await page.goto(url, { waitUntil, timeout: timeoutMs });
      return;
    } catch (err) {
      lastError = err;
      if (attempt === retries || !isTransientNavigationError(err)) {
        break;
      }
      await page.waitForTimeout(Math.min(delayMs * (attempt + 1), 5000));
    }
  }

  throw lastError;
}

export async function safeReload(
  page: any,
  options?: { waitUntil?: 'domcontentloaded' | 'load' | 'networkidle'; timeoutMs?: number; retries?: number; url?: string }
): Promise<void> {
  const waitUntil = options?.waitUntil ?? 'domcontentloaded';
  const timeoutMs = options?.timeoutMs ?? 60000;
  const retries = resolveNavigationRetries(options?.url ?? page.url(), options?.retries);
  const targetUrl = options?.url ?? page.url();

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      await page.reload({ waitUntil, timeout: timeoutMs });
      return;
    } catch {
      try {
        await safeGoto(page, targetUrl, { waitUntil, timeoutMs, retries: Math.max(0, retries - attempt - 1) });
        return;
      } catch (err) {
        if (attempt === retries - 1) {
          throw err;
        }
      }
    }
  }
}
