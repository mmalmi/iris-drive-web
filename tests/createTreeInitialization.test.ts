import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cid, fromHex } from '@hashtree/core';

const PROFILE_ID = '123e4567-e89b-42d3-a456-426614174170';
const APP_KEY = 'a'.repeat(64);
const EMPTY_ROOT = cid(fromHex('11'.repeat(32)), fromHex('12'.repeat(32)));
const UPLOADED_ROOT = cid(fromHex('21'.repeat(32)), fromHex('22'.repeat(32)));

const mocks = vi.hoisted(() => ({
  putDirectory: vi.fn(),
  saveHashtree: vi.fn(),
  getLocalRootCache: vi.fn(),
  setSelectedTree: vi.fn(),
}));

vi.mock('../src/store', () => ({
  getTree: () => ({ putDirectory: mocks.putDirectory }),
  localStore: {},
}));

vi.mock('../src/nostr', () => ({
  autosaveIfOwn: vi.fn(),
  linkKeyUtils: {},
  saveHashtree: mocks.saveHashtree,
  useNostrStore: {
    getState: () => ({
      isLoggedIn: true,
      npub: 'npub1appkey',
      pubkey: APP_KEY,
      selectedTree: null,
    }),
    setSelectedTree: mocks.setSelectedTree,
  },
}));

vi.mock('../src/treeRootCache', () => ({
  getLocalRootCache: mocks.getLocalRootCache,
  updateLocalRootCache: vi.fn(),
}));

vi.mock('../src/stores/trees', () => ({
  storeLinkKey: vi.fn(),
}));

vi.mock('../src/drive/profileRoute', () => ({
  activeNostrIdentityRootScope: () => PROFILE_ID,
  isActiveNostrIdentityRouteScope: () => true,
}));

vi.mock('../src/utils/navigate', () => ({
  navigate: vi.fn(),
}));

vi.mock('../src/actions/route', () => ({
  getCurrentPathFromUrl: () => [],
  getCurrentRootCid: () => null,
}));

import { createTree } from '../src/actions/tree';

describe('background tree initialization', () => {
  beforeEach(() => {
    mocks.putDirectory.mockReset().mockResolvedValue({ cid: EMPTY_ROOT });
    mocks.saveHashtree.mockReset().mockResolvedValue({ success: true });
    mocks.getLocalRootCache.mockReset().mockReturnValue(UPLOADED_ROOT.hash);
    mocks.setSelectedTree.mockReset();
  });

  it('does not overwrite a root that appeared while the empty tree was being created', async () => {
    const result = await createTree('main', 'private', true);

    expect(result).toEqual({ success: true });
    expect(mocks.getLocalRootCache).toHaveBeenCalledWith(PROFILE_ID, 'main');
    expect(mocks.saveHashtree).not.toHaveBeenCalled();
    expect(mocks.setSelectedTree).not.toHaveBeenCalled();
  });
});
