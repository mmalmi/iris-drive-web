/**
 * A small keyed store in IndexedDB: rows `{ key, ...value }` in one object
 * store whose key path is `key`.
 *
 * Settings and link keys are read on every start. Opening them through Dexie
 * put that library on the path to the first screen; plain IndexedDB does the
 * same with no download. The databases are the ones Dexie created before
 * (`&key` / `key` primary key), opened at whatever version they are at, so
 * nothing stored earlier is lost.
 */
export interface KeyValueStore<Row extends { key: string }> {
  get(key: string): Promise<Row | undefined>;
  put(row: Row): Promise<void>;
  all(): Promise<Row[]>;
}

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase(name: string, storeName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => {
      // Only a new database: create the store at the first version.
      request.result.createObjectStore(storeName, { keyPath: 'key' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(storeName)) {
        resolve(db);
        return;
      }
      // A database that exists without the store: add it in a new version.
      const version = db.version + 1;
      db.close();
      const upgrade = indexedDB.open(name, version);
      upgrade.onupgradeneeded = () => {
        if (!upgrade.result.objectStoreNames.contains(storeName)) {
          upgrade.result.createObjectStore(storeName, { keyPath: 'key' });
        }
      };
      upgrade.onsuccess = () => resolve(upgrade.result);
      upgrade.onerror = () => reject(upgrade.error);
    };
  });
}

export function keyValueStore<Row extends { key: string }>(name: string, storeName: string): KeyValueStore<Row> {
  let opened: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> => {
    opened ??= openDatabase(name, storeName).then((db) => {
      // Another tab upgrading the database must not be blocked by this one.
      db.onversionchange = () => {
        db.close();
        opened = null;
      };
      return db;
    }, (error) => {
      opened = null;
      throw error;
    });
    return opened;
  };
  const store = async (mode: IDBTransactionMode) => (await database()).transaction(storeName, mode).objectStore(storeName);

  return {
    async get(key) {
      return promised((await store('readonly')).get(key) as IDBRequest<Row | undefined>);
    },
    async put(row) {
      const objectStore = await store('readwrite');
      await promised(objectStore.put(row));
      await new Promise<void>((resolve, reject) => {
        objectStore.transaction.oncomplete = () => resolve();
        objectStore.transaction.onerror = () => reject(objectStore.transaction.error);
        objectStore.transaction.onabort = () => reject(objectStore.transaction.error);
      });
    },
    async all() {
      return promised((await store('readonly')).getAll() as IDBRequest<Row[]>);
    },
  };
}
