import { expect } from './fixtures';
import {
  cleanupVmSession,
  setupVmSession,
  vmProviderDeleteLocal,
  vmProviderList,
  vmProviderMkdirLocal,
  vmProviderRenameLocal,
  vmProviderWriteLocal,
  vmPublish,
  vmSync,
  readVmFile,
  expectVmEntryKind,
  expectVmFile,
  expectVmFiles,
  expectVmMissing,
  type DriveActor,
  type DriveMutation,
  type InteropContext,
  type ReleaseSequence,
  type VmSession,
} from './drive-vm-interop.vm';
import {
  authorizeWebDriveDevice,
  expectWebEntryKind,
  expectWebFile,
  expectWebFiles,
  expectWebMissing,
  mutateWebTree,
  newWebDriveDevice,
  publishWebRootForNative,
  restoreViaDriveSetup,
} from './drive-vm-interop.web';

export async function withInteropSession(page: Page, run: (ctx: InteropContext) => Promise<void>): Promise<void> {
  const session = await setupVmSession();
  const webDevice = newWebDriveDevice();
  try {
    await restoreViaDriveSetup(page, session);
    await authorizeWebDriveDevice(page, session, webDevice);
    const ctx = { page, session, webDevice };
    await ensureWebMainRoot(ctx);
    await run(ctx);
  } finally {
    cleanupVmSession(session);
  }
}

export async function ensureWebMainRoot(ctx: InteropContext): Promise<void> {
  const hasRoot = await ctx.page.evaluate(() => {
    const win = window as BrowserTestWindow;
    return Boolean(win.__nostrStore?.getState?.().selectedTree?.rootHash);
  });
  if (hasRoot) return;

  await ctx.page.evaluate(async () => {
    const { initVirtualTree } = await import('/src/actions/tree.ts');
    const root = await initVirtualTree([]);
    if (!root?.hash) {
      throw new Error('failed to initialize empty main drive root');
    }
  });
  await publishWebRootForNative(ctx.page, ctx.session, ctx.webDevice);
}

export async function applyVmMutationLocal(session: VmSession, mutation: DriveMutation): Promise<void> {
  if (mutation.type === 'write') {
    await vmProviderWriteLocal(session, mutation.path, mutation.content);
  } else if (mutation.type === 'mkdir') {
    await vmProviderMkdirLocal(session, mutation.path);
  } else if (mutation.type === 'delete') {
    await vmProviderDeleteLocal(session, mutation.path);
  } else {
    await vmProviderRenameLocal(session, mutation.from, mutation.to);
  }
}

export async function mutateAndPublish(
  ctx: InteropContext,
  actor: DriveActor,
  mutations: DriveMutation[],
  options: { recordTombstones?: boolean } = {},
): Promise<void> {
  if (actor === 'vm') {
    for (const mutation of mutations) {
      await applyVmMutationLocal(ctx.session, mutation);
    }
    await vmPublish(ctx.session);
  } else {
    for (const mutation of mutations) {
      await mutateWebTree(ctx.page, mutation, options);
    }
    await publishWebRootForNative(ctx.page, ctx.session, ctx.webDevice);
  }
}

export async function expectPeerFile(ctx: InteropContext, source: DriveActor, path: string, expectedContent: string): Promise<void> {
  if (source === 'vm') {
    await expectWebFile(ctx.page, path, expectedContent);
  } else {
    await expectVmFile(ctx.session, path, expectedContent);
  }
}

export async function expectPeerFiles(ctx: InteropContext, source: DriveActor, files: Record<string, string>): Promise<void> {
  if (source === 'vm') {
    await expectWebFiles(ctx.page, files);
  } else {
    await expectVmFiles(ctx.session, files);
  }
}

export async function expectPeerMissing(ctx: InteropContext, source: DriveActor, path: string): Promise<void> {
  if (source === 'vm') {
    await expectWebMissing(ctx.page, path);
  } else {
    await expectVmMissing(ctx.session, path);
  }
}

