/**
 * When photos were taken, read from the start of each JPEG file and kept by
 * the file's content hash on this device, so each file is read once. Reading
 * goes on in the background a couple of files at a time; Photos shows each
 * photo by the time it changed in Drive until its own date is known.
 */
import { getTree } from '../store';
import { EXIF_READ_BYTES, exifTakenAt, isJpegName } from './exif';
import { keyValueStore } from './keyValueStore';
import type { Photo } from './photos';

interface Row {
  key: string;
  taken: number | null;
}

const PARALLEL_READS = 2;
const READ_TIMEOUT_MS = 8000;

const store = keyValueStore<Row>('iris-drive-photo-dates', 'dates');
const taken = new Map<string, number | null>();
/** Files asked for since the app opened; one not read then is tried again the next time it opens. */
const asked = new Set<string>();
const waiting: Photo[] = [];
const listeners = new Set<() => void>();
let loaded: Promise<void> | null = null;
let active = 0;

/** The dates known so far, by content hash: null where the file says none. */
export function photoDatesKnown(): ReadonlyMap<string, number | null> {
  return taken;
}

/** Called when more dates are known. */
export function onPhotoDates(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

/** The dates kept on this device, read once. */
export function loadPhotoDates(): Promise<void> {
  loaded ??= store.all().then((rows) => {
    for (const row of rows) if (!taken.has(row.key)) taken.set(row.key, row.taken);
    if (rows.length > 0) notify();
  }, () => {});
  return loaded;
}

/** Read the dates of these photos not known yet. */
export function readPhotoDates(photos: Photo[]): void {
  void loadPhotoDates().then(() => {
    for (const photo of photos) {
      if (photo.video || !isJpegName(photo.name) || taken.has(photo.hash) || asked.has(photo.hash)) continue;
      asked.add(photo.hash);
      waiting.push(photo);
    }
    pump();
  });
}

function pump(): void {
  while (active < PARALLEL_READS && waiting.length > 0) {
    const photo = waiting.shift()!;
    active += 1;
    void readOne(photo).finally(() => {
      active -= 1;
      pump();
    });
  }
}

async function readOne(photo: Photo): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // A file whose blocks are not here is left for another time rather than waited for.
    const bytes = await Promise.race([
      getTree().readFileRange(photo.cid, 0, Math.min(EXIF_READ_BYTES, photo.size || EXIF_READ_BYTES)),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), READ_TIMEOUT_MS); }),
    ]);
    if (!bytes) return;
    const date = exifTakenAt(bytes);
    taken.set(photo.hash, date);
    notify();
    await store.put({ key: photo.hash, taken: date }).catch(() => {});
  } catch {
    // Unreadable now.
  } finally {
    clearTimeout(timer);
  }
}
