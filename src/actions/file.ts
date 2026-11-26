/**
 * File operations - create, save, upload files
 */
import { LinkType, type CID } from '@hashtree/core';
import { autosaveIfOwn, nostrStore } from '../nostr';
import { getTree } from '../store';
import { markFilesChanged } from '../stores/recentlyChanged';
import { setUploadProgress } from '../stores/upload';
import { parseRoute } from '../utils/route';
import { getCurrentRootCid, getCurrentPathFromUrl, updateRoute } from './route';
import { initVirtualTree } from './tree';
import { DirectoryBuilder } from '../drive/directoryBuilder';
import { createLimiter } from '../drive/profileDriveMutation';
import { setEntriesForDriveRoute, setEntryForDriveRoute, type DriveEntryWrite } from '../drive/profileDriveRouteEntry';
import { captureRouteWriteGuard } from '../lib/routeWriteGuard';
import { inTurn } from '../lib/driveWrites';
import { withModifiedAt } from '../lib/modifiedAt';

const EXTRACT_PUT_CONCURRENCY = 8;

async function setCurrentRouteEntry(
  root: CID,
  parentPath: string[],
  name: string,
  cid: CID,
  size: number,
  type: LinkType = LinkType.Blob,
): Promise<CID> {
  const tree = getTree();
  const route = parseRoute();
  return setEntryForDriveRoute(
    tree,
    root,
    parentPath,
    name,
    { cid, size, type },
    route,
    nostrStore.getState(),
  );
}

// Save edited file
export async function saveFile(entryName: string | undefined, content: string): Promise<Uint8Array | null> {
  const isCurrent = captureRouteWriteGuard();
  if (!entryName) return null;

  const rootCid = getCurrentRootCid();
  if (!rootCid) return null;

  const tree = getTree();
  const data = new TextEncoder().encode(content);
  const currentPath = getCurrentPathFromUrl();

  // putFile returns CID with key (encrypted by default)
  const { cid: fileCid, size } = await tree.putFile(data);

  // setEntry uses root CID and entry CID - handles encryption automatically
  if (!isCurrent()) return null;
  const newRootCid = await setCurrentRouteEntry(
    rootCid,
    currentPath,
    entryName,
    fileCid,
    size
  );

  // Publish to nostr - resolver will pick up the update automatically
  if (!isCurrent()) return null;
  autosaveIfOwn(newRootCid);

  // Mark file as recently changed for LIVE indicator
  markFilesChanged(new Set([entryName]));

  return data;
}

// Create new file
export async function createFile(name: string, content: string = '') {
  const isCurrent = captureRouteWriteGuard();
  if (!name) return;

  const rootCid = getCurrentRootCid();
  const tree = getTree();
  const data = new TextEncoder().encode(content);
  const currentPath = getCurrentPathFromUrl();

  // putFile returns CID (encrypted by default)
  const { cid: fileCid, size } = await tree.putFile(data);

  if (rootCid) {
    // Add to existing tree
    if (!isCurrent()) return;
    const newRootCid = await setCurrentRouteEntry(
      rootCid,
      currentPath,
      name,
      fileCid,
      size
    );
    // Publish to nostr - resolver will pick up the update
    if (!isCurrent()) return;
    autosaveIfOwn(newRootCid);
  } else {
    // Initialize virtual tree with this file
    if (!isCurrent()) return;
    const result = await initVirtualTree([{ name, cid: fileCid, size }]);
    if (!result) return; // Failed to initialize
  }

  // Mark file as recently changed for LIVE indicator
  markFilesChanged(new Set([name]));

  // Navigate to the newly created file with edit mode
  updateRoute(name, { edit: true });
}

/** Adds a file or folder that is already stored, such as one copied from another folder, to the open folder. */
export async function addCopiedEntry(name: string, entry: { cid: CID; size: number; type: LinkType }): Promise<void> {
  const isCurrent = captureRouteWriteGuard();
  const path = getCurrentPathFromUrl();
  await inTurn(async () => {
    const rootCid = getCurrentRootCid();
    if (!rootCid) throw new Error('No folder is open');
    const newRootCid = await setCurrentRouteEntry(rootCid, path, name, entry.cid, entry.size, entry.type);
    if (!isCurrent()) return;
    autosaveIfOwn(newRootCid);
    markFilesChanged(new Set([name]));
  });
}

