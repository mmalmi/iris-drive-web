/**
 * Compression utilities using fflate for ZIP creation and extraction
 */
import { zip, unzipSync, type AsyncZippable, type Unzipped } from 'fflate';
import type { HashTree, CID, TreeEntry } from '@hashtree/core';
import { LinkType } from '@hashtree/core';
import { createLimiter } from '../drive/profileDriveMutation';

const ZIP_IO_CONCURRENCY = 6;
/** Formats that are already compressed: store directly in ZIP instead of wasting CPU re-deflating. */
const PRECOMPRESSED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'avif', 'heic', 'heif',
  'mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'm4a', 'ogg', 'opus', 'aac', 'flac',
  'zip', 'gz', 'bz2', 'xz', '7z', 'zst', 'br', 'woff2', 'pdf',
]);

export interface ZipProgress {
  current: number;
  total: number;
  fileName: string;
}

export type ProgressCallback = (progress: ZipProgress) => void;

export class ZipCancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.name = 'ZipCancelledError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new ZipCancelledError();
  }
}

function isPrecompressed(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot >= 0 && PRECOMPRESSED_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/**
 * Get archive entries from a ZIP file
 */
export function extractZip(data: Uint8Array): Unzipped {
  return unzipSync(data);
}

interface CollectedItem {
  cid: CID;
  size?: number;
  isDirectory: boolean;
}

/**
 * Recursively collect all files and empty directories from a directory tree
 */
async function collectFiles(
  tree: HashTree,
  dirCid: CID,
  basePath: string,
  items: Map<string, CollectedItem>,
  limit: ReturnType<typeof createLimiter>,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  counter = { value: 0 },
): Promise<boolean> {
  throwIfAborted(signal);
  const entries = await limit(() => tree.listDirectory(dirCid));
  throwIfAborted(signal);
  return collectEntries(tree, entries, basePath, items, limit, onProgress, signal, counter);
}

/** Collects the given entries and all below them; false when there are none. */
async function collectEntries(
  tree: HashTree,
  entries: TreeEntry[],
  basePath: string,
  items: Map<string, CollectedItem>,
  limit: ReturnType<typeof createLimiter>,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  counter = { value: 0 },
): Promise<boolean> {
  if (entries.length === 0) return false;

  const subdirs: Array<{ entry: TreeEntry; fullPath: string }> = [];
  for (const entry of entries) {
    const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.type === LinkType.Dir) {
      subdirs.push({ entry, fullPath });
    } else {
      items.set(fullPath, { cid: entry.cid, size: entry.size, isDirectory: false });
      counter.value++;
      onProgress?.({
        current: counter.value,
        total: -1, // Unknown total during collection
        fileName: fullPath,
      });
      throwIfAborted(signal);
    }
  }

  await Promise.all(subdirs.map(async ({ entry, fullPath }) => {
    const subdirHasContent = await collectFiles(tree, entry.cid, fullPath, items, limit, onProgress, signal, counter);
    if (!subdirHasContent) {
      // Empty directory - add it with trailing slash
      items.set(fullPath + '/', { cid: entry.cid, isDirectory: true });
    }
  }));

  return true;
}

/**
 * Create a ZIP file from a directory in the HashTree
 */
export async function createZipFromDirectory(
  tree: HashTree,
  dirCid: CID,
  dirName: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const entries = await tree.listDirectory(dirCid);
  return createZipFromEntries(tree, entries, onProgress, signal);
}

/**
 * Create a ZIP file of several entries side by side, each folder with all
 * that is in it, as when several items are chosen and downloaded at once.
 */
