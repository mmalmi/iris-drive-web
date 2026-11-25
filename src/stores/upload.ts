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
import { getTreeRootSync } from './treeRoot';
import { settingsStore } from '../stores/settings';
import { toast } from '../stores/toast';
import { isVideoFile, withStallDetection } from './uploadHelpers';
import { editableTreeRoutePubkey, isEditableDriveRouteScope } from '../drive/profileRoute';
import { setEntryForDriveRoute } from '../drive/profileDriveRouteEntry';
import { captureIdentityWriteGuard, captureRouteWriteGuard } from '../lib/routeWriteGuard';
import { inTurn } from '../lib/driveWrites';
import { withModifiedAt } from '../lib/modifiedAt';

/** A ZIP file, which the person may choose to unpack; the code for it loads only then. */
function isArchiveFile(fileName: string): boolean {
  return fileName.toLowerCase().split('.').pop() === 'zip';
}

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
      await work(batch, origin);
    } finally {
      batch.clear();
    }
  });
}

/**
 * Puts what was uploaded in its place and saves, on top of whatever was saved
 * since the upload began. Null when the upload no longer belongs here.
 */
function saveEntry(
  upload: UploadBatch,
  origin: UploadOrigin,
  root: CID,
  parentPath: string[],
  name: string,
  entry: { cid: CID; size: number; type: LinkType },
): Promise<CID | null> {
  const { route } = origin;
  // This waits for the page's earlier changes to the Drive. One that never
  // ended left the upload standing still without a word.
  return withStallDetection(inTurn(async () => {
    if (!upload.isCurrent()) return null;
    const latest = getTreeRootSync(route.npub, route.treeName) ?? root;
    const next = await setEntryForDriveRoute(getTree(), latest, parentPath, name, entry, route, nostrStore.getState());
    if (!upload.isCurrent()) return null;
    origin.save(next);
    return next;
  }), `Saving ${name} is taking longer than expected...`);
}

/**
 * Upload files to the current directory, or to `target.dirPath`
 */
export function uploadFiles(files: FileList | File[], target: UploadTarget = {}): Promise<void> {
  if (!files.length) return Promise.resolve();
  // A FileList empties when its input is reset: copied now.
  const filesArray = Array.from(files);
  return runUploadBatch(filesArray, target, (upload, origin) => uploadFilesNow(filesArray, target, origin, upload));
}

