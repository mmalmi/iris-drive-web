/**
 * How much of the Drive each of the account's devices holds, how much room
 * it has, and which versions of the Drive it has taken in.
 *
 * This device measures what it holds a while after the Drive changes, when
 * the Storage page opens and every few hours, and tells the account's other
 * devices in a report (`src/drive/deviceStorageReport.ts`) when the numbers
 * moved. Which versions it has taken in is sent within seconds of taking one
 * in, with the last numbers: nothing else tells another device that this one
 * has its changes, as a device that only reads publishes no new versions. Their reports come through the Nostr runtime, which keeps them on
 * this device, so the page shows the last ones at once; nothing waits for a
 * relay.
 */
import { get, writable } from 'svelte/store';
import { toHex } from '@hashtree/core';
import type { Event } from 'nostr-tools';
import { getCurrentNostrIdentitySession, getSecretKey, nostr, nostrStore } from '../nostr';
import { projectNostrIdentityRoster } from '../drive/protocol';
import { profileDriveProjection } from '../drive/profileDriveProjection';
import { DRIVE_ROOT_NAME } from '../drive/setup';
import {
  buildDeviceStorageEvent,
  deviceStorageFilter,
  openDeviceStorageEvent,
  type DeviceStorageReport,
} from '../drive/deviceStorageReport';
import { treeRootRegistry } from '../TreeRootRegistry';
import { getTreeRootSync } from '../stores/treeRoot';
import { subscribeToTreeRoot } from '../stores/treeRootResolver';
import { settingsStore } from '../stores/settings';
import { waitForWorkerAdapter } from './workerInit';
import { publishEvent } from './nostrPublish';

export interface DeviceStorageState {
  /** The signed-in account; null when signed out. */
  profile: string | null;
  /** This device's key. */
  device: string | null;
  /** The newest report of each device, by its key, this device's own included. */
  reports: Record<string, DeviceStorageReport>;
  /** When each device last sent its report, unix seconds. */
  heard: Record<string, number>;
  /** The newest version of each device's Drive this one holds. */
  versions: Record<string, { seq: number; publishedAt: number }>;
  measuring: boolean;
}

const blank = (profile: string | null = null, device: string | null = null): DeviceStorageState => (
  { profile, device, reports: {}, heard: {}, versions: {}, measuring: false }
);

export const deviceStorage = writable<DeviceStorageState>(blank());

/** After the Drive changes, it is measured once this long has passed… */
const AFTER_CHANGE_MS = 60_000;
/** …and the versions taken in are sent after this long, so at most this often while another device keeps editing. */
const SEEN_AFTER_MS = 15_000;
const AT_START_MS = 5_000;
/** Every so often everything is counted again, for content fetched or removed since. */
const RECOUNT_EVERY_MS = 6 * 60 * 60 * 1000;
/** Opening the Storage page counts again what was counted longer ago than this. */
const ON_OPEN_MAX_AGE_MS = 10 * 60 * 1000;
/** A report is sent again after this long even when nothing moved. */
const RESEND_AFTER_MS = 24 * 60 * 60 * 1000;
const ADAPTER_WAIT_MS = 30_000;
const SENT_KEY = 'iris-drive.device-storage.sent';

interface Account {
  profile: string;
  pubkey: string;
  secretKey: Uint8Array;
  /** The account's devices, this one included. */
  devices: string[];
}

interface Sent {
  at: number;
  /** The \`created_at\` it was sent with. */
  createdAt?: number;
  recipients: string[];
  report: DeviceStorageReport;
}

function account(): Account | null {
  const session = getCurrentNostrIdentitySession();
  const secretKey = getSecretKey();
  const { pubkey } = nostrStore.getState();
  if (!session || session.status !== 'active' || !secretKey || pubkey !== session.appKeyPubkey) return null;
  const roster = projectNostrIdentityRoster(session.profileId, session.rosterOps ?? []);
  const devices = Object.values(roster.active_facets)
    .filter((facet) => facet.purposes?.includes('app_key'))
    .map((facet) => facet.pubkey);
  return { profile: session.profileId, pubkey, secretKey, devices: [...new Set([...devices, pubkey])].sort() };
}

