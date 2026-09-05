/**
 * Image Attachments Module
 * Handles image upload, storage, and retrieval for Yjs documents
 */
import { LinkType } from '@hashtree/core';
import type { CID } from '@hashtree/core';
import { getTree } from '../../store';
import { getTreeRootSync } from '../../stores';
import { getRefResolver } from '../../refResolver';
import { autosaveIfOwn, nostrStore } from '../../nostr';
import { updateLocalRootCacheHex } from '../../treeRootCache';
import { toHex } from '@hashtree/core';
import { setEntryForDriveRoute } from '../../drive/profileDriveRouteEntry';
import { isNostrIdentityId } from '../../utils/route';
import { captureRouteWriteGuard } from '../routeWriteGuard';

const ATTACHMENTS_DIR = 'attachments';

const MIME_TYPES: Record<string, string> = {
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
  'svg': 'image/svg+xml',
  'avif': 'image/avif',
};

/**
 * Get MIME type from file extension
 */
export function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  return MIME_TYPES[ext] || 'image/png';
}

/**
 * Generate a unique filename for an uploaded image
 */
export function generateImageFilename(file: File): string {
  const ext = file.name.split('.').pop()?.toLowerCase() || 'png';
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6);
  return `${timestamp}-${random}.${ext}`;
}

/**
 * Image cache manager for blob URLs
 */
export function createImageCache() {
  const cache = new Map<string, string>();

  return {
    get(name: string): string | undefined {
      return cache.get(name);
    },
    set(name: string, url: string): void {
      cache.set(name, url);
    },
    has(name: string): boolean {
      return cache.has(name);
    },
    cleanup(): void {
      for (const url of cache.values()) {
        URL.revokeObjectURL(url);
      }
      cache.clear();
    },
  };
}

export type ImageCache = ReturnType<typeof createImageCache>;

export function parseAttachmentReference(
  attachmentPath: string,
  defaultRootScope: string | null,
): { rootScope: string; filename: string } | null {
  const slashIndex = attachmentPath.indexOf('/');
  const explicitScope = slashIndex > 0 ? attachmentPath.slice(0, slashIndex) : '';
  if (explicitScope.startsWith('npub1') || isNostrIdentityId(explicitScope)) {
    const filename = attachmentPath.slice(slashIndex + 1);
    return filename ? { rootScope: explicitScope, filename } : null;
  }
  return defaultRootScope && attachmentPath
    ? { rootScope: defaultRootScope, filename: attachmentPath }
    : null;
}

/**
 * Try to load an image from a specific npub's tree
 * Uses the ref resolver to get the tree root (handles collaborators properly)
 */
async function tryLoadImageFromNpub(
  imageName: string,
  path: string[],
  npub: string,
  treeName: string,
  cache: ImageCache
): Promise<string | null> {
  const tree = getTree();
  const attachmentsPath = [...path, ATTACHMENTS_DIR, imageName].join('/');

  // First try the sync cache (works for currently viewed tree and own tree)
  let rootCid = getTreeRootSync(npub, treeName);

  // If not in cache, try the resolver (handles collaborator trees)
  if (!rootCid) {
    const resolver = getRefResolver();
    const resolverKey = `${npub}/${treeName}`;

    rootCid = await new Promise<CID | null>((resolve) => {
      let hasResolved = false;
      let unsub: (() => void) | null = null;

      const cleanup = () => {
        if (unsub) unsub();
      };

      unsub = resolver.subscribe(resolverKey, (cidObj) => {
        if (hasResolved) return;
        hasResolved = true;
        queueMicrotask(cleanup);
        resolve(cidObj);
      });

      // Short timeout for image loading
      setTimeout(() => {
        if (!hasResolved) {
          hasResolved = true;
          cleanup();
          resolve(null);
        }
      }, 3000);
    });
  }

  if (!rootCid) return null;

  try {
    const result = await tree.resolvePath(rootCid, attachmentsPath);
    if (!result) return null;

    const data = await tree.readFile(result.cid);
    if (!data) return null;

    const mimeType = getMimeType(imageName);
    const blob = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    cache.set(imageName, url);
    return url;
  } catch {
    return null;
  }
}

/**
 * Load an image from the tree and return a blob URL
 * Tries the viewed user's tree first, then falls back to collaborators' trees
 */
