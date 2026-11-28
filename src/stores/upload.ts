/**
 * Upload store - manages file upload with progress tracking
 * Uses Svelte stores for state management
 *
 * All uploads use encryption by default (CHK - Content Hash Key).
 */
import { writable, get } from 'svelte/store';
import { toHex, cid, LinkType, videoChunker, streamUploadWithProgress } from '@hashtree/core';
import type { CID } from '@hashtree/core';
import { getTree } from '../store';
import { autosaveIfOwn, saveHashtree, saveOwnTreeRoot, nostrStore } from '../nostr';
import { navigate } from '../utils/navigate';
import { parseRoute, parseRouteFromHash } from '../utils/route';
import { getCurrentPathFromUrl } from '../actions/route';
import { markFilesChanged, revealFile } from './recentlyChanged';
import { open as openExtractModal } from '../components/Modals/ExtractModal.svelte';
import { open as openGitignoreModal } from '../components/Modals/GitignoreModal.svelte';
import type { FileWithPath, DirectoryReadResult } from '@iris/hashtree-app/directory';
import { findGitignoreFile, parseGitignoreFromFile, applyGitignoreFilter, applyDefaultIgnoreFilter } from '@iris/hashtree-app/directory';
import { getTreeRootSync, waitForTreeRoot } from './treeRoot';
import { settingsStore } from '../stores/settings';
import { toast } from '../stores/toast';
import { isVideoFile, withStallDetection } from './uploadHelpers';
import { editableTreeRoutePubkey, isEditableDriveRouteScope } from '../drive/profileRoute';
import { DirectoryBuilder } from '../drive/directoryBuilder';
import { setEntriesForDriveRoute, type DriveEntryWrite } from '../drive/profileDriveRouteEntry';
import { activeShareScope } from '../drive/shareScope';
import { captureIdentityWriteGuard, captureRouteWriteGuard } from '../lib/routeWriteGuard';
import { inTurn } from '../lib/driveWrites';
import { withModifiedAt } from '../lib/modifiedAt';

/** A ZIP file, which the person may choose to unpack; the code for it loads only then. */
function isArchiveFile(fileName: string): boolean {
  return fileName.toLowerCase().split('.').pop() === 'zip';
}

const SHARED_FOLDER_LOAD_MS = 20_000;
const COMMIT_BATCH_SIZE = 24;
const COMMIT_BATCH_INTERVAL_MS = 400;

// Upload progress type
export interface UploadProgress {
  current: number;
  total: number;
  fileName: string;
  bytes?: number;
  totalBytes?: number;
  status?: 'preparing' | 'reading' | 'writing' | 'finalizing' | 'zipping';
  cancel?: () => void;
}

// Svelte store for upload progress
export const uploadProgress = writable<UploadProgress | null>(null);

let uploadGeneration = 0;

export function setUploadProgress(progress: UploadProgress | null) {
  uploadProgress.set(progress);
}

export function getUploadProgress() {
  return get(uploadProgress);
}

/**
 * Cancel any in-progress upload
 */
export function cancelUpload() {
  uploadGeneration++;
  setUploadProgress(null);
  releaseRunningUpload?.();
}

function beginUpload(files: File[], mayWriteAtStart: () => boolean) {
  let totalBytes = 0;
  const offsets = files.map(file => {
    const start = totalBytes;
    totalBytes += file.size;
    return start;
  });
  const generation = ++uploadGeneration;
  let routeIsCurrent = mayWriteAtStart;
  const isCurrent = () => {
    if (generation !== uploadGeneration) return false;
    if (routeIsCurrent()) return true;
    setUploadProgress(null);
    return false;
  };
  return {
    isCurrent,
    progress(index: number, fileName: string, bytes: number, status: UploadProgress['status']) {
      if (isCurrent()) setUploadProgress({
        current: index + 1, total: files.length, fileName, status,
        bytes: offsets[index]! + bytes, totalBytes,
      });
    },
    clear() {
      if (isCurrent()) setUploadProgress(null);
    },
    // Virtual-tree creation intentionally changes the selected tree.
    retainSelection() {
      if (generation === uploadGeneration) routeIsCurrent = captureRouteWriteGuard();
    },
  };
}

/** Where an upload goes: the open folder unless `dirPath` names another one, such as a folder dropped onto. */
export interface UploadTarget {
  dirPath?: string[];
  /** A Drive or shared folder to upload into from a page that is not one, such as Photos; `dirPath` is then from its top. */
  drive?: { scope: string; treeName: string };
  /** The caller says what was added, as pasting does. */
  quiet?: boolean;
}

