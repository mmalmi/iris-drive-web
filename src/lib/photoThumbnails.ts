/**
 * Small pictures for the squares of Photos, made once from each picture and
 * kept on this device by its content hash. A phone's 12-megapixel photo
 * shown whole in a square takes some 15 MB of memory while it is on screen;
 * its small picture well under one, and it shows at once the next time.
 */
import { getNhashFileUrl } from './mediaUrl';
import { keyValueStore } from './keyValueStore';
import type { Photo } from './photos';

interface Row {
  key: string;
  /** Null where the picture is small enough to show as it is. */
  blob: Blob | null;
}

/** The shorter side of a small picture, in pixels: a square of the grid on a sharp screen. */
const SIDE = 320;
const PARALLEL = 2;

const store = keyValueStore<Row>('iris-drive-photo-thumbnails', 'thumbnails');
const shown = new Map<string, Promise<string>>();
const waiting: Array<() => void> = [];
let active = 0;

/** Where to show a picture in the grid from: its small picture, or the picture itself where there is none. */
export function photoThumbnail(photo: Photo): Promise<string> {
  let url = shown.get(photo.hash);
  if (!url) {
    url = thumbnailOf(photo);
    shown.set(photo.hash, url);
  }
  return url;
}

async function thumbnailOf(photo: Photo): Promise<string> {
  const whole = getNhashFileUrl(photo.cid, photo.name);
  const kept = await store.get(photo.hash).catch(() => undefined);
  if (kept) return kept.blob ? URL.createObjectURL(kept.blob) : whole;
  const made = await whenFree(() => makeThumbnail(whole)).catch(() => undefined);
  // Not made now (not here yet, or not a picture this browser reads): the picture itself, tried again another time.
  if (made === undefined) {
    shown.delete(photo.hash);
    return whole;
  }
  void store.put({ key: photo.hash, blob: made }).catch(() => {});
  return made ? URL.createObjectURL(made) : whole;
}

async function whenFree<T>(work: () => Promise<T>): Promise<T> {
  if (active >= PARALLEL) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  try {
    return await work();
  } finally {
    active -= 1;
    waiting.shift()?.();
  }
}

/** The small picture, or null when the picture is no bigger. */
async function makeThumbnail(url: string): Promise<Blob | null> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}`);
  const full = await createImageBitmap(await response.blob());
  try {
    const scale = SIDE / Math.min(full.width, full.height);
    if (scale >= 0.8) return null;
    const width = Math.max(1, Math.round(full.width * scale));
    const height = Math.max(1, Math.round(full.height * scale));
    const small = await createImageBitmap(full, { resizeWidth: width, resizeHeight: height, resizeQuality: 'medium' });
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d')!.drawImage(small, 0, 0);
    small.close();
    // WebP keeps what is see-through; a browser that cannot write it writes PNG.
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob'))), 'image/webp', 0.8));
  } finally {
    full.close();
  }
}
