/**
 * Where the Drive is kept besides this device, and how each place stands.
 *
 * The file servers the Drive saves to are its backup places, along with any
 * folder that the browser can write to. What happened with each place is
 * remembered on this device.
 *
 * A backup runs in the storage worker and goes on while the page is left; one
 * that was going when the app closed starts again on the next start. A file
 * server backed up once is kept up to date: a while after the Drive changes it
 * is backed up again, which sends only the new parts. A folder is updated when
 * asked to.
 */
import { get, writable } from 'svelte/store';
import { toHex, type CID } from '@hashtree/core';
import { keyValueStore } from '../keyValueStore';
import { settingsStore, DEFAULT_NETWORK_SETTINGS, type BlossomServerConfig } from '../../stores/settings';
import { getWorkerAdapter, type BackendAdapter } from '../../workerAdapter';
import { waitForWorkerAdapter } from '../workerInit';
import { nostrStore } from '../../nostr';
import type { NostrState } from '../../nostr/store';
import { activeNostrIdentityRootScope } from '../../drive/profileRoute';
import { treeRootRegistry } from '../../TreeRootRegistry';
import { getTreeRootSync } from '../../stores/treeRoot';
import { DRIVE_ROOT_NAME } from '../../drive/setup';
import { getEmbeddedDaemonBlossomServer } from '../runtimeNetwork';
import { getRuntimeHtreeServerUrl } from '../htreeRuntime';
import { backupServers, normalizeServerUrl, serverName, type BackupRecord, type LiveJob } from './backupStatus';
import type { BackupPlaceSpec } from '../../workers/driveBackup';

export interface BackupPlace {
  id: string;
  kind: 'server' | 'folder';
  name: string;
  url?: string;
}

export interface BackupsState {
  /** Whose Drive; null before signing in. */
  account: string | null;
  /** The Drive version now (hex); null until known. */
  root: string | null;
  records: Record<string, BackupRecord>;
  live: Record<string, LiveJob>;
}

/** A file server is backed up again this long after the Drive last changed. */
const KEEP_UP_AFTER_MS = 20_000;
/** How long a backup waits for Drive's storage to start. */
const ADAPTER_WAIT_MS = 30_000;
const SERVER = 'server:';
const FOLDER = 'folder:';

const db = keyValueStore<BackupRecord>('iris-drive-backups', 'places');
export const backups = writable<BackupsState>({ account: null, root: null, records: {}, live: {} });

let started = false;
let root: CID | null = null;
let keepUpTimer: ReturnType<typeof setTimeout> | null = null;
let rootChangedAt = 0;
const resumed = new Set<string>();
let watchedAdapter: BackendAdapter | null = null;

/** The places the Drive is backed up to: file servers it saves to, then folders. */
export function backupPlaces(servers: BlossomServerConfig[], records: Record<string, BackupRecord>): BackupPlace[] {
  const own = getEmbeddedDaemonBlossomServer()?.url ?? null;
  return [
    ...backupServers(servers, own).map((url): BackupPlace => ({ id: `${SERVER}${url}`, kind: 'server', name: serverName(url), url })),
    ...Object.values(records)
      .filter((record) => record.target.startsWith(FOLDER) && record.handle)
      .map((record): BackupPlace => ({ id: record.target, kind: 'folder', name: record.name || 'Folder' })),
  ];
}

/** Whether backups run here; in the desktop app they are set up in its own Backups tab. */
export function backupsRunHere(): boolean {
  return !getRuntimeHtreeServerUrl();
}

/** Whether this browser can back up to a folder on this computer. */
export function canBackUpToFolder(): boolean {
  return backupsRunHere() && typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

function currentPlaces(): BackupPlace[] {
  return backupPlaces(get(settingsStore).network.blossomServers, get(backups).records);
}

function setLive(id: string, job: LiveJob | null): void {
  backups.update((state) => {
    const live = { ...state.live };
    if (job) live[id] = job;
    else delete live[id];
    return { ...state, live };
  });
}

async function save(record: BackupRecord): Promise<void> {
  const [account] = record.key.split('|', 1);
  if (get(backups).account !== account) return;
  backups.update((state) => ({ ...state, records: { ...state.records, [record.target]: record } }));
  try {
    await db.put(record);
  } catch (error) {
    console.warn('[backup] Could not remember a backup', error);
  }
}

function recordFor(id: string): BackupRecord {
  const { account, records } = get(backups);
  return records[id] ?? { key: `${account}|${id}`, target: id };
}

function watchProgress(adapter: BackendAdapter): void {
  if (watchedAdapter === adapter || !adapter.onDriveBackupProgress) return;
  watchedAdapter = adapter;
  adapter.onDriveBackupProgress((id, done, total) => {
    const live = get(backups).live[id];
    if (live?.job === 'backup') setLive(id, { ...live, done, total });
  });
}

async function folderAccess(handle: FileSystemDirectoryHandle, ask: boolean): Promise<boolean> {
  const permissions = handle as unknown as {
    queryPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>;
    requestPermission?: (options: { mode: 'readwrite' }) => Promise<PermissionState>;
  };
  const options = { mode: 'readwrite' as const };
  if ((await permissions.queryPermission?.(options)) === 'granted') return true;
  return ask && (await permissions.requestPermission?.(options)) === 'granted';
}

function plainReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timeout|timed out/i.test(message)) return 'the place took too long to answer';
  return message.replace(/^[A-Z]/, (letter) => letter.toLowerCase()).slice(0, 120);
}