/** Where an upload was asked for, kept while it waits for its turn and runs. */
interface UploadOrigin {
  route: ReturnType<typeof parseRoute>;
  dirPath: string[];
  /** Whether the upload may still write. */
  mayWrite: () => boolean;
  save: (root: CID) => void;
}

function uploadOrigin(target: UploadTarget): UploadOrigin {
  const route = target.drive
    ? parseRouteFromHash(`#/${encodeURIComponent(target.drive.scope)}/${encodeURIComponent(target.drive.treeName)}`)
    : parseRoute();
  const dirPath = target.dirPath ?? (target.drive ? [] : getCurrentPathFromUrl());
  // A Drive or shared folder is saved by its own address, so an upload into it
  // goes on while its person opens the folder, another one or another page.
  if (route.treeName && isEditableDriveRouteScope(route.npub, nostrStore.getState())) {
    const { npub: scope, treeName } = route;
    return {
      route,
      dirPath,
      mayWrite: captureIdentityWriteGuard(),
      save: (root) => { saveOwnTreeRoot(scope!, treeName, root); },
    };
  }
  return { route, dirPath, mayWrite: captureRouteWriteGuard(), save: autosaveIfOwn };
}

let uploadsBefore: Promise<void> = Promise.resolve();
/** Lets the next upload go before the running one has wound down: it was cancelled. */
let releaseRunningUpload: (() => void) | null = null;

/**
 * Uploads take turns: one asked for while another runs waits for it to end or
 * be cancelled, where it used to stop it. Starting, it stops a cancelled one.
 */
function afterOtherUploads(upload: () => Promise<void>): Promise<void> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const before = uploadsBefore;
  uploadsBefore = released;
  return before.then(async () => {
    releaseRunningUpload = release;
    try {
      await upload();
    } finally {
      if (releaseRunningUpload === release) releaseRunningUpload = null;
      release();
    }
  });
}

type UploadBatch = ReturnType<typeof beginUpload>;

function runUploadBatch(files: File[], target: UploadTarget, work: (batch: UploadBatch, origin: UploadOrigin) => Promise<void>) {
  const origin = uploadOrigin(target);
  return afterOtherUploads(async () => {
    const batch = beginUpload(files, origin.mayWrite);
    if (!batch.isCurrent()) return;
    batch.progress(0, files[0]!.name, 0, 'preparing');
    try {
      if (!await sharedFolderLoaded(origin)) {
        if (batch.isCurrent()) toast.error('This shared folder is still loading. Try again in a moment.');
        return;
      }
      if (!batch.isCurrent()) return;
      await work(batch, origin);
    } finally {
      batch.clear();
    }
  });
}

/** Whether the upload goes into a folder shared between people, which has contents of its own once loaded. */
function intoSharedFolder(origin: UploadOrigin): boolean {
  const { npub, treeName } = origin.route;
  return Boolean(treeName && activeShareScope(npub, nostrStore.getState()));
}

/**
 * A shared folder that has not loaded yet is not an empty one. An upload that
 * came before its contents started a new tree instead, and a new tree is
 * saved as the person's own My Drive: the file landed there, in place of all
 * that was in it. The upload waits for the folder; false when it does not come.
 */
async function sharedFolderLoaded(origin: UploadOrigin): Promise<boolean> {
  if (!intoSharedFolder(origin)) return true;
  const { npub, treeName } = origin.route;
  if (getTreeRootSync(npub, treeName)?.hash) return true;
  await waitForTreeRoot(npub!, treeName!, SHARED_FOLDER_LOAD_MS);
  return Boolean(getTreeRootSync(npub, treeName)?.hash);
}

/**
 * Puts uploaded entries in their place and saves, on top of whatever was saved
 * since the upload began. Null when the upload no longer belongs here.
 */
function saveEntries(
  upload: UploadBatch,
  origin: UploadOrigin,
  root: CID,
  writes: DriveEntryWrite[],
  label: string,
): Promise<CID | null> {
  const { route } = origin;
  // This waits for the page's earlier changes to the Drive. One that never
  // ended left the upload standing still without a word.
  return withStallDetection(inTurn(async () => {
    if (!upload.isCurrent()) return null;
    const latest = getTreeRootSync(route.npub, route.treeName) ?? root;
    const next = await setEntriesForDriveRoute(getTree(), latest, writes, route, nostrStore.getState());
    if (!upload.isCurrent()) return null;
    origin.save(next);
    return next;
  }), `Saving ${label} is taking longer than expected...`);
}