export async function expectPeerEntryKind(ctx: InteropContext, source: DriveActor, path: string, kind: string): Promise<void> {
  if (source === 'vm') {
    await expectWebEntryKind(ctx.page, path, kind);
  } else {
    await expectVmEntryKind(ctx.session, path, kind);
  }
}

export async function vmContentsWithPrefix(session: VmSession, prefix: string): Promise<string[]> {
  await vmSync(session);
  const listing = vmProviderList(session);
  const contents = listing.entries
    .filter((entry) => entry.kind === 'file' && entry.path.startsWith(prefix))
    .map((entry) => readVmFile(session, entry.path))
    .filter((content): content is string => content !== null);
  return contents.sort();
}

export async function expectVmContentsWithPrefix(
  session: VmSession,
  prefix: string,
  expectedContents: string[],
): Promise<void> {
  await expect.poll(
    () => vmContentsWithPrefix(session, prefix),
    { timeout: 120000, intervals: [1000, 2000, 3000, 5000] },
  ).toEqual([...expectedContents].sort());
}

export function deterministicContent(label: string, index: number, bytes = 192): string {
  const seed = `${label}:${index}:`;
  if (seed.length >= bytes) return seed;
  return `${seed}${'0123456789abcdef'.repeat(Math.ceil((bytes - seed.length) / 16)).slice(0, bytes - seed.length)}`;
}

export function releaseMutator(ctx: InteropContext, source: DriveActor): (mutations: DriveMutation[]) => Promise<void> {
  return (mutations: DriveMutation[]) => mutateAndPublish(
    ctx,
    source,
    mutations,
    source === 'web' ? { recordTombstones: false } : {},
  );
}

export async function runReleaseAddDeleteAdd(ctx: InteropContext, source: DriveActor, prefix: string): Promise<void> {
  const mutate = releaseMutator(ctx, source);

  await mutate([
    { type: 'write', path: `${prefix}/add-delete-add/1.txt`, content: `aaaaaaaa from ${source}` },
    { type: 'delete', path: `${prefix}/add-delete-add` },
    { type: 'write', path: `${prefix}/add-delete-add/1.txt`, content: `aaaaaaaa from ${source}` },
  ]);
  await expectPeerFile(ctx, source, `${prefix}/add-delete-add/1.txt`, `aaaaaaaa from ${source}`);
}

export async function runReleaseCreateUpdate(ctx: InteropContext, source: DriveActor, prefix: string): Promise<void> {
  const mutate = releaseMutator(ctx, source);

  await mutate([
    { type: 'write', path: `${prefix}/create-update/test/1.txt`, content: `111 from ${source}` },
    { type: 'write', path: `${prefix}/create-update/test/1.txt`, content: `222 from ${source}` },
    { type: 'write', path: `${prefix}/create-update/copy-source/1.txt`, content: '111' },
    { type: 'write', path: `${prefix}/create-update/copy-source/2/2.txt`, content: '222' },
    { type: 'write', path: `${prefix}/create-update/test/copied/1.txt`, content: '111' },
    { type: 'write', path: `${prefix}/create-update/test/copied/2/2.txt`, content: '222' },
    { type: 'mkdir', path: `${prefix}/create-update/empty` },
    { type: 'write', path: `${prefix}/create-update/empty/test.md`, content: 'dddddddddddddddddddddd' },
  ]);
  await expectPeerFiles(ctx, source, {
    [`${prefix}/create-update/test/1.txt`]: `222 from ${source}`,
    [`${prefix}/create-update/test/copied/2/2.txt`]: '222',
    [`${prefix}/create-update/empty/test.md`]: 'dddddddddddddddddddddd',
  });
}