/**
 * Backs up the Drive to one place, or checks it. `ask` is true for a click,
 * when the browser may ask for access to a folder.
 */
async function runJob(id: string, job: 'backup' | 'check', options: { fresh?: boolean; ask?: boolean } = {}): Promise<void> {
  const { account, live } = get(backups);
  const place = currentPlaces().find((candidate) => candidate.id === id);
  if (!account || !place || live[id]) return;
  setLive(id, { job, done: 0, total: 0 });
  try {
    await work(place, job, options);
  } finally {
    setLive(id, null);
    if (job === 'backup') keepUp();
  }
}

async function work(place: BackupPlace, job: 'backup' | 'check', options: { fresh?: boolean; ask?: boolean }): Promise<void> {
  const id = place.id;
  const record = recordFor(id);
  const fail = (reason: string) => save({ ...recordFor(id), running: undefined, problem: { at: Date.now(), reason } });
  const adapter = await waitForWorkerAdapter(ADAPTER_WAIT_MS);
  if (!adapter?.runDriveBackup) return fail('Drive is still starting');
  const drive = root;
  if (!drive?.key) return fail('your Drive is not ready yet');

  let spec: BackupPlaceSpec;
  if (place.kind === 'server') {
    spec = { kind: 'server', url: place.url! };
  } else {
    if (!record.handle || !(await folderAccess(record.handle, options.ask === true))) {
      if (options.ask) await fail('no access to the folder');
      return;
    }
    spec = { kind: 'folder', handle: record.handle };
  }

  watchProgress(adapter);
  if (job === 'backup') await save({ ...record, running: { at: Date.now() } });
  try {
    const result = await adapter.runDriveBackup({
      target: id,
      job,
      place: spec,
      root: { hash: drive.hash, key: drive.key },
      fresh: options.fresh,
    });
    if (result.error === 'stopped') return;
    if (result.error) throw new Error(result.error);
    const at = Date.now();
    const version = toHex(drive.hash);
    const latest = recordFor(id);
    if (result.backup) {
      const { total, sent, bytesSent } = result.backup;
      await save({ ...latest, running: undefined, problem: undefined, backedUp: { root: version, at, total, sent, bytesSent } });
    } else if (result.check) {
      const { sampled, verified, missing, unknown } = result.check;
      await save({ ...latest, problem: undefined, checked: { root: version, at, sampled, verified, missing, unknown } });
    }
  } catch (error) {
    if (currentPlaces().some((candidate) => candidate.id === id)) await fail(plainReason(error));
  }
}

/** Backs up now, asking the place about every part. */
export function backUpNow(id: string): Promise<void> {
  return runJob(id, 'backup', { fresh: true, ask: true });
}

/** Reads a sample of the backup back and compares it with the Drive. */
export function checkNow(id: string): Promise<void> {
  return runJob(id, 'check', { ask: true });
}

/** Adds a file server, optionally as a backup. Returns what is wrong with the address, or null. */
export function addServer(input: string, saveBackup = true): string | null {
  const url = normalizeServerUrl(input);
  if (!url) return 'Enter an address that starts with https://';
  const servers = get(settingsStore).network.blossomServers;
  const known = servers.some((server) => normalizeServerUrl(server.url) === url);
  settingsStore.setNetworkSettings({
    blossomServers: known
      ? servers.map((server) => (normalizeServerUrl(server.url) === url ? { ...server, read: true, write: saveBackup || server.write } : server))
      : [...servers, { url, read: true, write: saveBackup }],
  });
  if (saveBackup && backupsRunHere()) void backUpNow(`${SERVER}${url}`);
  return null;
}

