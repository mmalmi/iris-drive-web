/**
 * Saving a file or a folder from Drive to the device, from wherever it is
 * offered: a file's page, a folder's menu, or a row's menu in the list.
 */
import type { CID } from '@hashtree/core';
import { getTree } from '../store';
import { getNhashFileUrl } from './mediaUrl';
import { createZipFromDirectory, downloadBlob, ZipCancelledError } from '../utils/compression';
import { setUploadProgress } from '../stores/upload';

const MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
};

function extensionOf(name: string): string {
  return name.split('.').pop()?.toLowerCase() || '';
}

/**
 * Saves a file: with the browser's save dialog where it has one, otherwise as
 * a download from the app's own address.
 */
export async function downloadFile(entry: { cid: CID; name: string }): Promise<void> {
  const fileName = entry.name;
  const mimeType = MIME_TYPES[extensionOf(fileName)] || 'application/octet-stream';

  if (window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: fileName,
        types: [{
          description: 'File',
          accept: { [mimeType]: ['.' + extensionOf(fileName)] },
        }],
      });
      const writable = await handle.createWritable();
      for await (const chunk of getTree().readFileStream(entry.cid, { prefetch: 5 })) {
        await writable.write(chunk as BufferSource);
      }
      await writable.close();
      return;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.warn('File System Access API failed, falling back to blob:', err);
    }
  }

  const baseUrl = getNhashFileUrl(entry.cid, fileName);
  const separator = baseUrl.includes('?') ? '&' : '?';
  window.location.href = `${baseUrl}${separator}download=1`;
}

/**
 * Saves a folder and all that is in it as `<name>.zip`, showing its progress
 * with a way to cancel. Resolves false when cancelled.
 */
export async function downloadFolderZip(cid: CID, name: string, signal?: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const cancel = () => controller.abort();
    const zipData = await createZipFromDirectory(getTree(), cid, name, (progress) => {
      setUploadProgress({
        current: progress.current,
        total: progress.total,
        fileName: progress.fileName,
        status: 'zipping',
        cancel,
      });
    }, controller.signal);
    setUploadProgress(null);
    downloadBlob(zipData, `${name}.zip`, 'application/zip');
    return true;
  } catch (err) {
    if (err instanceof ZipCancelledError) return false;
    throw err;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    setUploadProgress(null);
  }
}
