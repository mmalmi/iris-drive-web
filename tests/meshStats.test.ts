import { describe, expect, it } from 'vitest';
import {
  advanceMeshBandwidthHistory,
  mergeMeshPeers,
  normalizeWorkerPeerStats,
  parseDaemonMeshSnapshot,
} from '../src/lib/meshStats';

describe('mesh stats helpers', () => {
  it('parses daemon mesh stats with bluetooth transport metadata', () => {
    const stats = parseDaemonMeshSnapshot({
      status: 'running',
      mesh: {
        enabled: true,
        bytes_sent: 512,
        bytes_received: 1024,
        transport_counts: {
          webrtc: 1,
          bluetooth: 1,
        },
        peers: [
          {
            peer_id: 'npub-peer',
            pubkey: 'npub-peer',
            state: 'connected',
            pool: 'follows',
            transport: 'bluetooth',
            signal_paths: ['bluetooth'],
            bytes_sent: 128,
            bytes_received: 256,
          },
        ],
      },
      relay: {
        bytes_sent: 2048,
        bytes_received: 4096,
      },
    });

    expect(stats.enabled).toBe(true);
    expect(stats.totalBytesSent).toBe(512);
    expect(stats.totalBytesReceived).toBe(1024);
    expect(stats.transportCounts.bluetooth).toBe(1);
    expect(stats.relayBytesSent).toBe(2048);
    expect(stats.relayBytesReceived).toBe(4096);
    expect(stats.peers).toEqual([
      {
        id: 'daemon:bluetooth:npub-peer',
        peerId: 'npub-peer',
        pubkey: 'npub-peer',
        state: 'connected',
        pool: 'follows',
        bytesSent: 128,
        bytesReceived: 256,
        transport: 'bluetooth',
        source: 'daemon',
        signalPaths: ['bluetooth'],
      },
    ]);
  });

  it('does not expose daemon-only fips status as browser mesh peers', () => {
    const stats = parseDaemonMeshSnapshot({
      status: 'running',
      capabilities: {
        fips: true,
        fetch_from_fips_peers: true,
      },
      fips: {
        enabled: true,
        fetch_from_peers: true,
        total_peers: 2,
        peers: [
          'npub-fips-a',
          {
            peer_id: 'npub-fips-b',
            pubkey: 'npub-fips-b',
            pool: 'follows',
            signal_paths: ['nostr'],
          },
        ],
      },
    });

    expect(stats.enabled).toBe(false);
    expect(stats.transportCounts).toEqual({ webrtc: 0, bluetooth: 0 });
    expect(stats.peers).toEqual([]);
  });

  it('normalizes and merges worker peers with deterministic ids', () => {
    const workerPeers = normalizeWorkerPeerStats([
      {
        peerId: 'worker-peer',
        pubkey: 'worker-peer',
        connected: true,
        pool: 'other',
        bytesSent: 64,
        bytesReceived: 96,
      },
    ]);

    const merged = mergeMeshPeers(workerPeers, [
      {
        id: 'daemon:bluetooth:daemon-peer',
        peerId: 'daemon-peer',
        pubkey: 'daemon-peer',
        state: 'connected',
        pool: 'follows',
        bytesSent: 32,
        bytesReceived: 48,
        transport: 'bluetooth',
        source: 'daemon',
        signalPaths: ['bluetooth'],
      },
    ]);

    expect(merged.map((peer) => peer.id)).toEqual([
      'daemon:bluetooth:daemon-peer',
      'worker:webrtc:worker-peer',
    ]);
    expect(merged[1]?.signalPaths).toEqual(['relay']);
  });

  it('tracks upload and download history from cumulative totals', () => {
    const first = advanceMeshBandwidthHistory(
      null,
      [],
      { totalBytesSent: 100, totalBytesReceived: 200 },
      1_000,
      3,
    );
    expect(first.rates).toEqual({ uploadBps: 0, downloadBps: 0 });
    expect(first.history).toHaveLength(1);

    const second = advanceMeshBandwidthHistory(
      first.nextCursor,
      first.history,
      { totalBytesSent: 700, totalBytesReceived: 500 },
      3_000,
      3,
    );
    expect(second.rates.uploadBps).toBe(300);
    expect(second.rates.downloadBps).toBe(150);
    expect(second.history.at(-1)).toMatchObject({
      uploadBps: 300,
      downloadBps: 150,
    });

    const third = advanceMeshBandwidthHistory(
      second.nextCursor,
      second.history,
      { totalBytesSent: 900, totalBytesReceived: 900 },
      4_000,
      2,
    );
    expect(third.history).toHaveLength(2);
    expect(third.history[0]?.timestamp).toBe(3_000);
    expect(third.history[1]?.uploadBps).toBe(200);
    expect(third.history[1]?.downloadBps).toBe(400);
  });
});