/** Picks a folder on this computer and backs up to it. */
export async function addFolder(): Promise<void> {
  const pick = (window as unknown as {
    showDirectoryPicker?: (options: { id: string; mode: 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }).showDirectoryPicker;
  if (!pick || !get(backups).account) return;
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await pick({ id: 'iris-drive-backup', mode: 'readwrite' });
  } catch {
    return;
  }
  for (const record of Object.values(get(backups).records)) {
    if (record.handle && await record.handle.isSameEntry(handle).catch(() => false)) {
      await backUpNow(record.target);
      return;
    }
  }
  const id = `${FOLDER}${crypto.randomUUID()}`;
  await save({ ...recordFor(id), name: handle.name, handle });
  await backUpNow(id);
}

/**
 * Stops backing up to a place. Keep default servers for reading unless the
 * person removes them from their file server settings.
 */
export async function removePlace(id: string, { removeServer = false } = {}): Promise<void> {
  getWorkerAdapter()?.stopDriveBackup?.(id);
  if (id.startsWith(SERVER)) {
    const url = id.slice(SERVER.length);
    const keepServer = !removeServer && DEFAULT_NETWORK_SETTINGS.blossomServers.some((server) => normalizeServerUrl(server.url) === url);
    const servers = get(settingsStore).network.blossomServers;
    settingsStore.setNetworkSettings({
      blossomServers: keepServer
        ? servers.map((server) => (normalizeServerUrl(server.url) === url ? { ...server, write: false } : server))
        : servers.filter((server) => normalizeServerUrl(server.url) !== url),
    });
  }
  const record = get(backups).records[id];
  backups.update((state) => {
    const records = { ...state.records };
    delete records[id];
    return { ...state, records };
  });
  if (record) await db.delete(record.key).catch(() => undefined);
}

/** Continues, once, each backup that was going when the app closed. */
function resume(): void {
  const { root: version, records, live } = get(backups);
  if (!version) return;
  for (const place of currentPlaces()) {
    if (!records[place.id]?.running || live[place.id] || resumed.has(place.id)) continue;
    resumed.add(place.id);
    void runJob(place.id, 'backup');
  }
}

/**
 * A while after the Drive changes, backs it up again to each file server
 * backed up before. A place that failed since is left until the next change.
 */
function keepUp(): void {
  if (keepUpTimer) clearTimeout(keepUpTimer);
  keepUpTimer = setTimeout(() => {
    keepUpTimer = null;
    const { root: version, records, live } = get(backups);
    for (const place of currentPlaces()) {
      const record = records[place.id];
      if (place.kind !== 'server' || !record || live[place.id] || record.running) continue;
      if (!record.backedUp && !record.problem) continue;
      if (record.backedUp?.root === version || (record.problem && record.problem.at > rootChangedAt)) continue;
      void runJob(place.id, 'backup');
    }
  }, KEEP_UP_AFTER_MS);
}

function rootChanged(account: string): void {
  const current = getTreeRootSync(account, DRIVE_ROOT_NAME);
  const state = get(backups);
  if (state.account !== account || !current?.key) return;
  const version = toHex(current.hash);
  root = current;
  if (version === state.root) return;
  rootChangedAt = Date.now();
  backups.update((latest) => ({ ...latest, root: version }));
  resume();
  keepUp();
}

async function loadRecords(account: string): Promise<void> {
  let rows: BackupRecord[] = [];
  try {
    rows = await db.all();
  } catch (error) {
    console.warn('[backup] Could not read what was backed up', error);
  }
  if (get(backups).account !== account) return;
  const records = Object.fromEntries(rows.filter((row) => row.key.startsWith(`${account}|`)).map((row) => [row.target, row]));
  backups.update((state) => ({ ...state, records: { ...records, ...state.records } }));
  resume();
  keepUp();
}

/** Follows the signed-in account's Drive. Safe to call more than once. */
export function startBackups(): void {
  if (started) return;
  started = true;
  let unwatchRoot = () => {};
  nostrStore.subscribe((state: NostrState) => {
    const account = state.isLoggedIn ? activeNostrIdentityRootScope(state) ?? state.npub : null;
    if (account === get(backups).account) return;
    unwatchRoot();
    root = null;
    backups.set({ account, root: null, records: {}, live: {} });
    if (!account) return;
    void loadRecords(account);
    unwatchRoot = treeRootRegistry.subscribe(account, DRIVE_ROOT_NAME, () => rootChanged(account));
    rootChanged(account);
  });
}
