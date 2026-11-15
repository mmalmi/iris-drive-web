/**
 * What the Storage page says about each device's report, in words.
 */
import type { DeviceStorageReport } from '../drive/deviceStorageReport';

type Format = (bytes: number) => string;

export interface DeviceRow {
  pubkey: string;
  name: string;
  current: boolean;
  report: DeviceStorageReport | null;
}

export interface FolderLine {
  label: string;
  depth: number;
  bytes: number;
  held: number;
}

/** Whether the device holds every file of the Drive it measured. */
export function holdsAll(report: DeviceStorageReport): boolean {
  return report.held_files >= report.files && report.held_bytes >= report.file_bytes;
}

/** How much a device holds, short: "All of it", "1.2 GB · 35%". */
export function holdingLabel(report: DeviceStorageReport, format: Format): string {
  if (report.files === 0) return 'Nothing to hold yet';
  if (holdsAll(report)) return 'All of it';
  if (report.held_bytes === 0) return 'None of it';
  const share = Math.floor((report.held_bytes / Math.max(1, report.file_bytes)) * 100);
  return `${format(report.held_bytes)} · ${share < 1 ? 'under 1' : share}%`;
}

/** The room a device uses: "Uses 2.3 GB of 5.0 GB allowed". */
export function spaceLabel(report: DeviceStorageReport, format: Format): string {
  return report.capacity_bytes
    ? `Uses ${format(report.stored_bytes)} of ${format(report.capacity_bytes)} allowed`
    : `Uses ${format(report.stored_bytes)}`;
}

export function ageLabel(measuredAt: number, now = Date.now()): string {
  const minutes = Math.floor((now / 1000 - measuredAt) / 60);
  if (minutes < 2) return 'Updated just now';
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Updated ${hours} h ago`;
  return `Updated ${Math.floor(hours / 24)} days ago`;
}

/** The size of the Drive: as this device measured it, or else the newest report's. */
export function driveSize(rows: DeviceRow[]): DeviceStorageReport | null {
  const own = rows.find((row) => row.current)?.report;
  if (own) return own;
  return rows
    .map((row) => row.report)
    .filter((report): report is DeviceStorageReport => !!report)
    .sort((a, b) => b.measured_at - a.measured_at)[0] ?? null;
}

/** Which devices hold all of the Drive, in a sentence. */
export function holdersSentence(rows: DeviceRow[]): string {
  const holders = rows.filter((row) => row.report && row.report.files > 0 && holdsAll(row.report));
  if (holders.length === 0) return 'No device holds all of it.';
  if (holders.length === 1) return holders[0].current ? 'All of it is on this device.' : `All of it is on ${holders[0].name}.`;
  return `All of it is on ${holders.length} devices.`;
}

/**
 * The folders of a report as lines to show, each under its parent, then the
 * files in no folder and, as one line, the folders too small to list.
 */
export function folderLines(report: DeviceStorageReport): FolderLine[] {
  const folders = report.folders ?? [];
  const lines: FolderLine[] = folders.map((folder) => ({
    label: folder.path.at(-1) || 'Folder',
    depth: folder.path.length - 1,
    bytes: folder.bytes,
    held: folder.held,
  }));
  const top = folders.filter((folder) => folder.path.length === 1);
  const loose = report.loose ?? { files: 0, bytes: 0, held: 0 };
  if (loose.files > 0) {
    lines.push({
      label: loose.files === 1 ? '1 file not in a folder' : `${loose.files.toLocaleString('en-US')} files not in a folder`,
      depth: 0,
      bytes: loose.bytes,
      held: loose.held,
    });
  }
  const restBytes = report.file_bytes - loose.bytes - top.reduce((sum, folder) => sum + folder.bytes, 0);
  const restHeld = report.held_bytes - loose.held - top.reduce((sum, folder) => sum + folder.held, 0);
  if (restBytes > 0 && report.loose) {
    lines.push({ label: folders.length ? 'Other folders' : 'Folders', depth: 0, bytes: restBytes, held: Math.max(0, Math.min(restHeld, restBytes)) });
  }
  return lines;
}

export type SyncState = 'in-sync' | 'behind' | 'ahead' | 'apart';

export const SYNC_LABEL: Record<SyncState, string> = {
  'in-sync': 'In sync',
  behind: 'Missing recent changes',
  ahead: 'Has changes not here yet',
  apart: 'Not in sync',
};

/** What each one means, for a pointer resting on it. */
export const SYNC_DETAIL: Record<SyncState, string> = {
  'in-sync': 'Has the same version of your Drive as this device',
  behind: 'Has not taken in all the changes this device has yet',
  ahead: 'Has changes from another device that have not reached this one yet',
  apart: 'Each has changes the other has not taken in yet',
};

/**
 * Whether `device` had taken in the same version of every other device's
 * Drive as this one holds, as it last reported; null when it has not said.
 * Its own newest version is the one this device holds of it.
 */
export function syncState(
  device: string,
  report: DeviceStorageReport | null,
  held: Record<string, { seq: number }>,
  devices: string[],
): SyncState | null {
  if (!report?.seen) return null;
  let behind = false;
  let ahead = false;
  for (const other of devices) {
    if (other === device) continue;
    const theirs = report.seen[other] ?? 0;
    const ours = held[other]?.seq ?? 0;
    if (theirs < ours) behind = true;
    if (theirs > ours) ahead = true;
  }
  if (behind && ahead) return 'apart';
  return behind ? 'behind' : ahead ? 'ahead' : 'in-sync';
}

/** The kind of app, as an icon. */
export function appIcon(app: string): string {
  if (app === 'web') return 'i-lucide-globe';
  if (app === 'ios' || app === 'android') return 'i-lucide-smartphone';
  if (app === 'macos' || app === 'windows' || app === 'linux') return 'i-lucide-laptop';
  return 'i-lucide-hard-drive';
}