export async function loadImageFromTree(
  imageName: string,
  path: string[],
  viewedNpub: string | null,
  userNpub: string | null,
  treeName: string | null,
  cache: ImageCache,
  collaborators: string[] = []
): Promise<string | null> {
  // Check cache first
  if (cache.has(imageName)) {
    return cache.get(imageName)!;
  }

  if (!treeName) return null;

  // Try the primary tree (viewed user or current user)
  const primaryNpub = viewedNpub || userNpub;
  if (primaryNpub) {
    const url = await tryLoadImageFromNpub(imageName, path, primaryNpub, treeName, cache);
    if (url) return url;
  }

  // If not found in primary tree, try collaborators' trees
  for (const collabNpub of collaborators) {
    // Skip if same as primary
    if (collabNpub === primaryNpub) continue;

    const url = await tryLoadImageFromNpub(imageName, path, collabNpub, treeName, cache);
    if (url) return url;
  }

  return null;
}

/**
 * Save an image to the attachments directory
 */
export async function saveImageToTree(
  data: Uint8Array,
  filename: string,
  path: string[],
  rootScope: string,
  treeName: string,
  isOwnTree: boolean,
  visibility?: import('@hashtree/core').TreeVisibility
): Promise<string | null> {
  const tree = getTree();
  const isCurrent = captureRouteWriteGuard();

  let rootCid = getTreeRootSync(rootScope, treeName);
  if (!rootCid) {
    const { cid: emptyDirCid } = await tree.putDirectory([]);
    rootCid = emptyDirCid;
  }

  try {
    const attachmentsPath = [...path, ATTACHMENTS_DIR];

    // Ensure attachments directory exists
    const attachmentsResult = await tree.resolvePath(rootCid, attachmentsPath.join('/'));
    if (!attachmentsResult) {
      const { cid: emptyDirCid } = await tree.putDirectory([]);
      if (!isCurrent()) return null;
      rootCid = await setEntryForDriveRoute(
        tree,
        rootCid,
        path,
        ATTACHMENTS_DIR,
        { cid: emptyDirCid, size: 0, type: LinkType.Dir },
        { npub: rootScope, treeName },
        nostrStore.getState(),
      );
    }

    // Save the image file
    const { cid: imageCid, size: imageSize } = await tree.putFile(data);
    if (!isCurrent()) return null;
    const newRootCid = await setEntryForDriveRoute(
      tree,
      rootCid,
      attachmentsPath,
      filename,
      { cid: imageCid, size: imageSize, type: LinkType.Blob },
      { npub: rootScope, treeName },
      nostrStore.getState(),
    );

    if (!isCurrent()) return null;
    // Publish update
    if (isOwnTree) {
      autosaveIfOwn(newRootCid);
    } else {
      updateLocalRootCacheHex(
        rootScope,
        treeName,
        toHex(newRootCid.hash),
        newRootCid.key ? toHex(newRootCid.key) : undefined,
        visibility
      );
    }

    return filename;
  } catch (err) {
    console.error('[YjsDoc] Failed to save image:', err);
    return null;
  }
}

/**
 * Pre-load all images from the attachments directory
 */
export async function preloadAttachments(
  path: string[],
  viewedNpub: string | null,
  userNpub: string | null,
  treeName: string | null,
  cache: ImageCache
): Promise<void> {
  const tree = getTree();
  const attachmentsPath = [...path, ATTACHMENTS_DIR].join('/');

  let rootCid: CID | null = null;
  if (viewedNpub) {
    rootCid = treeName ? getTreeRootSync(viewedNpub, treeName) : null;
  } else if (userNpub && treeName) {
    rootCid = getTreeRootSync(userNpub, treeName);
  }

  if (!rootCid) return;

  try {
    const result = await tree.resolvePath(rootCid, attachmentsPath);
    if (!result) return;

    const isDir = await tree.isDirectory(result.cid);
    if (!isDir) return;

    const attachmentEntries = await tree.listDirectory(result.cid);

    for (const entry of attachmentEntries) {
      if (entry.type !== LinkType.Dir) {
        await loadImageFromTree(entry.name, path, viewedNpub, userNpub, treeName, cache);
      }
    }
  } catch {
    // Attachments directory doesn't exist yet
  }
}
