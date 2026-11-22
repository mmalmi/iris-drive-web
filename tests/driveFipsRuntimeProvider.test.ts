import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { BLOB_DEFAULT_HTL } from '@hashtree/core';
import { getPublicKey } from 'nostr-tools';

const browserProviderFactory = vi.hoisted(() => vi.fn());

vi.mock('../src/lib/driveFipsRosterDiscovery', () => ({
  followDriveRosterPeers: async () => async () => {},
}));

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
  discoveryApp?: string;
  nostrPeers?: () => string[];
  providerRoutes?: () => Promise<Array<{ peerId: string; htl: number }>>;
  allowIncomingPeer?: (peerId: string) => boolean | Promise<boolean>;
};

function secretKey(seed: number): Uint8Array {
  const secret = new Uint8Array(32);
  secret[31] = seed;
  return secret;
}

function installBrowserProviderFake(
  remoteBytes = new Uint8Array([7, 8, 9]),
  advertisedPeerIds: string[] = [],
) {
  const listeners = new Map<string, (event: unknown) => unknown>();
  const connect = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  const refreshNostrPeers = vi.fn();
  const setPreferredAutoConnectPeers = vi.fn();
  const transport = { connect, close, setPreferredAutoConnectPeers };
  let providerOptions: ProviderOptions | undefined;

  browserProviderFactory.mockImplementation(async (options: ProviderOptions) => {
    providerOptions = options;
    return {
      fetch: vi.fn(async () => {
        const routes = await options.providerRoutes?.() ?? [];
        return routes.length > 0 || advertisedPeerIds.length > 0 ? remoteBytes : null;
      }),
      listPeerIds: vi.fn(async () => (
        [...new Set([
          ...(await options.providerRoutes?.() ?? []).map(({ peerId }) => peerId),
          ...advertisedPeerIds,
        ])]
      )),
      node: {
        on: vi.fn((event: string, listener: (value: unknown) => unknown) => {
          listeners.set(event, listener);
          return () => listeners.delete(event);
        }),
      },
      nostrSource: { id: 'fips' },
      listConnectedPeerIds: () => [...advertisedPeerIds],
      refreshNostrPeers,
      webRtcTransport: transport,
      webSocketTransport: {},
      stop: vi.fn(async () => undefined),
    };
  });

  return {
    connect,
    close,
    refreshNostrPeers,
    setPreferredAutoConnectPeers,
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
    vi.useRealTimers();
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

  test("dials the account's other devices first, following the roster", async () => {
    vi.useFakeTimers();
    const fake = installBrowserProviderFake();
    const localSecret = secretKey(31);
    const localPubkey = getPublicKey(localSecret);
    const otherDevice = getPublicKey(secretKey(32));
    let roster = [localPubkey, otherDevice];
    const runtime = new DriveFipsRuntime({
      relays: ['wss://relay.example'],
      deviceSecretKey: localSecret,
      profileId: '89f3d04f-41fb-437b-9339-75df537bf291',
      authorizedAppKeyPubkeys: () => roster,
    });
    await runtime.start();
    await vi.waitFor(() => expect(fake.setPreferredAutoConnectPeers).toHaveBeenLastCalledWith([`02${otherDevice}`, `03${otherDevice}`]));

    // A removed device is no longer preferred.
    roster = [localPubkey];
    runtime.refreshAuthorization();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.setPreferredAutoConnectPeers).toHaveBeenLastCalledWith([]);
    await runtime.stop();
  });

  test('counts both key parities under one peer and retains a surviving carrier', async () => {
    const peerId = getPublicKey(secretKey(12));
    const wsKey = `03${peerId}`, rtcKey = `02${peerId}`;
    const fake = installBrowserProviderFake(undefined, [wsKey]);
    const runtime = new DriveFipsRuntime({
      relays: ['wss://relay.example'], deviceSecretKey: secretKey(11),
      authorizedAppKeyPubkeys: () => [peerId],
    });
    await runtime.start();
    try {
      await fake.emit('peer', { peerId, remotePubkey: rtcKey, state: 'connected' });
      await fake.emit('session', { peerId, remotePubkey: rtcKey, state: 'established' });
      await fake.emit('datagram', { peerId, src: wsKey });
      await fake.emit('peer', { peerId, remotePubkey: rtcKey, state: 'disconnected' });
      expect(runtime.getStats().peers).toEqual([expect.objectContaining({
        peerId: wsKey, xOnlyPubkey: peerId, sessionsEstablished: 1, connected: true,
      })]);
    } finally { await runtime.stop(); }
  });

  test('keeps shared block links while revoking private event peers', async () => {
    vi.useFakeTimers();
    const localSecret = secretKey(21);
    const localPubkey = getPublicKey(localSecret);
    const allowedPubkey = getPublicKey(secretKey(22));
    const unrelatedPubkey = getPublicKey(secretKey(23));
    const unrelatedPeer = `02${unrelatedPubkey}`;
    const allowedPeer = `02${allowedPubkey}`;
    const fake = installBrowserProviderFake(new Uint8Array([7, 8, 9]), [unrelatedPeer]);
    let authorized = [localPubkey, allowedPubkey];
    const runtime = new DriveFipsRuntime({
      relays: ['wss://relay.example'],
      deviceSecretKey: localSecret,
      profileId: '89f3d04f-41fb-437b-9339-75df537bf291',
      authorizedAppKeyPubkeys: () => authorized,
    });
    await runtime.start();

    expect(fake.providerOptions?.discoveryApp).toBe('fips-overlay-v1');
    expect(fake.providerOptions?.nostrPeers?.()).toEqual([]);
    expect(fake.transport.connect).toBe(fake.connect);
    expect(fake.providerOptions?.allowIncomingPeer).toBeUndefined();
    await expect(fake.transport.connect({ transport: 'webrtc', addr: unrelatedPeer }))
      .resolves.toBeUndefined();
    expect(runtime.getStats().connectedPeerIds).toContain(unrelatedPeer);
    fake.emit('peer', { remotePubkey: allowedPeer, state: 'connected' });
    await vi.waitFor(() => expect(fake.providerOptions?.nostrPeers?.()).toEqual([allowedPeer]));
    expect(runtime.getStats().nostrPeerIds).toEqual([allowedPeer]);

    authorized = [localPubkey];
    await expect(fake.providerOptions?.providerRoutes?.()).resolves.toEqual([]);
    // The app calls this the moment the live roster changes.
    runtime.refreshAuthorization();
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.providerOptions?.nostrPeers?.()).toEqual([]);
    expect(runtime.getStats().nostrPeerIds).toEqual([]);
    expect(runtime.getStats().connectedPeerIds).toEqual([allowedPeer, unrelatedPeer].sort());
    expect(fake.close).not.toHaveBeenCalled();
    await expect(runtime.getP2PProvider().listPeerIds()).resolves.toContain(unrelatedPeer);
    await expect(runtime.getP2PProvider().fetch('ab'.repeat(32))).resolves.toEqual(new Uint8Array([7, 8, 9]));
    await runtime.stop();
  });

  test('expires authenticated routed presence while keeping direct and roster authorization separate', async () => {
    vi.useFakeTimers();
    const local = secretKey(31);
    const peer = `02${getPublicKey(secretKey(56))}`;
    const fake = installBrowserProviderFake();
    const runtime = new DriveFipsRuntime({
      relays: ['wss://relay.example'], deviceSecretKey: local,
      authorizedAppKeyPubkeys: () => [peer.slice(2)],
    });
    await runtime.start();
    fake.emit('session', { remotePubkey: peer, state: 'established' });
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.getStats().connectedPeerIds).toEqual([]);
    expect(runtime.getStats().nostrPeerIds).toEqual([peer]);
    expect(runtime.getStats().peers[0].routedOnline).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    fake.emit('datagram', { src: peer });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(runtime.getStats().peers[0].routedOnline).toBe(true);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(runtime.getStats().peers[0].routedOnline).toBe(false);
    fake.emit('datagram', { src: peer });
    fake.emit('session', { remotePubkey: peer, state: 'closed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.getStats().peers[0].routedOnline).toBe(false);
    expect(runtime.getStats().nostrPeerIds).toEqual([]);
    await runtime.stop();
  });

  test('fails closed for private events if roster refresh fails without closing block links', async () => {
    vi.useFakeTimers();
    const localSecret = secretKey(31);
    const remotePubkey = getPublicKey(secretKey(32));
    const remotePeer = `02${remotePubkey}`;
    let unavailable = false;
    const fake = installBrowserProviderFake(new Uint8Array([7, 8, 9]), [remotePeer]);
    const runtime = new DriveFipsRuntime({
      relays: ['wss://relay.example'],
      deviceSecretKey: localSecret,
      authorizedAppKeyPubkeys: async () => {
        if (unavailable) throw new Error('roster unavailable');
        return [getPublicKey(localSecret), remotePubkey];
      },
    });
    await runtime.start();
    expect(fake.providerOptions?.nostrPeers?.()).toEqual([remotePeer]);
    unavailable = true;
    // Checked again now and then even when nothing happens.
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(fake.providerOptions?.nostrPeers?.()).toEqual([]);
    expect(runtime.getStats().connectedPeerIds).toEqual([remotePeer]);
    expect(fake.close).not.toHaveBeenCalled();
    await runtime.stop();
  });

  test('does not restore stale event authority after an overlapping refresh or stop', async () => {
    const localSecret = secretKey(41);
    const localPubkey = getPublicKey(localSecret);
    const remotePubkey = getPublicKey(secretKey(42));
    const remotePeer = `02${remotePubkey}`;
    const fake = installBrowserProviderFake(new Uint8Array([7, 8, 9]), [remotePeer]);
    let readAuthorization: () => string[] | Promise<string[]> = () => [localPubkey, remotePubkey];
    const runtime = new DriveFipsRuntime({
      relays: ['wss://relay.example'],
      deviceSecretKey: localSecret,
      authorizedAppKeyPubkeys: () => readAuthorization(),
    });
    await runtime.start();
    expect(fake.providerOptions?.nostrPeers?.()).toEqual([remotePeer]);

    let finishOldRead!: (peers: string[]) => void;
    const oldRead = new Promise<string[]>((resolve) => { finishOldRead = resolve; });
    readAuthorization = () => oldRead;
    fake.emit('peer', { remotePubkey: remotePeer, state: 'connected' });
    readAuthorization = () => [localPubkey];
    fake.emit('peer', { remotePubkey: remotePeer, state: 'connected' });
    await vi.waitFor(() => expect(fake.refreshNostrPeers).toHaveBeenCalledTimes(2));
    expect(fake.providerOptions?.nostrPeers?.()).toEqual([]);
    finishOldRead([localPubkey, remotePubkey]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.providerOptions?.nostrPeers?.()).toEqual([]);
    expect(fake.refreshNostrPeers).toHaveBeenCalledTimes(2);

    let finishStoppedRead!: (peers: string[]) => void;
    const stoppedRead = new Promise<string[]>((resolve) => { finishStoppedRead = resolve; });
    readAuthorization = () => stoppedRead;
    fake.emit('peer', { remotePubkey: remotePeer, state: 'connected' });
    await runtime.stop();
    finishStoppedRead([localPubkey, remotePubkey]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.providerOptions?.nostrPeers?.()).toEqual([]);
    expect(fake.refreshNostrPeers).toHaveBeenCalledTimes(2);
    expect(runtime.getStats().active).toBe(false);
  });
});
