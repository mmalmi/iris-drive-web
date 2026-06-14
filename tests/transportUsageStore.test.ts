import { describe, expect, it } from 'vitest';
import {
  TransportUsageLedger,
  createEmptyTransportUsageMap,
  getTransportUsageTotals,
} from '../src/stores/transportUsage';

class MemoryStorage {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

describe('TransportUsageLedger', () => {
  it('counts the first persisted snapshot into lifetime but not current runtime session', () => {
    const ledger = new TransportUsageLedger(new MemoryStorage());
    const snapshot = ledger.recordSource('blossom:total', 'blossom', 1_024, 2_048, 1_000);

    expect(snapshot.session).toEqual(createEmptyTransportUsageMap());
    expect(snapshot.lifetime.blossom).toMatchObject({
      bytesSent: 1_024,
      bytesReceived: 2_048,
    });
  });

  it('tracks deltas after the initial baseline for the current runtime session', () => {
    const ledger = new TransportUsageLedger(new MemoryStorage());
    ledger.recordSource('relay:wss://relay.example', 'relay', 100, 200, 1_000);

    const snapshot = ledger.recordSource('relay:wss://relay.example', 'relay', 160, 260, 2_000);

    expect(snapshot.session.relay).toMatchObject({
      bytesSent: 60,
      bytesReceived: 60,
    });
    expect(snapshot.lifetime.relay).toMatchObject({
      bytesSent: 160,
      bytesReceived: 260,
    });
  });

  it('does not double-count persisted totals across reloads for the same running source', () => {
    const storage = new MemoryStorage();
    const first = new TransportUsageLedger(storage);
    first.recordSource('peer:daemon:webrtc:alice', 'webrtc', 512, 256, 1_000);
    first.recordSource('peer:daemon:webrtc:alice', 'webrtc', 1_024, 768, 2_000);

    const second = new TransportUsageLedger(storage);
    const snapshot = second.recordSource('peer:daemon:webrtc:alice', 'webrtc', 1_024, 768, 3_000);

    expect(snapshot.session.webrtc).toMatchObject({
      bytesSent: 0,
      bytesReceived: 0,
    });
    expect(snapshot.lifetime.webrtc).toMatchObject({
      bytesSent: 1_024,
      bytesReceived: 768,
    });
  });

  it('treats lower counters as a new backend session and starts accumulating again', () => {
    const storage = new MemoryStorage();
    const ledger = new TransportUsageLedger(storage);
    ledger.recordSource('peer:daemon:bluetooth:bob', 'bluetooth', 400, 500, 1_000);
    ledger.recordSource('peer:daemon:bluetooth:bob', 'bluetooth', 800, 900, 2_000);

    const snapshot = ledger.recordSource('peer:daemon:bluetooth:bob', 'bluetooth', 40, 50, 3_000);

    expect(snapshot.session.bluetooth).toMatchObject({
      bytesSent: 440,
      bytesReceived: 450,
    });
    expect(snapshot.lifetime.bluetooth).toMatchObject({
      bytesSent: 840,
      bytesReceived: 950,
    });
  });

  it('sums grouped transport totals', () => {
    const ledger = new TransportUsageLedger(new MemoryStorage());
    ledger.recordSource('relay:one', 'relay', 100, 200, 1_000);
    ledger.recordSource('blossom:total', 'blossom', 300, 400, 1_500);
    ledger.recordSource('relay:one', 'relay', 130, 260, 2_000);
    ledger.recordSource('peer:one', 'webrtc', 20, 10, 2_500);
    ledger.recordSource('peer:one', 'webrtc', 50, 30, 3_000);

    const totals = getTransportUsageTotals(ledger.recordSource('peer:two', 'bluetooth', 5, 6, 3_500));

    expect(totals.lifetime).toMatchObject({
      bytesSent: 485,
      bytesReceived: 696,
    });
    expect(totals.session).toMatchObject({
      bytesSent: 60,
      bytesReceived: 80,
    });
  });
});
