import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BLOB_DEFAULT_HTL } from '@hashtree/core';
import { getPublicKey } from 'nostr-tools';

const browserProviderFactory = vi.hoisted(() => vi.fn());

vi.mock('@hashtree/dexie', () => ({
  DexieStore: class {
    close(): void {}
  },
}));

vi.mock('@hashtree/fips-transport/browser', () => ({
  createBrowserHashtreeNostrProvider: browserProviderFactory,
}));

import { DriveFipsRuntime } from '../src/lib/driveFipsRuntime';

type ProviderOptions = {
  nostrPeers?: () => string[];
  providerRoutes?: () => Promise<Array<{ peerId: string; htl: number }>>;
  allowIncomingPeer?: (peerId: string) => boolean | Promise<boolean>;
};

function secretKey(seed: number): Uint8Array {
  const secret = new Uint8Array(32);
  secret[31] = seed;
  return secret;
}

function installBrowserProviderFake(remoteBytes = new Uint8Array([7, 8, 9])) {
  const listeners = new Map<string, (event: unknown) => unknown>();
  const connect = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const transport = { connect, close };
  let providerOptions: ProviderOptions | undefined;

  browserProviderFactory.mockImplementation(async (options: ProviderOptions) => {
    providerOptions = options;
    return {
      fetch: vi.fn(async () => {
        const routes = await options.providerRoutes?.() ?? [];
        return routes.length > 0 ? remoteBytes : null;
      }),
      listPeerIds: vi.fn(async () => (
        (await options.providerRoutes?.() ?? []).map(({ peerId }) => peerId)
      )),
      node: {
        on: vi.fn((event: string, listener: (value: unknown) => unknown) => {
          listeners.set(event, listener);
          return () => listeners.delete(event);
        }),
      },
      nostrSource: { id: 'fips' },
      refreshNostrPeers: vi.fn(),
      webRtcTransport: transport,
      webSocketTransport: {},
      stop: vi.fn(async () => undefined),
    };
  });

  return {
    connect,
    close,
    transport,
    emit(event: string, value: unknown) {
      return listeners.get(event)?.(value);
    },
    get providerOptions() {
      return providerOptions;
    },
  };
}

describe('Drive FIPS provider authorization', () => {
  beforeEach(() => {
    browserProviderFactory.mockReset();
    vi.stubGlobal('window', {});
    vi.stubGlobal('indexedDB', {});
    vi.stubGlobal('WebSocket', class {});
    vi.stubGlobal('RTCPeerConnection', class {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('fetches a remote-only block through dynamically authorized AppKey routes', async () => {
    const fake = installBrowserProviderFake();
    const localSecret = secretKey(11);
    const localPubkey = getPublicKey(localSecret);
    const remotePubkey = getPublicKey(secretKey(12));
    const runtime = new DriveFipsRuntime({
      relays: ['wss://relay.example'],
      deviceSecretKey: localSecret,
      profileId: '89f3d04f-41fb-437b-9339-75df537bf291',
      authorizedAppKeyPubkeys: () => [localPubkey, remotePubkey],
    });

    await runtime.start();
    expect(runtime.getNostrSource()).toBe(runtime.getP2PProvider().nostrSource);
    const fetched = await runtime.getP2PProvider().fetch('ab'.repeat(32));

    expect(fetched).toEqual(new Uint8Array([7, 8, 9]));
    await expect(fake.providerOptions?.providerRoutes?.()).resolves.toEqual([
      {
        peerId: `02${remotePubkey}`,
        htl: BLOB_DEFAULT_HTL,
      },
      {
        peerId: `03${remotePubkey}`,
        htl: BLOB_DEFAULT_HTL,
      },
    ]);
    await runtime.stop();
  });

  test('rejects and retires same-scope peers outside the current AppKey roster', async () => {
    const fake = installBrowserProviderFake();
    const localSecret = secretKey(21);
    const localPubkey = getPublicKey(localSecret);
    const allowedPubkey = getPublicKey(secretKey(22));
    const deniedPubkey = getPublicKey(secretKey(23));
    let authorized = [localPubkey, allowedPubkey];
    const runtime = new DriveFipsRuntime({
      relays: ['wss://relay.example'],
      deviceSecretKey: localSecret,
      profileId: '89f3d04f-41fb-437b-9339-75df537bf291',
      authorizedAppKeyPubkeys: () => authorized,
    });
    await runtime.start();

    expect(fake.providerOptions?.nostrPeers?.()).toEqual([]);
    await expect(fake.transport.connect({ transport: 'webrtc', addr: `02${deniedPubkey}` }))
      .rejects.toThrow(/not authorized/i);
    await expect(fake.transport.connect({ transport: 'webrtc', addr: `02${allowedPubkey}` }))
      .resolves.toBeUndefined();
    await expect(fake.providerOptions?.allowIncomingPeer?.(`03${deniedPubkey}`))
      .resolves.toBe(false);
    await expect(fake.providerOptions?.allowIncomingPeer?.(`03${allowedPubkey}`))
      .resolves.toBe(true);

    fake.emit('peer', { remotePubkey: `02${deniedPubkey}`, state: 'connected' });
    await vi.waitFor(() => {
      expect(fake.close).toHaveBeenCalledWith({
        transport: 'webrtc',
        addr: `02${deniedPubkey}`,
      });
    });
    expect(runtime.getStats().connectedPeerIds).not.toContain(`02${deniedPubkey}`);

    fake.emit('peer', { remotePubkey: `02${allowedPubkey}`, state: 'connected' });
    await vi.waitFor(() => expect(fake.providerOptions?.nostrPeers?.()).toEqual([`02${allowedPubkey}`]));
    expect(fake.providerOptions?.nostrPeers?.()).not.toContain(`02${deniedPubkey}`);

    authorized = [localPubkey];
    await expect(fake.providerOptions?.providerRoutes?.()).resolves.toEqual([]);
    fake.emit('peer', { remotePubkey: `02${allowedPubkey}`, state: 'connected' });
    await vi.waitFor(() => {
      expect(fake.close).toHaveBeenCalledWith({
        transport: 'webrtc',
        addr: `02${allowedPubkey}`,
      });
    });
    expect(fake.providerOptions?.nostrPeers?.()).toEqual([]);
    await runtime.stop();
  });
});