async function uploadFilesNow(filesArray: File[], target: UploadTarget, origin: UploadOrigin, upload: UploadBatch): Promise<void> {
  const uploadedFileNames: string[] = [];
  const tree = getTree();
  const { route, dirPath } = origin;

  // Get current rootCid from resolver - track locally for multi-file uploads
  let currentRootCid: CID | null = getTreeRootSync(route.npub, route.treeName);

  // Check if we need to initialize a new tree (virtual directory case)
  let needsTreeInit = Boolean(!currentRootCid?.hash && route.npub && route.treeName);
  const routePubkey = needsTreeInit
    ? editableTreeRoutePubkey(route.npub, nostrStore.getState())
    : null;
  const isOwnTree = routePubkey !== null;

  for (let i = 0; i < filesArray.length; i++) {
    // Check for cancellation at start of each file
    if (!upload.isCurrent()) return;

    const file = filesArray[i];
    if (!file) continue;

    upload.progress(i, file.name, 0, 'reading');

    let fileCid: CID;
    let size: number;

    // Check if this is an archive file - needs buffering for extraction
    if (isArchiveFile(file.name)) {
      // Buffer the file for archive extraction
      const chunks: Uint8Array[] = [];
      let bytesRead = 0;
      const reader = file.stream().getReader();

      while (true) {
        upload.progress(i, file.name, bytesRead, 'reading');
        const readResult = await withStallDetection(
          reader.read(),
          `Reading ${file.name} is taking longer than expected...`
        );
        if (readResult.done) break;
        chunks.push(readResult.value);
        bytesRead += readResult.value.length;
      }

      // Combine chunks
      const data = new Uint8Array(bytesRead);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }

      try {
        // Get file list without decompressing - fast and low memory
        const { getArchiveFileList } = await import('../utils/compression');
        const archiveInfo = getArchiveFileList(data);
        if (archiveInfo.files.length > 0) {
          upload.clear();
          // Pass archive data for extraction later (one file at a time)
          // Include commonRoot so modal knows if files already have a root folder
          if (!upload.isCurrent()) return;
          openExtractModal({ archiveName: file.name, files: archiveInfo.files, archiveData: data, commonRoot: archiveInfo.commonRoot });
          // Don't continue with normal upload - the modal will handle it
          return;
        }
      } catch (err) {
        console.warn('Failed to parse archive, uploading as regular file:', err);
        // Fall through to normal upload
      }

      // Use encrypted file storage (default)
      upload.progress(i, file.name, bytesRead, 'writing');
      const result = await withStallDetection(
        tree.putFile(data),
        `Writing ${file.name} is taking longer than expected...`
      );
      fileCid = result.cid;
      size = result.size;
    } else {
      // Stream upload - no buffering needed
      // Use videoChunker for video files (smaller first chunk for faster playback start)
      const chunker = isVideoFile(file.name) ? videoChunker() : undefined;
      const stream = tree.createStream({ chunker });
      const result = await streamUploadWithProgress(
        file,
        {
          append: async (chunk) => withStallDetection(
            stream.append(chunk),
            `Writing ${file.name} is taking longer than expected...`
          ),
          finalize: async () => withStallDetection(
            stream.finalize(),
            `Finalizing ${file.name} is taking longer than expected...`
          ),
        },
        {
          readChunk: (reader) => withStallDetection(
            reader.read(),
            `Reading ${file.name} is taking longer than expected...`
          ),
          onProgress: (progress) => {
            upload.progress(i, file.name, progress.bytesProcessed, progress.phase);
          },
        }
      );
      fileCid = cid(result.hash, result.key);
      size = result.size;
    }
    uploadedFileNames.push(file.name);

    // Add file to tree immediately after upload completes, so files appear one by one
    if (currentRootCid?.hash) {
      const newRootCid = await saveEntry(upload, origin, currentRootCid, dirPath, file.name, { cid: fileCid, size, type: LinkType.Blob });
      if (!newRootCid) return;
      currentRootCid = newRootCid;
      // Mark this file as changed for pulse effect
      markFilesChanged(new Set([file.name]));
    } else if (needsTreeInit) {
      // First file in a new virtual directory - create encrypted tree
      const { cid: newRootCid } = await tree.putDirectory([{ name: file.name, cid: fileCid, size, type: LinkType.Blob, meta: withModifiedAt(undefined) }]);
      if (!upload.isCurrent()) return;
      currentRootCid = newRootCid;
      markFilesChanged(new Set([file.name]));

      if (isOwnTree && routePubkey) {
        // Save to nostr (fire-and-forget, works offline)
        const currentVisibility = nostrStore.getState().selectedTree?.visibility ?? 'public';
        if (!upload.isCurrent()) return;
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
      needsTreeInit = false; // Tree is now initialized
    } else {
      // No existing tree and not a virtual directory - create new encrypted root
      const { cid: newRootCid } = await tree.putDirectory([{ name: file.name, cid: fileCid, size, type: LinkType.Blob, meta: withModifiedAt(undefined) }]);
      if (!upload.isCurrent()) return;
      currentRootCid = newRootCid;
      markFilesChanged(new Set([file.name]));
      if (i === 0) {
        navigate('/');
      }
    }
  }

  // Note: autosaveIfOwn is called after each file for instant UI updates
  // No need for final autosave since we save progressively

  if (!upload.isCurrent()) return;

  // The folder stays open, as it does for many files: the new row is
  // highlighted there and the toast names it.
  if (uploadedFileNames.length === 1 && !target.dirPath) {
    const fileName = uploadedFileNames[0]!;
    revealFile.set(fileName);
  }
  if (!target.quiet && (uploadedFileNames.length > 1 || !target.dirPath)) {
    toast.success(uploadedFileNames.length === 1 ? `Uploaded ${uploadedFileNames[0]}` : `Uploaded ${uploadedFileNames.length} files`);
  }
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
    const saved = await uploadFilesWithPathsNow(files, origin, upload);
    if (saved && !target.quiet && upload.isCurrent()) {
      toast.success(saved === 1 ? 'Uploaded 1 file' : `Uploaded ${saved} files`);
    }
  });
}

