import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cid, fromHex, nhashEncode, toHex } from '@hashtree/core';

const { getWorkerAdapterMock, waitForWorkerAdapterMock, getTreeRootInfoMock } = vi.hoisted(() => ({
  getWorkerAdapterMock: vi.fn(),
  waitForWorkerAdapterMock: vi.fn(),
  getTreeRootInfoMock: vi.fn(),
}));

vi.mock('../src/lib/workerInit', () => ({
  getWorkerAdapter: getWorkerAdapterMock,
  waitForWorkerAdapter: waitForWorkerAdapterMock,
}));

import {
  buildPreferredTreeEventHref,
  buildTreeRouteHref,
  buildTreeEventPermalink,
  isNewerTreeEventSnapshot,
  resolveSnapshotRootCid,
  snapshotMatchesRootCid,
  type TreeEventSnapshotInfo,
} from '../src/lib/treeEventSnapshots';

const SNAPSHOT_NHASH = nhashEncode(new Uint8Array(32).fill(6));
const WORKER_SNAPSHOT_NHASH = nhashEncode(new Uint8Array(32).fill(7));

function makeSnapshot(overrides: Partial<TreeEventSnapshotInfo> = {}): TreeEventSnapshotInfo {
  const rootCid = cid(fromHex('1'.repeat(64)), fromHex('2'.repeat(64)));
  return {
    event: {
      id: '3'.repeat(64),
      pubkey: '4'.repeat(64),
      created_at: 1_700_000_000,
      kind: 30078,
      tags: [
        ['d', 'videos/demo'],
        ['l', 'hashtree'],
        ['hash', '1'.repeat(64)],
        ['key', '2'.repeat(64)],
      ],
      content: '',
      sig: '5'.repeat(128),
    },
    treeName: 'videos/demo',
    rootCid,
    visibility: 'public',
    labels: ['hashtree'],
    snapshotCid: cid(fromHex('6'.repeat(64))),
    snapshotNhash: SNAPSHOT_NHASH,
    npub: 'npub1example',
    ...overrides,
  };
}

describe('tree event snapshots', () => {
  beforeEach(() => {
    getWorkerAdapterMock.mockReset();
    waitForWorkerAdapterMock.mockReset();
    getTreeRootInfoMock.mockReset();
    waitForWorkerAdapterMock.mockResolvedValue(null);
  });

  it('builds snapshot permalink routes with preserved path and link key', () => {
    const href = buildTreeEventPermalink(
      makeSnapshot(),
      ['nested folder', 'video.mp4'],
      'a'.repeat(64),
    );

    expect(href).toBe(`#/${SNAPSHOT_NHASH}/nested%20folder/video.mp4?snapshot=1&k=${'a'.repeat(64)}`);
  });

  it('builds mutable user-tree hrefs as a fallback', () => {
    expect(buildTreeRouteHref('npub1example', 'videos/demo', ['nested folder', 'video.mp4'], 'a'.repeat(64)))
      .toBe('#/npub1example/videos%2Fdemo/nested%20folder/video.mp4?k=' + 'a'.repeat(64));
  });

  it('prefers worker snapshot nhashes before fetching relay snapshots', async () => {
    getTreeRootInfoMock.mockResolvedValue({
      snapshotNhash: WORKER_SNAPSHOT_NHASH,
    });
    getWorkerAdapterMock.mockReturnValue({
      getTreeRootInfo: getTreeRootInfoMock,
    });

    const href = await buildPreferredTreeEventHref(
      'npub1example',
      'videos/demo',
      ['nested folder', 'video.mp4'],
      'a'.repeat(64),
    );

    expect(href).toBe(`#/${WORKER_SNAPSHOT_NHASH}/nested%20folder/video.mp4?snapshot=1&k=${'a'.repeat(64)}`);
    expect(getTreeRootInfoMock).toHaveBeenCalledWith('npub1example', 'videos/demo');
  });

  it('derives the public root CID directly from the snapshot', async () => {
    const resolved = await resolveSnapshotRootCid(makeSnapshot());

    expect(resolved).toEqual(makeSnapshot().rootCid);
  });

  it('derives link-visible content keys from the link key in the URL', async () => {
    const linkKey = fromHex('7'.repeat(64));
    const contentKey = fromHex('8'.repeat(64));
    const encryptedKey = contentKey.map((byte, index) => byte ^ linkKey[index]);
    const snapshot = makeSnapshot({
      visibility: 'link-visible',
      rootCid: cid(fromHex('1'.repeat(64))),
      encryptedKey: toHex(encryptedKey),
    });

    const resolved = await resolveSnapshotRootCid(snapshot, toHex(linkKey));

    expect(resolved).toEqual(cid(fromHex('1'.repeat(64)), contentKey));
  });

  it('compares snapshot recency using created_at then event id', () => {
    const older = makeSnapshot({
      event: {
        ...makeSnapshot().event,
        created_at: 1_700_000_000,
        id: '1'.repeat(64),
      },
    });
    const newer = makeSnapshot({
      event: {
        ...makeSnapshot().event,
        created_at: 1_700_000_001,
        id: '2'.repeat(64),
      },
    });

    expect(isNewerTreeEventSnapshot(newer, older)).toBe(true);
    expect(isNewerTreeEventSnapshot(older, newer)).toBe(false);
  });

  it('matches tree snapshots against the current root hash', () => {
    const snapshot = makeSnapshot();

    expect(snapshotMatchesRootCid(snapshot, snapshot.rootCid)).toBe(true);
    expect(snapshotMatchesRootCid(snapshot, cid(fromHex('9'.repeat(64))))).toBe(false);
  });

  it('ignores missing public root keys when comparing hashes', () => {
    const snapshot = makeSnapshot({
      rootCid: cid(fromHex('1'.repeat(64)), fromHex('2'.repeat(64))),
    });

    expect(snapshotMatchesRootCid(snapshot, cid(fromHex('1'.repeat(64))))).toBe(true);
  });
});