const accountKey = (me: Account | null) => (me ? `${me.profile}|${me.pubkey}` : '');

function readSent(profile: string): Sent | null {
  try {
    return (JSON.parse(localStorage.getItem(SENT_KEY) ?? '{}') as Record<string, Sent>)[profile] ?? null;
  } catch {
    return null;
  }
}

function writeSent(profile: string, sent: Sent): void {
  try {
    const all = JSON.parse(localStorage.getItem(SENT_KEY) ?? '{}') as Record<string, Sent>;
    all[profile] = sent;
    localStorage.setItem(SENT_KEY, JSON.stringify(all));
  } catch {
    // It is sent again next time.
  }
}

/** Whether `next` tells the other devices something `last` did not. */
export function reportMoved(last: DeviceStorageReport, next: DeviceStorageReport): boolean {
  const moved = (a = 0, b = 0) => Math.abs(a - b) > Math.max(1024 * 1024, 0.01 * Math.max(a, b));
  const folders = (report: DeviceStorageReport) => (report.folders ?? []).map((folder) => folder.path.join('\0')).join('\n');
  if (last.files !== next.files || last.held_files !== next.held_files || folders(last) !== folders(next)) return true;
  if (moved(last.file_bytes, next.file_bytes) || moved(last.held_bytes, next.held_bytes)) return true;
  if (moved(last.stored_bytes, next.stored_bytes) || moved(last.capacity_bytes, next.capacity_bytes)) return true;
  const seen = (report: DeviceStorageReport) => JSON.stringify(Object.entries(report.seen ?? {}).sort());
  if (seen(last) !== seen(next)) return true;
  return (next.folders ?? []).some((folder, index) => moved(folder.held, last.folders?.[index]?.held));
}

/** The most this browser may keep: the limit set under Storage, or less when the browser allows less. */
async function capacity(stored: number): Promise<number> {
  const limit = get(settingsStore).storage.maxBytes;
  try {
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota) return Math.min(limit, stored + Math.max(0, estimate.quota - (estimate.usage ?? 0)));
  } catch {
    // The limit alone.
  }
  return limit;
}

let started = false;
let current = '';
let subscription: { stop: () => void } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let timerAt = 0;
let pendingMaxAge = Infinity;
let seenTimer: ReturnType<typeof setTimeout> | null = null;
/** A measurement asked for before the Drive was known, with its `maxAgeMs`. */
let awaitingRoot: number | null = null;
let active = 0;
const newest = new Map<string, number>();

/** Measure in `delayMs`, or sooner when asked sooner; `maxAgeMs` as for `measureDriveHolding`. */
function measureSoon(delayMs: number, maxAgeMs = Infinity): void {
  if (!current) return;
  pendingMaxAge = Math.min(pendingMaxAge, maxAgeMs);
  const at = Date.now() + delayMs;
  if (timer && timerAt <= at) return;
  if (timer) clearTimeout(timer);
  timerAt = at;
  timer = setTimeout(() => {
    timer = null;
    const maxAge = pendingMaxAge;
    pendingMaxAge = Infinity;
    void measure(maxAge);
  }, delayMs);
}

