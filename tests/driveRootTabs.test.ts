import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isLatestAnnouncedRoot } from '../src/lib/driveRootTabs';

const shared = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../src/lib/keyValueStore', () => ({ keyValueStore: () => ({ get: shared.get }) }));
vi.mock('../src/TreeRootRegistry', () => ({ treeRootRegistry: {} }));

const hash = new Uint8Array([1]);
const key = new Uint8Array([2]);

describe('queued roots and other tabs', () => {
  beforeEach(() => shared.get.mockReset());

  it('accepts the exact shared root and its key, or a root not announced yet', async () => {
    shared.get.mockResolvedValue({ hash: '01', rootKey: '02' });
    expect(await isLatestAnnouncedRoot('profile', 'main', hash, key)).toBe(true);
    expect(await isLatestAnnouncedRoot('profile', 'main', hash, new Uint8Array([3]))).toBe(false);
    shared.get.mockResolvedValue(undefined);
    expect(await isLatestAnnouncedRoot('profile', 'main', hash, key)).toBe(true);
  });

  it('reads the shared record anew even when the other tab broadcast has not arrived', async () => {
    shared.get.mockResolvedValueOnce({ hash: '01', rootKey: '02' });
    expect(await isLatestAnnouncedRoot('profile', 'main', hash, key)).toBe(true);
    shared.get.mockResolvedValueOnce({ hash: '03', rootKey: '02' });
    expect(await isLatestAnnouncedRoot('profile', 'main', hash, key)).toBe(false);
  });

  it('does not claim a root is current when the shared record cannot be read', async () => {
    shared.get.mockRejectedValue(new Error('Storage unavailable'));
    await expect(isLatestAnnouncedRoot('profile', 'main', hash, key)).rejects.toThrow('Storage unavailable');
  });
});