export async function runReleaseRenameChain(ctx: InteropContext, source: DriveActor, prefix: string): Promise<void> {
  const mutate = releaseMutator(ctx, source);

  const renameBase = `${prefix}/rename`;
  await mutate([
    { type: 'write', path: `${renameBase}/1.txt`, content: '111' },
    { type: 'rename', from: `${renameBase}/1.txt`, to: `${renameBase}/2.txt` },
    { type: 'write', path: `${renameBase}/3.txt`, content: '222' },
    { type: 'rename', from: `${renameBase}/2.txt`, to: `${renameBase}/3.txt` },
    { type: 'write', path: `${renameBase}/test.txt`, content: 'test' },
    { type: 'mkdir', path: `${renameBase}/test` },
    { type: 'write', path: `${renameBase}/4.txt`, content: '444' },
    { type: 'rename', from: `${renameBase}/test.txt`, to: `${renameBase}/test/test.txt` },
    { type: 'rename', from: `${renameBase}/3.txt`, to: `${renameBase}/test/3.txt` },
    { type: 'rename', from: `${renameBase}/4.txt`, to: `${renameBase}/test/4.txt` },
    { type: 'mkdir', path: `${renameBase}/test2` },
    { type: 'rename', from: `${renameBase}/test`, to: `${renameBase}/test2/test` },
    { type: 'rename', from: `${renameBase}/test2/test`, to: `${renameBase}/test` },
    { type: 'write', path: `${renameBase}/test/4.txt`, content: '444555' },
    { type: 'rename', from: `${renameBase}/test`, to: `${renameBase}/test2/test` },
    { type: 'rename', from: `${renameBase}/test2`, to: `${renameBase}/test3` },
  ]);
  await expectPeerMissing(ctx, source, `${renameBase}/test/4.txt`);
  await expectPeerFile(ctx, source, `${renameBase}/test3/test/4.txt`, '444555');
}

export async function runReleaseDeleteCascade(ctx: InteropContext, source: DriveActor, prefix: string): Promise<void> {
  const mutate = releaseMutator(ctx, source);

  const deleteBase = `${prefix}/delete`;
  await mutate([
    { type: 'write', path: `${deleteBase}/2.txt`, content: '2222' },
    { type: 'write', path: `${deleteBase}/1/1.txt`, content: '111' },
    { type: 'write', path: `${deleteBase}/1/2/2.txt`, content: '222' },
    { type: 'write', path: `${deleteBase}/test/1/1.txt`, content: '111' },
    { type: 'write', path: `${deleteBase}/test/1/2/2.txt`, content: '222' },
  ]);
  await expectPeerFile(ctx, source, `${deleteBase}/test/1/2/2.txt`, '222');
  await mutate([
    { type: 'delete', path: `${deleteBase}/2.txt` },
    { type: 'delete', path: `${deleteBase}/1` },
    { type: 'delete', path: `${deleteBase}/test/1` },
    { type: 'delete', path: `${deleteBase}/test` },
  ]);
  await expectPeerMissing(ctx, source, `${deleteBase}/2.txt`);
  await expectPeerMissing(ctx, source, `${deleteBase}/1/1.txt`);
  await expectPeerMissing(ctx, source, `${deleteBase}/test/1/2/2.txt`);
}

export async function runReleaseCaseRename(ctx: InteropContext, source: DriveActor, prefix: string): Promise<void> {
  const mutate = releaseMutator(ctx, source);

  const lower = `${prefix}/case/test/a.txt`;
  const upper = `${prefix}/case/TEST/a.txt`;
  await mutate([{ type: 'write', path: lower, content: 'case bytes' }]);
  await expectPeerFile(ctx, source, lower, 'case bytes');
  await mutate([{ type: 'rename', from: `${prefix}/case/test`, to: `${prefix}/case/TEST` }]);
  await expectPeerMissing(ctx, source, lower);
  await expectPeerFile(ctx, source, upper, 'case bytes');
  await mutate([{ type: 'rename', from: `${prefix}/case/TEST`, to: `${prefix}/case/test` }]);
  await expectPeerFile(ctx, source, lower, 'case bytes');
  await expectPeerMissing(ctx, source, upper);
}

export async function runReleaseEmptyDirectory(ctx: InteropContext, source: DriveActor, prefix: string): Promise<void> {
  const mutate = releaseMutator(ctx, source);

  const empty = `${prefix}/empty-dir`;
  const renamedEmpty = `${prefix}/empty-dir-renamed`;
  await mutate([{ type: 'mkdir', path: empty }]);
  await expectPeerEntryKind(ctx, source, empty, 'directory');
  await mutate([{ type: 'rename', from: empty, to: renamedEmpty }]);
  await expectPeerMissing(ctx, source, empty);
  await expectPeerEntryKind(ctx, source, renamedEmpty, 'directory');
  await mutate([{ type: 'delete', path: renamedEmpty }]);
  await expectPeerMissing(ctx, source, renamedEmpty);
}