async function streamFileToTree(
  file: File,
  displayName: string,
  index: number,
  upload: UploadBatch,
): Promise<{ cid: CID; size: number }> {
  const tree = getTree();
  // Use videoChunker for video files (smaller first chunk for faster playback start)
  const chunker = isVideoFile(file.name) ? videoChunker() : undefined;
  const stream = tree.createStream({ chunker });
  const result = await streamUploadWithProgress(
    file,
    {
      append: async (chunk) => withStallDetection(
        stream.append(chunk),
        `Writing ${displayName} is taking longer than expected...`,
      ),
      finalize: async () => withStallDetection(
        stream.finalize(),
        `Finalizing ${displayName} is taking longer than expected...`,
      ),
    },
    {
      readChunk: (reader) => withStallDetection(
        reader.read(),
        `Reading ${displayName} is taking longer than expected...`,
      ),
      onProgress: (progress) => {
        upload.progress(index, displayName, progress.bytesProcessed, progress.phase);
      },
    },
  );
  return { cid: cid(result.hash, result.key), size: result.size };
}

async function readArchiveOrPut(
  file: File,
  index: number,
  upload: UploadBatch,
): Promise<{ cid: CID; size: number } | 'opened-extract-modal' | null> {
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  const reader = file.stream().getReader();

  while (true) {
    upload.progress(index, file.name, bytesRead, 'reading');
    const readResult = await withStallDetection(
      reader.read(),
      `Reading ${file.name} is taking longer than expected...`,
    );
    if (readResult.done) break;
    chunks.push(readResult.value);
    bytesRead += readResult.value.length;
  }

  const data = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }

  try {
    const { getArchiveFileList } = await import('../utils/compression');
    const archiveInfo = getArchiveFileList(data);
    if (archiveInfo.files.length > 0) {
      upload.clear();
      if (!upload.isCurrent()) return null;
      openExtractModal({ archiveName: file.name, files: archiveInfo.files, archiveData: data, commonRoot: archiveInfo.commonRoot });
      return 'opened-extract-modal';
    }
  } catch (err) {
    console.warn('Failed to parse archive, uploading as regular file:', err);
  }

  upload.progress(index, file.name, bytesRead, 'writing');
  return withStallDetection(
    getTree().putFile(data),
    `Writing ${file.name} is taking longer than expected...`,
  );
}

interface UploadItem {
  file: File;
  displayName: string;
  parentPath: string[];
  name: string;
  topLevel: boolean;
}

/**
 * Shared upload pipeline for both flat file selections and nested folder uploads.
 * Streams files in order and commits the first item immediately for instant UI
 * feedback, then batches subsequent entries so multi-file and folder uploads
 * rewrite each affected directory and metadata node only once per batch.
 */