// Upload a single file (used for "Keep as ZIP" option)
export async function uploadSingleFile(fileName: string, data: Uint8Array): Promise<void> {
  const isCurrent = captureRouteWriteGuard();
  const tree = getTree();
  const route = parseRoute();
  const currentPath = getCurrentPathFromUrl();

  const { cid: fileCid, size } = await tree.putFile(data);

  let rootCid = getCurrentRootCid();

  if (rootCid) {
    if (!isCurrent()) return;
    const newRootCid = await setCurrentRouteEntry(
      rootCid,
      currentPath,
      fileName,
      fileCid,
      size
    );
    rootCid = newRootCid;
    markFilesChanged(new Set([fileName]));
  } else if (route.npub && route.treeName) {
    // Virtual tree case - initialize and save to nostr
    if (!isCurrent()) return;
    const result = await initVirtualTree([{ name: fileName, cid: fileCid, size, type: LinkType.Blob }]);
    if (result) {
      markFilesChanged(new Set([fileName]));
    }
    return;
  } else {
    // No tree context - create new encrypted tree
    const result = await tree.putDirectory([{ name: fileName, cid: fileCid, size, type: LinkType.Blob }]);
    rootCid = result.cid;
    markFilesChanged(new Set([fileName]));
  }

  if (rootCid) {
    if (!isCurrent()) return;
    autosaveIfOwn(rootCid);
  }
}

/**
 * Extract files from a ZIP archive and splice them into the open folder in one
 * queued tree update so concurrent edits are preserved and each directory is
 * written once.
 */
export async function uploadExtractedFiles(archiveData: Uint8Array, archiveName: string, subdirName?: string): Promise<void> {
  const isCurrent = captureRouteWriteGuard();
  setUploadProgress({
    current: 0,
    total: 1,
    fileName: 'Extracting archive...',
    bytes: 0,
    totalBytes: archiveData.length,
    status: 'writing',
  });

  try {
    // Allow UI to render progress before sync archive decompression.
    await new Promise((r) => setTimeout(r, 50));
    if (!isCurrent()) return;

    const { extractArchive } = await import('../utils/compression');
    if (!isCurrent()) return;
    const extractedFiles = extractArchive(archiveData, archiveName);
    if (extractedFiles.length === 0) return;

    const tree = getTree();
    const currentPath = getCurrentPathFromUrl();
    const basePath = subdirName ? [...currentPath, subdirName] : currentPath;
    const total = extractedFiles.length;
    const totalBytes = extractedFiles.reduce((sum, f) => sum + f.data.length, 0);

    let completed = 0;
    let bytesProcessed = 0;
    const limit = createLimiter(EXTRACT_PUT_CONCURRENCY);
    const writes: DriveEntryWrite[] = [];

    await Promise.all(extractedFiles.map((file) => limit(async () => {
      if (!isCurrent()) return;
      const { cid: fileCid, size } = await tree.putFile(file.data);
      completed += 1;
      bytesProcessed += file.data.length;
      if (isCurrent()) {
        setUploadProgress({
          current: completed,
          total,
          fileName: file.name,
          bytes: bytesProcessed,
          totalBytes,
          status: 'writing',
        });
      }
      const parts = file.name.split('/').filter(Boolean);
      const name = parts.pop();
      if (!name) return;
      writes.push({
        parentPath: [...basePath, ...parts],
        name,
        entry: { cid: fileCid, size, type: LinkType.Blob },
      });
    })));

    if (!isCurrent() || writes.length === 0) return;

    await inTurn(async () => {
      if (!isCurrent()) return;
      const rootCid = getCurrentRootCid();
      if (rootCid) {
        const nextRoot = await setEntriesForDriveRoute(tree, rootCid, writes, parseRoute(), nostrStore.getState());
        if (!isCurrent()) return;
        autosaveIfOwn(nextRoot);
        return;
      }

      // Uninitialized tree: assemble the extracted subtree bottom-up once.
      const builder = new DirectoryBuilder();
      for (const write of writes) {
        builder.directory(write.parentPath).setLeaf(write.name, {
          ...write.entry,
          meta: withModifiedAt(write.entry.meta),
        });
      }
      const builtRoot = await builder.put(tree);
      if (!isCurrent()) return;
      const topEntries = await tree.listDirectory(builtRoot);
      const route = parseRoute();
      if (route.npub && route.treeName) {
        await initVirtualTree(topEntries.map((entry) => ({
          name: entry.name,
          cid: entry.cid,
          size: entry.size,
          type: entry.type,
        })));
      } else {
        autosaveIfOwn(builtRoot);
      }
    });
  } finally {
    setUploadProgress(null);
  }
}