async function uploadFilesWithPathsNow(filesWithPaths: FileWithPath[], origin: UploadOrigin, upload: UploadBatch): Promise<number | undefined> {
  let saved = 0;
  const tree = getTree();
  const { route, dirPath } = origin;

  // Get current rootCid from resolver - track locally for multi-file uploads
  let currentRootCid: CID | null = getTreeRootSync(route.npub, route.treeName);

  // Check if we need to initialize a new tree
  let needsTreeInit = Boolean(!currentRootCid?.hash && route.npub && route.treeName);
  const routePubkey = needsTreeInit
    ? editableTreeRoutePubkey(route.npub, nostrStore.getState())
    : null;
  const isOwnTree = routePubkey !== null;

  // Collect all unique directory paths that need to be created
  const dirsToCreate = new Set<string>();
  for (const { relativePath } of filesWithPaths) {
    const pathParts = relativePath.split('/');
    pathParts.pop(); // Remove filename
    // Add all parent paths
    for (let i = 1; i <= pathParts.length; i++) {
      dirsToCreate.add(pathParts.slice(0, i).join('/'));
    }
  }

  // Sort directories by depth (shallowest first)
  const sortedDirs = Array.from(dirsToCreate).sort((a, b) =>
    a.split('/').length - b.split('/').length
  );

  // Create directories first (before processing files)
  const createdDirs = new Set<string>();

  // Helper to ensure directory exists
  const ensureDir = async (dirPathStr: string) => {
    if (createdDirs.has(dirPathStr)) return;

    const parts = dirPathStr.split('/');
    const dirName = parts.pop()!;
    const parentPath = [...dirPath, ...parts];

    // Create empty directory
    const { cid: emptyDirCid } = await tree.putDirectory([]);

    if (currentRootCid?.hash) {
      const newRootCid = await saveEntry(upload, origin, currentRootCid, parentPath, dirName, { cid: emptyDirCid, size: 0, type: LinkType.Dir });
      if (!newRootCid) return;
      currentRootCid = newRootCid;
    } else if (needsTreeInit) {
      const { cid: rootCidVal } = await tree.putDirectory([]);
      if (!upload.isCurrent()) return;
      const newRootCid = await setEntryForDriveRoute(
        tree,
        rootCidVal,
        parentPath,
        dirName,
        { cid: emptyDirCid, size: 0, type: LinkType.Dir },
        route,
        nostrStore.getState(),
      );
      if (!upload.isCurrent()) return;
      currentRootCid = newRootCid;

      if (isOwnTree && routePubkey) {
        const currentVisibility = nostrStore.getState().selectedTree?.visibility ?? 'public';
        if (!upload.isCurrent()) return;
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
      const { cid: rootCidVal } = await tree.putDirectory([]);
      if (!upload.isCurrent()) return;
      const newRootCid = await setEntryForDriveRoute(
        tree,
        rootCidVal,
        parentPath,
        dirName,
        { cid: emptyDirCid, size: 0, type: LinkType.Dir },
        route,
        nostrStore.getState(),
      );
      if (!upload.isCurrent()) return;
      currentRootCid = newRootCid;
    }

    createdDirs.add(dirPathStr);
  };

  // Create all directories first
  for (const dir of sortedDirs) {
    if (!upload.isCurrent()) return;
    await ensureDir(dir);
  }

  for (let i = 0; i < filesWithPaths.length; i++) {
    // Check for cancellation at start of each file
    if (!upload.isCurrent()) return;

    const { file, relativePath } = filesWithPaths[i];
    if (!file) continue;

    upload.progress(i, relativePath, 0, 'reading');

    // Stream upload - no buffering needed
    // Use videoChunker for video files (smaller first chunk for faster playback start)
    const chunker = isVideoFile(file.name) ? videoChunker() : undefined;
    const stream = tree.createStream({ chunker });
    const result = await streamUploadWithProgress(
      file,
      {
        append: async (chunk) => withStallDetection(
          stream.append(chunk),
          `Writing ${relativePath} is taking longer than expected...`
        ),
        finalize: async () => withStallDetection(
          stream.finalize(),
          `Finalizing ${relativePath} is taking longer than expected...`
        ),
      },
      {
        readChunk: (reader) => withStallDetection(
          reader.read(),
          `Reading ${relativePath} is taking longer than expected...`
        ),
        onProgress: (progress) => {
          upload.progress(i, relativePath, progress.bytesProcessed, progress.phase);
        },
      }
    );
    const fileCid = cid(result.hash, result.key);
    const size = result.size;

    // Parse the relative path to get directory components and filename
    const pathParts = relativePath.split('/');
    const fileName = pathParts.pop()!;
    const fileDirPath = pathParts; // Directory path within the uploaded structure

    // Combine with current directory path
    const fullDirPath = [...dirPath, ...fileDirPath];

    // Add file to tree (directories already exist)
    try {
      if (currentRootCid?.hash) {
        const newRootCid = await saveEntry(upload, origin, currentRootCid, fullDirPath, fileName, { cid: fileCid, size, type: LinkType.Blob });
        if (!newRootCid) return;
        currentRootCid = newRootCid;

        saved++;
        // Mark this file as changed for pulse effect (use just filename for display in current dir)
        if (fileDirPath.length === 0) {
          markFilesChanged(new Set([fileName]));
        }
      }
    } catch (err) {
      console.error(`Failed to add file ${relativePath}:`, err);
      toast.error(`Failed to add ${relativePath}`);
      // Continue with next file instead of stopping entirely
    }
  }

  // Note: autosaveIfOwn is called after each file for instant UI updates

  return saved;
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

  // If no .gitignore, upload with defaults applied
  if (!hasGitignore) {
    await uploadFilesWithPaths(defaultFiltered, target);
    return;
  }

  // If user chose to always skip gitignore, upload with defaults only
  if (gitignoreBehavior === 'never') {
    await uploadFilesWithPaths(defaultFiltered, target);
    return;
  }

  // Find and parse the .gitignore file
  const gitignoreFileEntry = findGitignoreFile(files, rootDirName);
  if (!gitignoreFileEntry) {
    // .gitignore detection was wrong, upload with defaults only
    await uploadFilesWithPaths(defaultFiltered, target);
    return;
  }

  const patterns = await parseGitignoreFromFile(gitignoreFileEntry.file);
  // applyGitignoreFilter includes default patterns, so .git etc. are filtered
  const { included, excluded } = applyGitignoreFilter(files, patterns);

  // If nothing would be excluded beyond defaults, just upload
  if (excluded.length === 0) {
    await uploadFilesWithPaths(included, target);
    return;
  }

  // If user chose to always use gitignore, filter and upload
  if (gitignoreBehavior === 'always') {
    await uploadFilesWithPaths(included, target);
    return;
  }

  // Ask the user (behavior === 'ask')
  // Show modal and wait for decision via Promise
  return new Promise<void>((resolve) => {
    openGitignoreModal({
      allFiles: files,
      includedFiles: included,
      excludedFiles: excluded,
      dirName,
      onDecision: async (gitignore: boolean, rememberGlobally: boolean) => {
        // If user checked "remember", update global setting
        if (rememberGlobally) {
          settingsStore.setUploadSettings({
            gitignoreBehavior: gitignore ? 'always' : 'never',
          });
        }

        const filesToUpload = gitignore ? included : files;
        await uploadFilesWithPaths(filesToUpload, target);
        resolve();
      },
    });
  });
}
