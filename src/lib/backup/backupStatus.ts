/**
 * What a person reads about each place their Drive is backed up to: one line
 * that says where it stands, and one about the last check. Kept apart from
 * the page so the words can be tested.
 */

/** What this device remembers about one backup place. */
export interface BackupRecord {
  /** `${account}|${target}`, so two accounts on one device keep apart. */
  key: string;
  /** `server:<url>` or `folder:<id>`. */
  target: string;
  /** A folder's name, as the person picked it. */
  name?: string;
  /** A folder on this computer; kept so it can be backed up to again. */
  handle?: FileSystemDirectoryHandle;
  /** The last backup that finished. `root` is the Drive version it holds. */
  backedUp?: { root: string; at: number; total: number; sent: number; bytesSent: number };
  /** The last check: parts read back and compared with what they should be. */
  checked?: { root: string; at: number; sampled: number; verified: number; missing: number; unknown: number };
  /** A backup that was going when the page closed; it continues on the next start. */
  running?: { at: number };
  /** The last thing that went wrong, until something works again. */
  problem?: { at: number; reason: string };
}

/** A backup or check going on now, in this tab. */
export interface LiveJob {
  job: 'backup' | 'check';
  done: number;
  total: number;
}

export type BackupTone = 'ok' | 'busy' | 'idle' | 'problem';

export interface BackupStatus {
  tone: BackupTone;
  label: string;
  detail: string;
}

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago". */
export function timeAgo(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

function checkLine(record: BackupRecord | undefined, now: number): string {
  const checked = record?.checked;
  if (!checked) return 'Not checked yet';
  const when = `Checked ${timeAgo(checked.at, now)}`;
  if (checked.missing > 0) return `${when}: ${checked.missing} of ${checked.sampled} parts missing`;
  if (checked.verified === 0) return `${when}: could not read it`;
  return `${when}: ${checked.verified} of ${checked.sampled} parts read back`;
}

/**
 * Where one place stands for the Drive version `root` (hex), in plain words.
 * `live` is a job going on in this tab now.
 */
export function backupStatus(
  record: BackupRecord | undefined,
  root: string | null,
  live: LiveJob | undefined,
  now: number,
): BackupStatus {
  const detail = checkLine(record, now);
  if (live?.job === 'backup') {
    const label = live.total > 0 ? `Backing up ${live.done} of ${live.total}` : 'Backing up…';
    return { tone: 'busy', label, detail };
  }
  if (live?.job === 'check') return { tone: 'busy', label: 'Checking…', detail };
  if (!record) return { tone: 'idle', label: 'Not checked yet', detail: '' };
  if (record.running) return { tone: 'idle', label: 'Paused', detail };

  const lastGood = Math.max(record.backedUp?.at ?? 0, record.checked?.at ?? 0);
  if (record.problem && record.problem.at >= lastGood) {
    return { tone: 'problem', label: `Problem: ${record.problem.reason}`, detail };
  }
  const checked = record.checked;
  if (checked && checked.at >= (record.backedUp?.at ?? 0)) {
    if (checked.missing > 0) {
      return { tone: 'problem', label: `Problem: ${checked.missing} of ${checked.sampled} checked parts are missing`, detail };
    }
    if (checked.sampled > 0 && checked.verified === 0) {
      return { tone: 'problem', label: 'Problem: could not read the backup', detail };
    }
  }
  if (record.backedUp && record.backedUp.root === root) return { tone: 'ok', label: 'Up to date', detail };
  if (record.backedUp) return { tone: 'idle', label: `Last backed up ${timeAgo(record.backedUp.at, now)}`, detail };
  return { tone: 'idle', label: 'Not backed up yet', detail };
}

/** A file server address as typed, made comparable; null when it is not one. */
export function normalizeServerUrl(input: string): string | null {
  const trimmed = input.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    if (url.search || url.hash || url.username || url.password) return null;
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/** A short name for a file server: its host. */
export function serverName(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** File servers that keep the Drive: the ones it saves to, each once, the app's own one left out. */
export function backupServers(servers: Array<{ url: string; write: boolean }>, ownServer: string | null): string[] {
  const own = ownServer ? normalizeServerUrl(ownServer) : null;
  const urls = servers
    .filter((server) => server.write)
    .map((server) => normalizeServerUrl(server.url))
    .filter((url): url is string => !!url && url !== own);
  return [...new Set(urls)];
}