async function measure(maxAgeMs: number): Promise<void> {
  const me = account();
  if (!me || accountKey(me) !== current) return;
  const root = getTreeRootSync(me.profile, DRIVE_ROOT_NAME);
  if (!root?.key) {
    // The Drive is not known yet, as just after opening: measured once it is.
    awaitingRoot = Math.min(awaitingRoot ?? Infinity, maxAgeMs);
    return;
  }
  awaitingRoot = null;
  const adapter = await waitForWorkerAdapter(ADAPTER_WAIT_MS);
  if (!adapter?.measureDriveHolding) return;
  active += 1;
  deviceStorage.update((state) => ({ ...state, measuring: true }));
  try {
    const holding = await adapter.measureDriveHolding({ hash: root.hash, key: root.key }, Number.isFinite(maxAgeMs) ? maxAgeMs : undefined);
    const stored = (await adapter.getStorageStats().catch(() => ({ bytes: 0 }))).bytes;
    const report: DeviceStorageReport = {
      v: 1,
      measured_at: Math.floor(Date.now() / 1000),
      app: 'web',
      root: toHex(root.hash),
      files: holding.files,
      file_bytes: holding.bytes,
      held_files: holding.heldFiles,
      held_bytes: holding.heldBytes,
      stored_bytes: stored,
      capacity_bytes: await capacity(stored),
      ...(holding.unreadFolders ? { unread_folders: holding.unreadFolders } : {}),
      seen: seenBy(me),
      loose: { files: holding.loose.files, bytes: holding.loose.bytes, held: holding.loose.heldBytes },
      folders: holding.folders,
    };
    if (accountKey(account()) !== current) return;
    deviceStorage.update((state) => ({ ...state, reports: { ...state.reports, [me.pubkey]: report } }));
    await send(me, report, false);
  } catch (error) {
    if (!(error instanceof Error && error.message === 'stopped')) console.warn('[deviceStorage] Could not measure', error);
  } finally {
    active -= 1;
    // A newer measurement replaces one still going, which ends here first.
    deviceStorage.update((state) => ({ ...state, measuring: active > 0 }));
  }
}

/** Sends one at a time, so each knows what the last one sent. */
let sending: Promise<void> = Promise.resolve();

function send(me: Account, report: DeviceStorageReport, always: boolean): Promise<void> {
  const next = sending.then(() => sendNow(me, report, always));
  sending = next.catch(() => undefined);
  return next;
}

async function sendNow(me: Account, report: DeviceStorageReport, always: boolean): Promise<void> {
  const sent = readSent(me.profile);
  const due = always || !sent
    || sent.recipients.join() !== me.devices.join()
    || Date.now() - sent.at > RESEND_AFTER_MS
    || reportMoved(sent.report, report);
  if (!due) return;
  // Relays keep one report per device and break a tie in the same second by
  // id, not by which is newer, so each one is sent a second after the last.
  const createdAt = Math.max(Math.floor(Date.now() / 1000), (sent?.createdAt ?? 0) + 1, (newest.get(me.pubkey) ?? 0) + 1);
  const event = await buildDeviceStorageEvent(me.secretKey, me.profile, report, me.devices, createdAt);
  // Resolves once the runtime holds it to send; no relay is waited for.
  await publishEvent(event);
  if (import.meta.env.VITE_TEST_MODE) console.log(`[deviceStorage] sent ${report.held_bytes}/${report.file_bytes} to ${me.devices.length} at ${event.created_at}`);
  writeSent(me.profile, { at: Date.now(), createdAt: event.created_at, recipients: me.devices, report });
  deviceStorage.update((state) => ({ ...state, heard: { ...state.heard, [me.pubkey]: event.created_at } }));
}

async function receive(event: Event): Promise<void> {
  const me = account();
  if (!me || accountKey(me) !== current) return;
  if ((newest.get(event.pubkey) ?? -1) >= event.created_at) return;
  const report = await openDeviceStorageEvent(event, me.profile, me.secretKey);
  if (import.meta.env.VITE_TEST_MODE) console.log(`[deviceStorage] got ${report ? `${report.held_bytes}/${report.file_bytes}` : 'unreadable'} from ${event.pubkey.slice(0, 8)} at ${event.created_at}`);
  if (!report || accountKey(account()) !== current || (newest.get(event.pubkey) ?? -1) >= event.created_at) return;
  newest.set(event.pubkey, event.created_at);
  deviceStorage.update((state) => {
    // This device's own measurement is newer than what it last sent.
    if (event.pubkey === me.pubkey && state.reports[me.pubkey]) return state;
    return {
      ...state,
      reports: { ...state.reports, [event.pubkey]: report },
      heard: { ...state.heard, [event.pubkey]: event.created_at },
    };
  });
  // A device this one has not told yet, as one linked since: tell it.
  const sent = readSent(me.profile);
  if (event.pubkey !== me.pubkey && me.devices.includes(event.pubkey) && sent && !sent.recipients.includes(event.pubkey)) {
    await send(me, get(deviceStorage).reports[me.pubkey] ?? sent.report, true).catch((error) => {
      console.warn('[deviceStorage] Could not send the report again', error);
    });
  }
}

