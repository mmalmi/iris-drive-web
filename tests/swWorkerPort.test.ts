import { describe, expect, it, vi } from 'vitest';
import { lookupWorkerPort, waitForWorkerPort } from '../src/lib/swWorkerPort';

describe('sw worker port lookup', () => {
  it('prefers the client-key port over client id and default', () => {
    const byClientId = new Map([['client-a', 'id-port']]);
    const byClientKey = new Map([['key-a', 'key-port']]);

    expect(
      lookupWorkerPort({ byClientId, byClientKey, defaultPort: 'default-port' }, 'client-a', 'key-a'),
    ).toBe('key-port');
  });

  it('falls back to the client id port and then default', () => {
    const byClientId = new Map([['client-a', 'id-port']]);
    const byClientKey = new Map<string, string>();

    expect(
      lookupWorkerPort({ byClientId, byClientKey, defaultPort: 'default-port' }, 'client-a', null),
    ).toBe('id-port');
    expect(
      lookupWorkerPort({ byClientId, byClientKey, defaultPort: 'default-port' }, 'client-b', null),
    ).toBe('default-port');
  });
});

describe('sw worker port wait', () => {
  it('waits for a delayed port registration', async () => {
    vi.useFakeTimers();

    let port: string | null = null;
    const waiter = waitForWorkerPort(() => port, { timeoutMs: 1000, intervalMs: 20 });

    setTimeout(() => {
      port = 'ready-port';
    }, 120);

    await vi.advanceTimersByTimeAsync(120);
    await expect(waiter).resolves.toBe('ready-port');
  });

  it('returns null when no port arrives before timeout', async () => {
    vi.useFakeTimers();

    const waiter = waitForWorkerPort(() => null, { timeoutMs: 100, intervalMs: 20 });

    await vi.advanceTimersByTimeAsync(100);
    await expect(waiter).resolves.toBeNull();
  });
});
