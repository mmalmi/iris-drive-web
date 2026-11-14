import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { File } from 'node:buffer';
import { HashTree, MemoryStore, type CID } from '@hashtree/core';

const shared = vi.hoisted(() => ({
  tree: null as HashTree | null,
  root: null as CID | null,
  savedRoot: null as CID | null,
  route: { npub: '123e4567-e89b-42d3-a456-426614174170', treeName: 'main', path: [] as string[] },
}));
vi.mock('../src/store', () => ({ getTree: () => shared.tree }));
vi.mock('../src/nostr', () => ({
  autosaveIfOwn: (root: CID) => { shared.savedRoot = root; },
  saveHashtree: vi.fn(),
  nostrStore: {
    getState: () => ({
      isLoggedIn: true, pubkey: 'a'.repeat(64), npub: 'npub1owner',
      selectedTree: { name: 'main', visibility: 'private' },
    }),
    setSelectedTree: vi.fn(),
  },
}));
vi.mock('../src/nostr/auth', () => ({
  getCurrentNostrIdentitySession: () => ({
    status: 'active', profileId: '123e4567-e89b-42d3-a456-426614174170', appKeyPubkey: 'a'.repeat(64),
  }),
}));
vi.mock('../src/utils/route', () => ({
  parseRoute: () => ({ ...shared.route, params: new URLSearchParams() }),
  isNostrIdentityId: (value: string) => /^[0-9a-f]{8}-/.test(value),
}));
vi.mock('../src/actions/route', () => ({ getCurrentPathFromUrl: () => shared.route.path }));
vi.mock('../src/stores/treeRoot', () => ({ getTreeRootSync: () => shared.root }));
vi.mock('../src/stores/recentlyChanged', () => ({ markFilesChanged: vi.fn(), revealFile: { set: vi.fn() } }));
vi.mock('../src/utils/navigate', () => ({ navigate: vi.fn() }));
vi.mock('../src/components/Modals/ExtractModal.svelte', () => ({ open: vi.fn() }));
vi.mock('../src/components/Modals/GitignoreModal.svelte', () => ({ open: vi.fn() }));
vi.mock('../src/stores/settings', () => ({ settingsStore: { subscribe: () => () => {} } }));
vi.mock('../src/stores/toast', () => ({ toast: { warning: vi.fn(), success: vi.fn() } }));

import { cancelUpload, getUploadProgress, uploadFiles, uploadFilesWithPaths } from '../src/stores/upload';

function leavePrivateRoute(): void {
  shared.route = { npub: 'npub1owner', treeName: 'public', path: [] };
}

function delayedFile(name: string) {
  const file = new File(['private content'], name);
  let resume!: () => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => { started = resolve; });
  vi.spyOn(file, 'stream').mockImplementation(() => new ReadableStream({
    start(controller) {
      started();
      resume = () => { controller.enqueue(new TextEncoder().encode('private content')); controller.close(); };
    },
  }));
  return { file, reading, resume: () => resume() };
}

function uploadFile(kind: string, file: File) {
  return kind === 'files'
    ? uploadFiles([file] as unknown as FileList)
    : uploadFilesWithPaths([{ file: file as unknown as globalThis.File, relativePath: file.name }]);
}

describe('async profile Drive write destinations', () => {
  beforeEach(async () => {
    shared.tree = new HashTree({ store: new MemoryStore() });
    shared.root = (await shared.tree.putDirectory([])).cid;
    shared.savedRoot = null;
    shared.route = { npub: '123e4567-e89b-42d3-a456-426614174170', treeName: 'main', path: [] };
    vi.stubGlobal('window', { location: { hash: '#/private' } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(['files', 'paths'])('still publishes a %s upload when its destination remains current', async (kind) => {
    const file = new File(['private content'], 'private.txt');
    if (kind === 'files') await uploadFiles([file] as unknown as FileList);
    else await uploadFilesWithPaths([{ file: file as unknown as globalThis.File, relativePath: 'private.txt' }]);
    expect(shared.savedRoot).not.toBeNull();
  });

  it.each(['files', 'paths'])('does not attach a delayed %s upload to another route', async (kind) => {
    const delayed = delayedFile('private.txt');
    const setEntry = vi.spyOn(shared.tree!, 'setEntry');
    const upload = uploadFile(kind, delayed.file);
    await delayed.reading;
    leavePrivateRoute();
    delayed.resume();
    await upload;
    expect(shared.savedRoot).toBeNull();
    expect(setEntry).not.toHaveBeenCalled();
  });

  it.each(['files', 'paths'])('keeps newer upload progress when a cancelled %s upload completes', async (kind) => {
    const oldFile = delayedFile('old-private.txt');
    const oldUpload = uploadFile(kind, oldFile.file);
    await oldFile.reading;
    leavePrivateRoute();
    cancelUpload();
    const newFile = delayedFile('new-public.txt');
    const newUpload = uploadFile(kind, newFile.file);
    await newFile.reading;
    const newProgress = getUploadProgress();
    expect(newProgress?.fileName).toBe('new-public.txt');
    oldFile.resume();
    await oldUpload;
    expect(getUploadProgress()).toEqual(newProgress);
    expect(shared.savedRoot).toBeNull();
    newFile.resume();
    await newUpload;
    expect(shared.savedRoot).not.toBeNull();
    expect(getUploadProgress()).toBeNull();
  });
});
