import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_PUBLIC_RELAYS } from '@iris/hashtree-app/defaultRelays';

const persistence = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));

vi.mock('dexie', () => ({
  default: class {
    settings = persistence;
    version() { return { stores: () => { this.settings = persistence; return this; } }; }
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_TEST_MODE', '');
  vi.stubGlobal('window', {
    location: { protocol: 'https:', hostname: 'drive.example', origin: 'https://drive.example', search: '' },
  });
  persistence.get.mockReset().mockResolvedValue(undefined);
  persistence.put.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('persisted network settings on a public host', () => {
  test.each([
    { name: 'empty', relays: [] },
    { name: 'local only', relays: ['ws://127.0.0.1:7777'] },
    { name: 'a shipped relay subset', relays: [DEFAULT_PUBLIC_RELAYS[0]] },
    { name: 'custom only', relays: ['wss://relay.example'] },
  ])('preserves $name choices and an empty file-server list', async ({ relays }) => {
    const saved = { relays, blossomServers: [], negentropyEnabled: true };
    persistence.get.mockImplementation(async key => key === 'network' ? { key, value: saved } : undefined);
    const { settingsStore, waitForSettingsLoaded } = await import('../src/stores/settings');
    await waitForSettingsLoaded();
    expect(settingsStore.getState().network).toEqual(saved);
    expect(settingsStore.getState().networkLoaded).toBe(true);
  });

  test('uses shipped network defaults when no network row exists', async () => {
    const { settingsStore, waitForSettingsLoaded, DEFAULT_NETWORK_SETTINGS } = await import('../src/stores/settings');
    await waitForSettingsLoaded();
    expect(settingsStore.getState().network).toEqual(DEFAULT_NETWORK_SETTINGS);
  });

  test('does not add endpoint defaults to an existing partial row', async () => {
    persistence.get.mockImplementation(async key => key === 'network'
      ? { key, value: { negentropyEnabled: true } } : undefined);
    const { settingsStore, waitForSettingsLoaded } = await import('../src/stores/settings');
    await waitForSettingsLoaded();
    expect(settingsStore.getState().network).toEqual({ relays: [], blossomServers: [], negentropyEnabled: true });
  });

  test.each([{ value: null }, { value: undefined }, { value: [] }])(
    'rejects an invalid existing row instead of granting default endpoints: $value', async ({ value }) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      persistence.get.mockImplementation(async key => key === 'network' ? { key, value } : undefined);
      try {
        const { settingsStore, waitForSettingsLoaded } = await import('../src/stores/settings');
        await expect(waitForSettingsLoaded()).rejects.toThrow('Saved network settings are invalid');
        expect(settingsStore.getState().networkLoaded).toBe(false);
      } finally {
        vi.restoreAllMocks();
      }
    },
  );

  test('keeps legacy saved file servers while preserving an empty relay list', async () => {
    persistence.get.mockImplementation(async key => key === 'network' ? {
      key, value: { relays: [], blossomServers: ['https://files.example'] },
    } : undefined);
    const { settingsStore, waitForSettingsLoaded } = await import('../src/stores/settings');
    await waitForSettingsLoaded();
    expect(settingsStore.getState().network).toEqual({
      relays: [], blossomServers: [{ url: 'https://files.example', read: true, write: false }],
      negentropyEnabled: false,
    });
  });

  test('reports a failed read instead of treating it as an absent network row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    persistence.get.mockImplementation(async key => {
      if (key === 'network') throw new Error('saved settings unavailable');
      return undefined;
    });
    try {
      const { settingsStore, waitForSettingsLoaded } = await import('../src/stores/settings');
      await expect(waitForSettingsLoaded()).rejects.toThrow('saved settings unavailable');
      expect(settingsStore.getState().networkLoaded).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
