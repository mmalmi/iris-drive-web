import { writable } from 'svelte/store';
import {
  SHARE_INVITE_PREFIX,
  parseShareInvite,
  projectSharedFolderView,
  shareInviteBundleIncludesProfile,
  sharedFolderAppKeysForProfile,
  type IrisProfileId,
  type ShareInviteBundle,
  type ShareShortcut,
  type SharedFolder,
  type SharedFolderView,
} from './protocol';

const STORAGE_KEY = 'iris-drive.accepted-shares.v1';

export interface AcceptedShareRecord {
  share_id: IrisProfileId;
  local_profile_id: IrisProfileId;
  accepted_at: number;
  invite_payload: string;
  folder: SharedFolder;
  shortcuts: ShareShortcut[];
}

export interface AcceptedShareView extends AcceptedShareRecord {
  local_app_key_pubkey: string;
  view: SharedFolderView;
}

export const acceptedShares = writable<AcceptedShareRecord[]>(loadAcceptedShares());

if (canUseLocalStorage()) {
  acceptedShares.subscribe((records) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  });
}

export function acceptShareInvite(input: string, acceptedAt = currentUnixSeconds()): AcceptedShareRecord {
  return acceptParsedShareInvite(input, undefined, acceptedAt);
}

export function acceptShareInviteForProfile(
  input: string,
  localProfileId: IrisProfileId,
  acceptedAt = currentUnixSeconds(),
): AcceptedShareRecord {
  return acceptParsedShareInvite(input, localProfileId, acceptedAt);
}

function acceptParsedShareInvite(
  input: string,
  localProfileId: IrisProfileId | undefined,
  acceptedAt: number,
): AcceptedShareRecord {
  const bundle = parseShareInvite(input);
  const record = acceptedShareRecordFromBundle(bundle, shareInvitePayload(input), acceptedAt, localProfileId);
  acceptedShares.update((records) => upsertAcceptedShare(records, record));
  return record;
}

export function addShareShortcut(shareId: IrisProfileId, path?: string): ShareShortcut | null {
  let shortcut: ShareShortcut | null = null;
  acceptedShares.update((records) => {
    const updated = addShortcutToAcceptedShares(records, shareId, path);
    shortcut = updated.shortcut;
    return updated.records;
  });
  return shortcut;
}

export function projectAcceptedShareViews(records: AcceptedShareRecord[]): AcceptedShareView[] {
  return records
    .map((record) => {
      const localAppKey = localAppKeyForShare(record.folder, record.local_profile_id) ?? '';
      return {
        ...record,
        local_app_key_pubkey: localAppKey,
        view: projectSharedFolderView(record.folder, record.shortcuts, localAppKey),
      };
    })
    .sort((a, b) => (
      a.view.display_name.localeCompare(b.view.display_name)
      || a.share_id.localeCompare(b.share_id)
    ));
}

export function acceptedShareRecordFromBundle(
  bundle: ShareInviteBundle,
  invitePayload: string,
  acceptedAt: number,
  localProfileId?: IrisProfileId,
): AcceptedShareRecord {
  const folder = bundle.shared_folder;
  const resolvedLocalProfileId = localProfileId ?? bundle.recipient_profile_id;
  if (!shareInviteBundleIncludesProfile(bundle, resolvedLocalProfileId)) {
    throw new Error(`share invite is not for IrisProfile ${resolvedLocalProfileId}`);
  }
  return {
    share_id: folder.share_id,
    local_profile_id: resolvedLocalProfileId,
    accepted_at: acceptedAt,
    invite_payload: invitePayload,
    folder,
    shortcuts: [],
  };
}

export function upsertAcceptedShare(
  records: AcceptedShareRecord[],
  incoming: AcceptedShareRecord,
): AcceptedShareRecord[] {
  const existing = records.find((record) => record.share_id === incoming.share_id);
  const next = {
    ...incoming,
    shortcuts: existing?.shortcuts ?? incoming.shortcuts,
  };
  return [
    ...records.filter((record) => record.share_id !== incoming.share_id),
    next,
  ].sort((a, b) => a.folder.display_name.localeCompare(b.folder.display_name) || a.share_id.localeCompare(b.share_id));
}

export function addShortcutToAcceptedShares(
  records: AcceptedShareRecord[],
  shareId: IrisProfileId,
  path?: string,
): { records: AcceptedShareRecord[]; shortcut: ShareShortcut | null } {
  let shortcut: ShareShortcut | null = null;
  const next = records.map((record) => {
    if (record.share_id !== shareId) return record;
    const shortcutPath = path?.trim() || defaultShareShortcutPath(record.folder);
    const existing = record.shortcuts.find((item) => item.path === shortcutPath);
    if (existing) {
      shortcut = existing;
      return record;
    }
    const localAppKey = localAppKeyForShare(record.folder, record.local_profile_id) ?? '';
    const view = projectSharedFolderView(record.folder, record.shortcuts, localAppKey);
    shortcut = {
      share_id: record.share_id,
      path: shortcutPath,
      target_path: view.shared_with_me_path,
    };
    return {
      ...record,
      shortcuts: [...record.shortcuts, shortcut].sort((a, b) => a.path.localeCompare(b.path)),
    };
  });
  return { records: next, shortcut };
}

export function defaultShareShortcutPath(folder: SharedFolder): string {
  return `My Drive/${sanitizeShortcutName(folder.display_name)}`;
}

function localAppKeyForShare(folder: SharedFolder, localProfileId: IrisProfileId): string | null {
  return sharedFolderAppKeysForProfile(folder, localProfileId)[0] ?? null;
}

function shareInvitePayload(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith(SHARE_INVITE_PREFIX) ? trimmed.slice(SHARE_INVITE_PREFIX.length) : trimmed;
}

function loadAcceptedShares(): AcceptedShareRecord[] {
  if (!canUseLocalStorage()) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeAcceptedShareRecord).filter((record): record is AcceptedShareRecord => record !== null);
  } catch {
    return [];
  }
}

function normalizeAcceptedShareRecord(value: unknown): AcceptedShareRecord | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<AcceptedShareRecord>;
  if (
    typeof record.share_id !== 'string'
    || typeof record.local_profile_id !== 'string'
    || typeof record.accepted_at !== 'number'
    || typeof record.invite_payload !== 'string'
    || !record.folder
    || typeof record.folder !== 'object'
  ) {
    return null;
  }
  return {
    share_id: record.share_id,
    local_profile_id: record.local_profile_id,
    accepted_at: record.accepted_at,
    invite_payload: record.invite_payload,
    folder: record.folder,
    shortcuts: Array.isArray(record.shortcuts) ? record.shortcuts.filter(isShareShortcut) : [],
  };
}

function isShareShortcut(value: unknown): value is ShareShortcut {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof (value as ShareShortcut).share_id === 'string'
    && typeof (value as ShareShortcut).path === 'string'
    && typeof (value as ShareShortcut).target_path === 'string',
  );
}

function sanitizeShortcutName(value: string): string {
  const sanitized = value.trim().replace(/[\\/]/g, '_').replace(/^\.+$/, 'Shared folder');
  return sanitized || 'Shared folder';
}

function currentUnixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function canUseLocalStorage(): boolean {
  return Boolean(
    typeof localStorage !== 'undefined'
    && typeof localStorage.getItem === 'function'
    && typeof localStorage.setItem === 'function',
  );
}