async function uploadItemsNow(
  items: UploadItem[],
  origin: UploadOrigin,
  upload: UploadBatch,
  options: { checkArchive: boolean; continueOnSaveError: boolean },
): Promise<{ uploadedNames: string[]; aborted: boolean }> {
  const uploadedNames: string[] = [];
  const tree = getTree();
  const { route } = origin;

  let currentRootCid: CID | null = getTreeRootSync(route.npub, route.treeName);
  if (!currentRootCid?.hash && intoSharedFolder(origin)) {
    return { uploadedNames, aborted: true };
  }
  let needsTreeInit = Boolean(!currentRootCid?.hash && route.npub && route.treeName);
  const routePubkey = needsTreeInit
    ? editableTreeRoutePubkey(route.npub, nostrStore.getState())
    : null;
  const isOwnTree = routePubkey !== null;

  let pendingWrites: Array<{ write: DriveEntryWrite; displayName: string; topLevel: boolean }> = [];
  let lastCommitAt = performance.now();

  const initializeTreeWith = async (batch: typeof pendingWrites): Promise<boolean> => {
    const builder = new DirectoryBuilder();
    for (const { write } of batch) {
      builder.directory(write.parentPath).setLeaf(write.name, {
        ...write.entry,
        meta: withModifiedAt(write.entry.meta),
      });
    }
    const newRootCid = await builder.put(tree);
    if (!upload.isCurrent()) return false;
    currentRootCid = newRootCid;
    const changed = new Set(batch.filter((item) => item.topLevel).map((item) => item.write.name));
    if (changed.size > 0) markFilesChanged(changed);

    if (needsTreeInit) {
      if (isOwnTree && routePubkey) {
        const currentVisibility = nostrStore.getState().selectedTree?.visibility ?? 'public';
        if (!upload.isCurrent()) return false;
        saveHashtree(route.treeName!, newRootCid, { visibility: currentVisibility }).catch(() => {
          // Network error is OK - local changes are saved, will sync when online
        });
        nostrStore.setSelectedTree({
          id: '',
          name: route.treeName!,
          pubkey: routePubkey,
          rootHash: toHex(newRootCid.hash),
          rootKey: newRootCid.key ? toHex(newRootCid.key) : undefined,
          visibility: currentVisibility,
          created_at: Math.floor(Date.now() / 1000),
        });
        upload.retainSelection();
      }
      needsTreeInit = false;
    } else {
      navigate('/');
    }
    return true;
  };

  const flushPending = async (): Promise<boolean> => {
    if (pendingWrites.length === 0) return true;
    const batch = pendingWrites;
    pendingWrites = [];
    lastCommitAt = performance.now();

    if (!currentRootCid?.hash) {
      const ok = await initializeTreeWith(batch);
      if (ok) uploadedNames.push(...batch.map((item) => item.write.name));
      return ok;
    }

    const label = batch.length === 1 ? batch[0]!.write.name : `${batch.length} files`;
    try {
      const newRootCid = await saveEntries(
        upload,
        origin,
        currentRootCid,
        batch.map((item) => item.write),
        label,
      );
      if (!newRootCid) return false;
      currentRootCid = newRootCid;
      uploadedNames.push(...batch.map((item) => item.write.name));
      const changed = new Set(batch.filter((item) => item.topLevel).map((item) => item.write.name));
      if (changed.size > 0) markFilesChanged(changed);
      return true;
    } catch (err) {
      if (!options.continueOnSaveError) throw err;
      const failedLabel = batch.length === 1 ? batch[0]!.displayName : label;
      console.error(`Failed to add ${failedLabel}:`, err);
      toast.error(`Failed to add ${failedLabel}`);
      return true;
    }
  };

  for (let i = 0; i < items.length; i += 1) {
    if (!upload.isCurrent()) return { uploadedNames, aborted: true };
    const item = items[i]!;
    upload.progress(i, item.displayName, 0, 'reading');

    let stored: { cid: CID; size: number };
    try {
      if (options.checkArchive && isArchiveFile(item.file.name)) {
        // The dialog ends this upload batch. Commit earlier files before handing
        // control to it, including when the person decides not to extract.
        if (!await flushPending()) return { uploadedNames, aborted: true };
        const archiveResult = await readArchiveOrPut(item.file, i, upload);
        if (!archiveResult || archiveResult === 'opened-extract-modal') {
          return { uploadedNames, aborted: true };
        }
        stored = archiveResult;
      } else {
        stored = await streamFileToTree(item.file, item.displayName, i, upload);
      }
    } catch (error) {
      // A later unreadable file must not discard earlier completed uploads.
      // Cancellation and identity changes still prevent these writes.
      if (upload.isCurrent()) await flushPending();
      throw error;
    }

    if (!upload.isCurrent()) return { uploadedNames, aborted: true };
    pendingWrites.push({
      write: {
        parentPath: item.parentPath,
        name: item.name,
        entry: { cid: stored.cid, size: stored.size, type: LinkType.Blob },
      },
      displayName: item.displayName,
      topLevel: item.topLevel,
    });

    // Commit the first file immediately for instant feedback and timely stall
    // reporting, then coalesce subsequent files into batches.
    const shouldFlush = i === 0
      || pendingWrites.length >= COMMIT_BATCH_SIZE
      || performance.now() - lastCommitAt >= COMMIT_BATCH_INTERVAL_MS;
    if (shouldFlush && !await flushPending()) {
      return { uploadedNames, aborted: true };
    }
  }

  if (!await flushPending()) {
    return { uploadedNames, aborted: true };
  }
  return { uploadedNames, aborted: false };
}

/**
 * Upload files to the current directory, or to `target.dirPath`
 */
