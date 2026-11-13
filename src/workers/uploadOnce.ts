/**
 * Sends each block to a file server once.
 *
 * Publishing a Drive version walks the whole Drive and uploads every block of
 * it, including the ones the server confirmed a moment ago, and a share or a
 * device approval publishes several versions in a row. Nearly all of those
 * uploads repeat a block the server already holds, and everything that waits
 * for a version to be published waits for them.
 *
 * This remembers which blocks a server has confirmed and answers a repeated
 * upload at once, the way the server itself answers for a block it already has.
 * A confirmation is trusted for a day, so a block the server has since dropped
 * is sent again by the next day's first publish at the latest.
 */

const KEEP_MS = 24 * 60 * 60 * 1000;
const MAX_REMEMBERED = 200_000;
const SAVE_DELAY_MS = 2000;
const HASH = /^[0-9a-f]{64}$/;
const UPLOAD_PATH = '/upload';

export interface ConfirmedUploadStorage {
  load(): Promise<Array<[string, number]>>;
  save(entries: Array<[string, number]>): Promise<void>;
  remove(keys: string[]): Promise<void>;
}

export class ConfirmedUploads {
  private readonly confirmed = new Map<string, number>();
  private unsaved: Array<[string, number]> = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly storage: ConfirmedUploadStorage | null = null,
    private readonly now: () => number = Date.now,
  ) {
    void this.restore();
  }

  private async restore(): Promise<void> {
    if (!this.storage) return;
    try {
      const expired: string[] = [];
      for (const [key, confirmedAt] of await this.storage.load()) {
        if (this.now() - confirmedAt >= KEEP_MS) expired.push(key);
        else if (!this.confirmed.has(key) && this.confirmed.size < MAX_REMEMBERED) this.confirmed.set(key, confirmedAt);
      }
      if (expired.length > 0) await this.storage.remove(expired);
    } catch {
      // Without the saved list every block is confirmed again, once.
    }
  }

  has(server: string, hash: string): boolean {
    const key = `${server}|${hash}`;
    const confirmedAt = this.confirmed.get(key);
    if (confirmedAt === undefined) return false;
    if (this.now() - confirmedAt < KEEP_MS) return true;
    this.confirmed.delete(key);
    return false;
  }

  add(server: string, hash: string): void {
    if (this.confirmed.size >= MAX_REMEMBERED) return;
    const entry: [string, number] = [`${server}|${hash}`, this.now()];
    this.confirmed.set(entry[0], entry[1]);
    if (!this.storage) return;
    this.unsaved.push(entry);
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      const entries = this.unsaved;
      this.unsaved = [];
      void this.storage?.save(entries).catch(() => {});
    }, SAVE_DELAY_MS);
  }

  forget(server: string, hash: string): void {
    const key = `${server}|${hash}`;
    this.confirmed.delete(key);
    this.unsaved = this.unsaved.filter(([unsavedKey]) => unsavedKey !== key);
    void this.storage?.remove([key]).catch(() => {});
  }
}

function alreadyStored(hash: string): Response {
  return new Response(JSON.stringify({ sha256: hash }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** True when the server's answer says it now holds exactly this block. */
async function confirms(response: Response, hash: string): Promise<boolean> {
  if (response.status === 409) return true;
  if (!response.ok) return false;
  try {
    const answer = await response.clone().json() as { sha256?: unknown };
    return !answer?.sha256 || answer.sha256 === hash;
  } catch {
    return true;
  }
}

export function uploadOnceFetch(realFetch: typeof fetch, uploads: ConfirmedUploads): typeof fetch {
  const inFlight = new Map<string, Promise<boolean>>();

  return async (input, init) => {
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method !== 'PUT' && method !== 'DELETE') return realFetch(input, init);
    let url: URL;
    try {
      url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    } catch {
      return realFetch(input, init);
    }

    if (method === 'DELETE') {
      const removed = /^(.*)\/([0-9a-f]{64})\.bin$/.exec(url.pathname);
      if (removed) uploads.forget(url.origin + removed[1], removed[2]);
      return realFetch(input, init);
    }

    const hash = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get('x-sha-256') ?? '';
    if (!url.pathname.endsWith(UPLOAD_PATH) || !HASH.test(hash)) return realFetch(input, init);
    const server = url.origin + url.pathname.slice(0, -UPLOAD_PATH.length);
    const key = `${server}|${hash}`;

    // The same block is often sent twice at the same moment (once as it is
    // written, once by the publish that follows): the second waits for the first.
    const sameBlock = inFlight.get(key);
    if (sameBlock) await sameBlock;
    if (uploads.has(server, hash)) return alreadyStored(hash);

    const sending = realFetch(input, init);
    // Recorded inside the shared promise, so whoever waits for it sees the result.
    const outcome = sending.then(async (response) => {
      const confirmed = await confirms(response, hash);
      if (confirmed) uploads.add(server, hash);
      return confirmed;
    }, () => false);
    inFlight.set(key, outcome);
    try {
      const response = await sending;
      await outcome;
      return response;
    } finally {
      if (inFlight.get(key) === outcome) inFlight.delete(key);
    }
  };
}

const DB_NAME = 'iris-drive-confirmed-uploads';
const STORE_NAME = 'confirmed';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE_NAME); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function inStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T> | null): Promise<T | undefined> {
  return openDatabase().then((database) => new Promise<T | undefined>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    const request = run(transaction.objectStore(STORE_NAME));
    transaction.oncomplete = () => { database.close(); resolve(request?.result); };
    transaction.onerror = transaction.onabort = () => { database.close(); reject(transaction.error); };
  }));
}

export const browserConfirmedUploadStorage: ConfirmedUploadStorage = {
  async load() {
    const [keys, times] = await Promise.all([
      inStore('readonly', (store) => store.getAllKeys()),
      inStore('readonly', (store) => store.getAll() as IDBRequest<number[]>),
    ]);
    if (!keys || !times || keys.length !== times.length) return [];
    return keys.map((key, index): [string, number] => [String(key), times[index]]);
  },
  async save(entries) {
    await inStore('readwrite', (store) => {
      for (const [key, confirmedAt] of entries) store.put(confirmedAt, key);
      return null;
    });
  },
  async remove(keys) {
    await inStore('readwrite', (store) => {
      for (const key of keys) store.delete(key);
      return null;
    });
  },
};