export async function createZipFromEntries(
  tree: HashTree,
  entries: TreeEntry[],
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);

  const limit = createLimiter(ZIP_IO_CONCURRENCY);
  const items = new Map<string, CollectedItem>();
  await collectEntries(tree, entries, '', items, limit, onProgress, signal);
  throwIfAborted(signal);

  const fileItems: Array<[string, CollectedItem]> = [];
  const zipFiles: AsyncZippable = {};
  for (const [path, info] of items) {
    if (info.isDirectory) {
      zipFiles[path] = [new Uint8Array(0), { level: 0 }];
    } else {
      fileItems.push([path, info]);
    }
  }

  const fileCount = fileItems.length;
  let current = 0;

  await Promise.all(fileItems.map(([path, info]) => limit(async () => {
    throwIfAborted(signal);
    current++;
    onProgress?.({
      current,
      total: fileCount,
      fileName: path,
    });
    throwIfAborted(signal);

    const data = await tree.readFile(info.cid);
    throwIfAborted(signal);
    if (data) {
      zipFiles[path] = isPrecompressed(path) ? [data, { level: 0 }] : data;
    }
  })));

  // Create the ZIP
  return new Promise((resolve, reject) => {
    let finished = false;
    let terminate: (() => void) | null = null;
    const abort = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      terminate?.();
      reject(new ZipCancelledError());
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener('abort', abort, { once: true });
    terminate = zip(zipFiles, { level: 6 }, (err, data) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', abort);
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}

/**
 * Extract files from an archive and return them as name->data pairs
 */
export interface ExtractedFile {
  name: string;
  data: Uint8Array;
  isDirectory: boolean;
}

export function extractArchive(data: Uint8Array, fileName: string): ExtractedFile[] {
  const ext = fileName.toLowerCase().split('.').pop();

  if (ext !== 'zip') {
    throw new Error(`Unsupported archive format: ${ext}`);
  }

  const unzipped = unzipSync(data);
  const files: ExtractedFile[] = [];

  for (const [name, content] of Object.entries(unzipped)) {
    // Skip Mac OS X metadata
    if (name.startsWith('__MACOSX/') || name.endsWith('.DS_Store')) {
      continue;
    }

    // Check if it's a directory (ends with / or empty content)
    const isDirectory = name.endsWith('/') || content.length === 0;

    if (!isDirectory) {
      files.push({
        name: name.replace(/\/$/, ''), // Remove trailing slash if any
        data: content,
        isDirectory: false,
      });
    }
  }

  return files;
}

/**
 * File info without data - for listing archive contents without decompressing
 */
export interface ArchiveFileInfo {
  name: string;
  size: number;
}

export interface ArchiveInfo {
  files: ArchiveFileInfo[];
  /** If all files share a common root directory, this is that directory name */
  commonRoot: string | null;
}

/**
 * Get list of files in a ZIP without decompressing data
 * Uses unzipSync filter to read central directory only
 * Also detects if all files are under a common root directory
 */
export function getArchiveFileList(data: Uint8Array): ArchiveInfo {
  const files: ArchiveFileInfo[] = [];

  unzipSync(data, {
    filter: (file) => {
      // Skip Mac OS X metadata
      if (file.name.startsWith('__MACOSX/') || file.name.endsWith('.DS_Store')) {
        return false;
      }
      // Skip directories
      if (file.name.endsWith('/')) {
        return false;
      }
      files.push({
        name: file.name,
        size: file.originalSize ?? 0,
      });
      return false; // Don't actually decompress
    }
  });

  // Check if all files share a common root directory
  let commonRoot: string | null = null;
  if (files.length > 0) {
    const firstSlash = files[0].name.indexOf('/');
    if (firstSlash > 0) {
      const potentialRoot = files[0].name.substring(0, firstSlash);
      const allHaveSameRoot = files.every(f => f.name.startsWith(potentialRoot + '/'));
      if (allHaveSameRoot) {
        commonRoot = potentialRoot;
      }
    }
  }

  return { files, commonRoot };
}

/**
 * Extract a batch of files from a ZIP by name
 * Returns a Map of fileName -> data
 */
export function extractFileBatch(data: Uint8Array, fileNames: Set<string>): Map<string, Uint8Array> {
  const result = unzipSync(data, {
    filter: (file) => fileNames.has(file.name)
  });

  const map = new Map<string, Uint8Array>();
  for (const [name, content] of Object.entries(result)) {
    map.set(name, content);
  }
  return map;
}

/**
 * Download a Uint8Array as a file
 */
export function downloadBlob(data: Uint8Array, fileName: string, mimeType: string = 'application/octet-stream'): void {
  const blob = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
