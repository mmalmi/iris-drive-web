import { describe, expect, it } from 'vitest';
import {
  backupServers,
  backupStatus,
  normalizeServerUrl,
  serverName,
  timeAgo,
  type BackupRecord,
} from '../src/lib/backup/backupStatus';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const ROOT = 'a'.repeat(64);
const OLDER = 'b'.repeat(64);

function record(fields: Partial<BackupRecord> = {}): BackupRecord {
  return { key: `me|server:https://files.example`, target: 'server:https://files.example', ...fields };
}

const backedUp = (root: string, at = NOW - 5 * MINUTE) => ({ root, at, total: 10, sent: 2, bytesSent: 2048 });
const checked = (fields: Partial<NonNullable<BackupRecord['checked']>> = {}) => ({
  root: ROOT, at: NOW - MINUTE, sampled: 8, verified: 8, missing: 0, unknown: 0, ...fields,
});

describe('how a backup place stands', () => {
  it('is up to date when it holds the Drive as it is now', () => {
    expect(backupStatus(record({ backedUp: backedUp(ROOT) }), ROOT, undefined, NOW)).toEqual({
      tone: 'ok',
      label: 'Up to date',
      detail: 'Not checked yet',
    });
  });

  it('says when it was last backed up once the Drive has changed since', () => {
    const status = backupStatus(record({ backedUp: backedUp(OLDER, NOW - 3 * 60 * MINUTE) }), ROOT, undefined, NOW);
    expect(status).toMatchObject({ tone: 'idle', label: 'Last backed up 3 hours ago' });
  });

  it('counts parts while backing up, and says so before it knows how many', () => {
    expect(backupStatus(record(), ROOT, { job: 'backup', done: 12, total: 340 }, NOW))
      .toMatchObject({ tone: 'busy', label: 'Backing up 12 of 340' });
    expect(backupStatus(undefined, ROOT, { job: 'backup', done: 0, total: 0 }, NOW).label).toBe('Backing up…');
    expect(backupStatus(record(), ROOT, { job: 'check', done: 0, total: 0 }, NOW).label).toBe('Checking…');
  });

  it('tells when it was checked and what the check found', () => {
    const status = backupStatus(record({ backedUp: backedUp(ROOT), checked: checked() }), ROOT, undefined, NOW);
    expect(status).toEqual({ tone: 'ok', label: 'Up to date', detail: 'Checked 1 minute ago: 8 of 8 parts read back' });
  });

  it('shows a problem when a check finds parts missing, until a later backup', () => {
    const missing = record({ backedUp: backedUp(ROOT, NOW - 10 * MINUTE), checked: checked({ verified: 6, missing: 2 }) });
    expect(backupStatus(missing, ROOT, undefined, NOW)).toEqual({
      tone: 'problem',
      label: 'Problem: 2 of 8 checked parts are missing',
      detail: 'Checked 1 minute ago: 2 of 8 parts missing',
    });

    const fixed = { ...missing, backedUp: backedUp(ROOT, NOW) };
    expect(backupStatus(fixed, ROOT, undefined, NOW).tone).toBe('ok');
  });

  it('shows a problem when a check could read nothing back', () => {
    const unreachable = record({ backedUp: backedUp(ROOT, NOW - 10 * MINUTE), checked: checked({ verified: 0, unknown: 8 }) });
    expect(backupStatus(unreachable, ROOT, undefined, NOW)).toMatchObject({
      tone: 'problem',
      label: 'Problem: could not read the backup',
      detail: 'Checked 1 minute ago: could not read it',
    });
  });

  it('keeps the last problem with its reason until something works again', () => {
    const failed = record({ backedUp: backedUp(ROOT, NOW - 10 * MINUTE), problem: { at: NOW - MINUTE, reason: 'could not reach the server' } });
    expect(backupStatus(failed, ROOT, undefined, NOW)).toMatchObject({ tone: 'problem', label: 'Problem: could not reach the server' });

    const recovered = { ...failed, backedUp: backedUp(ROOT, NOW) };
    expect(backupStatus(recovered, ROOT, undefined, NOW).label).toBe('Up to date');
  });

  it('is paused when a backup was going as the app closed', () => {
    expect(backupStatus(record({ running: { at: NOW - MINUTE } }), ROOT, undefined, NOW).label).toBe('Paused');
  });

  it('has not been checked or backed up before anything happened', () => {
    expect(backupStatus(undefined, ROOT, undefined, NOW)).toEqual({ tone: 'idle', label: 'Not checked yet', detail: '' });
    expect(backupStatus(record(), ROOT, undefined, NOW).label).toBe('Not backed up yet');
  });
});

describe('words for time and places', () => {
  it('says how long ago in plain words', () => {
    expect(timeAgo(NOW - 10_000, NOW)).toBe('just now');
    expect(timeAgo(NOW - MINUTE, NOW)).toBe('1 minute ago');
    expect(timeAgo(NOW - 59 * MINUTE, NOW)).toBe('59 minutes ago');
    expect(timeAgo(NOW - 47 * 60 * MINUTE, NOW)).toBe('47 hours ago');
    expect(timeAgo(NOW - 72 * 60 * MINUTE, NOW)).toBe('3 days ago');
  });

  it('accepts file server addresses only, written one way', () => {
    expect(normalizeServerUrl(' https://Files.Example.com/ ')).toBe('https://files.example.com');
    expect(normalizeServerUrl('http://127.0.0.1:18933/blobs//')).toBe('http://127.0.0.1:18933/blobs');
    expect(normalizeServerUrl('files.example.com')).toBeNull();
    expect(normalizeServerUrl('wss://relay.example')).toBeNull();
    expect(normalizeServerUrl('https://files.example.com/?token=1')).toBeNull();
    expect(serverName('https://files.example.com:8443/v1')).toBe('files.example.com:8443');
  });

  it('backs up to the servers the Drive saves to, each once, leaving out the app’s own', () => {
    expect(backupServers([
      { url: 'https://upload.example/', write: true },
      { url: 'https://cdn.example', write: false },
      { url: 'https://upload.example', write: true },
      { url: 'http://127.0.0.1:21417', write: true },
    ], 'http://127.0.0.1:21417')).toEqual(['https://upload.example']);
  });
});