function follow(): void {
  const me = account();
  const key = accountKey(me);
  if (key === current) return;
  current = key;
  subscription?.stop();
  subscription = null;
  if (timer) clearTimeout(timer);
  timer = null;
  if (seenTimer) clearTimeout(seenTimer);
  seenTimer = null;
  awaitingRoot = null;
  newest.clear();
  deviceStorage.set(blank(me?.profile ?? null, me?.pubkey ?? null));
  if (!me) return;
  const sub = nostr.subscribe(deviceStorageFilter(me.profile), { closeAfterHistory: false });
  sub.on('event', (event: Event) => { void receive(event); });
  subscription = sub;
  measureSoon(AT_START_MS);
}

/**
 * The newest version of each other device's Drive this one has taken in, by
 * the device's key. Its own versions the others learn from its roots.
 */
function seenBy(me: Account): Record<string, number> {
  const versions = profileDriveProjection.heldVersions(me.profile, DRIVE_ROOT_NAME, new Set(me.devices));
  return Object.fromEntries(Object.entries(versions)
    .filter(([device]) => device !== me.pubkey)
    .map(([device, version]) => [device, version.seq]));
}

function driveChanged(): void {
  const me = account();
  if (!me || accountKey(me) !== current) return;
  const versions = profileDriveProjection.heldVersions(me.profile, DRIVE_ROOT_NAME, new Set(me.devices));
  deviceStorage.update((state) => ({ ...state, versions }));
  if (awaitingRoot !== null && getTreeRootSync(me.profile, DRIVE_ROOT_NAME)?.key) measureSoon(0, awaitingRoot);
  else measureSoon(AFTER_CHANGE_MS);
  if (seenTimer) return;
  seenTimer = setTimeout(() => {
    seenTimer = null;
    const latest = account();
    const last = get(deviceStorage).reports[latest?.pubkey ?? ''];
    // Before the first measurement there are no numbers to send them with; it sends them.
    if (!latest || accountKey(latest) !== current || !last) return;
    const report = { ...last, seen: seenBy(latest) };
    deviceStorage.update((state) => ({ ...state, reports: { ...state.reports, [latest.pubkey]: report } }));
    void send(latest, report, false).catch((error) => console.warn('[deviceStorage] Could not send the versions taken in', error));
  }, SEEN_AFTER_MS);
}

/** Follows the signed-in account's devices. Safe to call more than once. */
export function startDeviceStorage(): void {
  if (started) return;
  started = true;
  nostrStore.subscribe(() => follow());
  let watched = '';
  let unwatch = () => {};
  deviceStorage.subscribe(({ profile }) => {
    if ((profile ?? '') === watched) return;
    watched = profile ?? '';
    unwatch();
    unwatch = () => {};
    if (!profile) return;
    // Keeps the Drive's newest version known whatever page is open, as on opening Storage directly.
    const stopResolving = subscribeToTreeRoot(profile, DRIVE_ROOT_NAME, () => {});
    const stopWatching = treeRootRegistry.subscribe(profile, DRIVE_ROOT_NAME, driveChanged);
    unwatch = () => {
      stopResolving();
      stopWatching();
    };
    driveChanged();
  });
  setInterval(() => measureSoon(0, 0), RECOUNT_EVERY_MS);
}

/** For the Storage page: this device's numbers, brought up to date. */
export function measureDeviceStorageNow(): void {
  startDeviceStorage();
  measureSoon(0, ON_OPEN_MAX_AGE_MS);
}