export async function runReleaseSingleOperations(ctx: InteropContext, source: DriveActor, prefix: string): Promise<void> {
  const mutate = releaseMutator(ctx, source);

  const single = `${prefix}/single`;
  await mutate([{ type: 'write', path: `${single}/1.txt`, content: '11111' }]);
  await expectPeerFile(ctx, source, `${single}/1.txt`, '11111');
  await mutate([{ type: 'write', path: `${single}/1.txt`, content: '22222' }]);
  await expectPeerFile(ctx, source, `${single}/1.txt`, '22222');
  await mutate([{ type: 'mkdir', path: `${single}/dir1` }]);
  await expectPeerEntryKind(ctx, source, `${single}/dir1`, 'directory');
  await mutate([{ type: 'rename', from: `${single}/1.txt`, to: `${single}/2.txt` }]);
  await expectPeerFile(ctx, source, `${single}/2.txt`, '22222');
  await mutate([{ type: 'rename', from: `${single}/dir1`, to: `${single}/dir2` }]);
  await expectPeerEntryKind(ctx, source, `${single}/dir2`, 'directory');
  await mutate([{ type: 'write', path: `${single}/dir2/1.txt`, content: '1111111' }]);
  await expectPeerFile(ctx, source, `${single}/dir2/1.txt`, '1111111');
  await mutate([{ type: 'rename', from: `${single}/dir2`, to: `${single}/dir3` }]);
  await expectPeerFile(ctx, source, `${single}/dir3/1.txt`, '1111111');
  await mutate([{ type: 'delete', path: `${single}/dir3/1.txt` }]);
  await expectPeerMissing(ctx, source, `${single}/dir3/1.txt`);
  await mutate([{ type: 'write', path: `${single}/dir4/2.txt`, content: '2222222' }]);
  await expectPeerFile(ctx, source, `${single}/dir4/2.txt`, '2222222');
  await mutate([{ type: 'rename', from: `${single}/dir4`, to: `${single}/dir3/dir4` }]);
  await expectPeerFile(ctx, source, `${single}/dir3/dir4/2.txt`, '2222222');
  await mutate([
    { type: 'delete', path: `${single}/2.txt` },
    { type: 'delete', path: `${single}/dir3` },
  ]);
  await expectPeerMissing(ctx, source, `${single}/2.txt`);
  await expectPeerMissing(ctx, source, `${single}/dir3/dir4/2.txt`);
}

export const nativeReleaseOperationSequences: ReleaseSequence[] = [
  { name: 'add-delete-add', run: runReleaseAddDeleteAdd },
  { name: 'create-update-deep-copy', run: runReleaseCreateUpdate },
  { name: 'rename-chain', run: runReleaseRenameChain },
  { name: 'delete-cascade', run: runReleaseDeleteCascade },
  { name: 'case-rename', run: runReleaseCaseRename },
  { name: 'empty-directory', run: runReleaseEmptyDirectory },
  { name: 'single-operations', run: runReleaseSingleOperations },
];

export async function runManyFileBurst(
  ctx: InteropContext,
  source: DriveActor,
  prefix: string,
  count: number,
  batchSize: number,
): Promise<void> {
  const files: Record<string, string> = {};
  for (let start = 0; start < count; start += batchSize) {
    const mutations: DriveMutation[] = [];
    for (let index = start; index < Math.min(start + batchSize, count); index += 1) {
      const path = `${prefix}/${Math.floor(index / 16).toString().padStart(3, '0')}/file-${index.toString().padStart(4, '0')}.txt`;
      const content = deterministicContent(`${source}-many`, index);
      files[path] = content;
      mutations.push({ type: 'write', path, content });
    }
    await mutateAndPublish(
      ctx,
      source,
      mutations,
      source === 'web' ? { recordTombstones: false } : {},
    );
  }
  await expectPeerFiles(ctx, source, files);
}