export function uploadFiles(files: FileList | File[], target: UploadTarget = {}): Promise<void> {
  if (!files.length) return Promise.resolve();
  // A FileList empties when its input is reset: copied now.
  const filesArray = Array.from(files);
  return runUploadBatch(filesArray, target, async (upload, origin) => {
    const items: UploadItem[] = filesArray
      .filter((file): file is File => Boolean(file))
      .map((file) => ({
        file,
        displayName: file.name,
        parentPath: origin.dirPath,
        name: file.name,
        topLevel: true,
      }));
    const { uploadedNames, aborted } = await uploadItemsNow(items, origin, upload, {
      checkArchive: true,
      continueOnSaveError: false,
    });
    if (aborted || !upload.isCurrent()) return;

    // The folder stays open, as it does for many files: the new row is
    // highlighted there and the toast names it.
    if (uploadedNames.length === 1 && !target.dirPath) {
      revealFile.set(uploadedNames[0]!);
    }
    if (!target.quiet && (uploadedNames.length > 1 || !target.dirPath)) {
      toast.success(uploadedNames.length === 1 ? `Uploaded ${uploadedNames[0]}` : `Uploaded ${uploadedNames.length} files`);
    }
  });
}

/**
 * Upload files with path information (for directory uploads)
 * Files are uploaded with their relative paths preserved in the tree structure
 */
export function uploadFilesWithPaths(
  entries: FileWithPath[], target: UploadTarget = {},
  prepare?: (entries: FileWithPath[]) => Promise<FileWithPath[]>,
): Promise<void> {
  if (!entries.length) return Promise.resolve();
  return runUploadBatch(entries.map(entry => entry.file), target, async (upload, origin) => {
    // Photos chooses unused names in its album. Look them up in queue order,
    // with progress visible, so earlier batches already own their names.
    const files = prepare ? await prepare(entries) : entries;
    if (!upload.isCurrent()) return;
    const items: UploadItem[] = [];
    for (const { file, relativePath } of files) {
      if (!file) continue;
      const parts = relativePath.split('/').filter(Boolean);
      const name = parts.pop();
      if (!name) continue;
      items.push({
        file,
        displayName: relativePath,
        parentPath: [...origin.dirPath, ...parts],
        name,
        topLevel: parts.length === 0,
      });
    }
    const { uploadedNames, aborted } = await uploadItemsNow(items, origin, upload, {
      checkArchive: false,
      continueOnSaveError: true,
    });
    if (!aborted && uploadedNames.length > 0 && !target.quiet && upload.isCurrent()) {
      toast.success(uploadedNames.length === 1 ? 'Uploaded 1 file' : `Uploaded ${uploadedNames.length} files`);
    }
  });
}

/**
 * Upload a directory with gitignore support
 * Checks for .gitignore at root and handles filtering based on user preference
 */
export async function uploadDirectory(result: DirectoryReadResult, target: UploadTarget = {}): Promise<void> {
  const { files, hasGitignore, rootDirName } = result;
  if (files.length === 0) return;

  const settings = get(settingsStore);
  const gitignoreBehavior = settings.upload.gitignoreBehavior;
  const dirName = rootDirName || 'directory';

  // Always apply default ignore patterns (.git, .DS_Store, etc.)
  const { included: defaultFiltered } = applyDefaultIgnoreFilter(files);

  if (!hasGitignore || gitignoreBehavior === 'never') {
    await uploadFilesWithPaths(defaultFiltered, target);
    return;
  }

  const gitignoreFileEntry = findGitignoreFile(files, rootDirName);
  if (!gitignoreFileEntry) {
    await uploadFilesWithPaths(defaultFiltered, target);
    return;
  }

  const patterns = await parseGitignoreFromFile(gitignoreFileEntry.file);
  // applyGitignoreFilter includes default patterns, so .git etc. are filtered
  const { included, excluded } = applyGitignoreFilter(files, patterns);

  if (excluded.length === 0 || gitignoreBehavior === 'always') {
    await uploadFilesWithPaths(included, target);
    return;
  }

  // Ask the user (behavior === 'ask')
  return new Promise<void>((resolve) => {
    openGitignoreModal({
      allFiles: files,
      includedFiles: included,
      excludedFiles: excluded,
      dirName,
      onDecision: async (gitignore: boolean, rememberGlobally: boolean) => {
        if (rememberGlobally) {
          settingsStore.setUploadSettings({
            gitignoreBehavior: gitignore ? 'always' : 'never',
          });
        }
        await uploadFilesWithPaths(gitignore ? included : files, target);
        resolve();
      },
    });
  });
}
