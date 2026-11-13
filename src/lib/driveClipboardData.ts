/**
 * The slower half of driveClipboard.ts, loaded when something is first
 * copied, pasted or dropped: reading a file's bytes, redrawing a picture as
 * PNG (the one picture type every browser puts on the system clipboard),
 * walking a dropped folder and fetching a picture dragged from a web page.
 */
import type { TreeEntry } from '@hashtree/core';
import type { FileWithPath } from '@iris/hashtree-app/directory';
import { getTree } from '../store';
import { pngOf } from './clipboardPng';

/** Largest picture fetched from a web page. */
const MAX_PICTURE_BYTES = 50 * 1024 * 1024;

const PICTURE_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  avif: 'image/avif', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
};

async function entryBytes(entry: Pick<TreeEntry, 'cid' | 'name'>): Promise<Uint8Array> {
  const data = await getTree().readFile(entry.cid);
  if (!data) throw new Error(`${entry.name} could not be read`);
  return data;
}

export async function entryPng(entry: Pick<TreeEntry, 'cid' | 'name'>): Promise<Blob> {
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
  const bytes = await entryBytes(entry);
  return pngOf(new Blob([bytes as BlobPart], { type: PICTURE_TYPES[ext] ?? 'application/octet-stream' }));
}

export async function entryText(entry: Pick<TreeEntry, 'cid' | 'name'>): Promise<string> {
  return new TextDecoder().decode(await entryBytes(entry));
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function childrenOf(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((resolve, reject) => {
    // A folder hands out its children in batches until an empty one.
    const next = () => reader.readEntries((batch) => {
      if (batch.length === 0) resolve(all);
      else {
        all.push(...batch);
        next();
      }
    }, reject);
    next();
  });
}

/** Every file under the dropped entries, with its path from the dropped item. */
export async function filesOfEntries(entries: FileSystemEntry[]): Promise<FileWithPath[]> {
  const files: FileWithPath[] = [];
  const walk = async (entry: FileSystemEntry, path: string): Promise<void> => {
    if (entry.isFile) {
      files.push({ file: await fileOf(entry as FileSystemFileEntry), relativePath: path });
    } else if (entry.isDirectory) {
      for (const child of await childrenOf(entry as FileSystemDirectoryEntry)) await walk(child, `${path}/${child.name}`);
    }
  };
  for (const entry of entries) await walk(entry, entry.name);
  return files;
}

/** A picture fetched from where a web page shows it; null when that site does not allow it or it is no picture. */
export async function fetchPicture(url: string, name: (type: string, fromUrl: string) => string): Promise<File | null> {
  try {
    const response = await fetch(url, { credentials: 'omit' });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith('image/') || blob.size === 0 || blob.size > MAX_PICTURE_BYTES) return null;
    const last = url.startsWith('data:') ? '' : decodeURIComponent(url.split(/[?#]/)[0]!.split('/').pop() ?? '');
    return new File([blob], name(blob.type, last), { type: blob.type });
  } catch {
    return null;
  }
}
