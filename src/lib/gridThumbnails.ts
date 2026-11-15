import { nhashEncode, toHex, type CID } from '@hashtree/core';
import type { DocumentKind } from './documentNames';
import { keyValueStore } from './keyValueStore';
import { getEncodedNhashUrl } from './mediaUrl';

export type ThumbnailKind = DocumentKind | 'image' | 'video';

const store = keyValueStore<{ key: string; blob: Blob }>('iris-drive-photo-thumbnails', 'thumbnails');
const recent = new Map<string, Blob>();
const pending = new Map<string, { controller: AbortController; blob: Promise<Blob>; users: number }>();
const waiting: Array<() => void> = [];
let free = 2;

/** Share generation across tiles. Only small, encoded pictures enter the recent cache. */
export function requestThumbnail(cid: CID, name: string, kind: ThumbnailKind) {
  const nhash = nhashEncode(cid);
  const key = kind + '/' + nhash;
  const cached = recent.get(key);
  if (cached) {
    recent.delete(key);
    recent.set(key, cached);
    return { blob: Promise.resolve(cached), release() {} };
  }

  let job = pending.get(key);
  if (!job) {
    const controller = new AbortController();
    const blob = whenFree(controller, async signal => {
      const media = kind === 'image' || kind === 'video';
      let picture: Blob;
      if (media) {
        // Include the capability in cache identity without writing its key to disk.
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
        const diskKey = toHex(new Uint8Array(digest));
        const kept = await store.get(diskKey).catch(() => undefined);
        if (kept) picture = kept.blob;
        else {
          picture = await mediaThumbnail(getEncodedNhashUrl(nhash, name), kind, signal);
          signal.throwIfAborted();
          await store.put({ key: diskKey, blob: picture }).catch(() => {});
        }
      } else {
        const { documentThumbnail } = await import('./documentThumbnail');
        picture = await documentThumbnail(cid, kind, signal);
      }
      signal.throwIfAborted();
      recent.set(key, picture);
      if (recent.size > 64) recent.delete(recent.keys().next().value!);
      return picture;
    }).finally(() => {
      if (pending.get(key)?.controller === controller) pending.delete(key);
    });
    job = { controller, blob, users: 0 };
    pending.set(key, job);
  }
  const shared = job;
  shared.users++;
  return {
    blob: shared.blob,
    release() {
      if (--shared.users === 0 && pending.get(key) === shared) {
        pending.delete(key);
        shared.controller.abort();
      }
    },
  };
}

/** A waiting tile gives up its place as soon as it scrolls away. */
async function whenFree<T>(controller: AbortController, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = controller.signal;
  if (free > 0) free--;
  else await new Promise<void>((resolve, reject) => {
    const start = () => { signal.removeEventListener('abort', cancel); resolve(); };
    const cancel = () => { waiting.splice(waiting.indexOf(start), 1); reject(signal.reason); };
    waiting.push(start);
    signal.addEventListener('abort', cancel, { once: true });
  });
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    signal.throwIfAborted();
    return await work(signal);
  } finally {
    clearTimeout(timeout);
    const next = waiting.shift();
    if (next) next();
    else free++;
  }
}

async function resized(source: CanvasImageSource, width: number, height: number): Promise<Blob> {
  if (!width || !height) throw new Error('Empty frame');
  // Both grids center-crop. Keep enough for the wider folder tile without shrinking
  // a panorama to a strip that would have to be blown up again.
  const cropWidth = Math.min(width, 2 * height);
  const cropHeight = Math.min(height, 2 * width);
  const scale = Math.min(1, 320 / Math.min(cropWidth, cropHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(cropWidth * scale));
  canvas.height = Math.max(1, Math.round(cropHeight * scale));
  const context = canvas.getContext('2d')!;
  context.drawImage(source, (width - cropWidth) / 2, (height - cropHeight) / 2,
    cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob(
    blob => blob ? resolve(blob) : reject(new Error('Could not encode thumbnail')), 'image/webp', 0.8));
}

async function mediaThumbnail(url: string, kind: 'image' | 'video', signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  if (kind === 'image') {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error('Picture unavailable');
    const bytes = await response.blob();
    const bitmap = typeof createImageBitmap === 'function'
      ? await createImageBitmap(bytes).catch(() => null) : null;
    if (bitmap) {
      try {
        signal.throwIfAborted();
        return await resized(bitmap, bitmap.width, bitmap.height);
      } finally { bitmap.close(); }
    }
    // Some browser codecs are available only through an image element.
    signal.throwIfAborted();
    const image = new Image();
    const src = URL.createObjectURL(bytes);
    try {
      image.src = src;
      await image.decode();
      signal.throwIfAborted();
      return await resized(image, image.naturalWidth, image.naturalHeight);
    } finally {
      image.removeAttribute('src');
      URL.revokeObjectURL(src);
    }
  }

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  try {
    await new Promise<void>((resolve, reject) => {
      signal.onabort = () => reject(signal.reason);
      video.onerror = () => reject(new Error('Video frame unavailable'));
      video.onloadeddata = () => resolve();
      video.src = url + '#t=0.1';
    });
    signal.throwIfAborted();
    return await resized(video, video.videoWidth, video.videoHeight);
  } finally {
    signal.onabort = video.onerror = video.onloadeddata = null;
    video.removeAttribute('src');
    video.load();
  }
}
