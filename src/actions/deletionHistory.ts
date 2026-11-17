import type { DeletedLinkAccess } from '../drive/linkShareSync';
import type { RecentItem } from '../stores/recents';
import { dismissToast, showToast } from '../stores/toast';

/** A tab's deletion history. The archive holds the bytes; history only remembers how to undo each batch. */
export interface DeletedItem {
  id: string;
  original: string[];
  recents: RecentItem[];
  links: DeletedLinkAccess[];
}

const STORAGE = 'iris-drive.deletion-history';
let owner: string | null = null;
let batches: DeletedItem[][] = [];
let notice: { id: string; items: Set<string> } | null = null;

function dismissNotice(): void {
  if (notice) dismissToast(notice.id);
  notice = null;
}

function save(): void {
  try {
    if (batches.length) sessionStorage.setItem(STORAGE, JSON.stringify({ owner, batches }));
    else sessionStorage.removeItem(STORAGE);
  } catch { /* In-memory Undo also works when browser storage is full. */ }
}

export function setDeletionHistoryOwner(account: string | null): void {
  if (owner === account) return;
  dismissNotice();
  batches = [];
  if (owner) save();
  owner = account;
  if (!account) return;
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE) ?? 'null');
    if (saved?.owner === account && Array.isArray(saved.batches)) {
      batches = saved.batches.filter((batch: DeletedItem[]) => Array.isArray(batch) && batch.length &&
        batch.every(item => typeof item?.id === 'string' && Array.isArray(item.original) && Array.isArray(item.recents) && Array.isArray(item.links)));
    } else save();
  } catch { /* A fresh tab starts with empty history. */ }
}

export function rememberDeletion(account: string, items: DeletedItem[], message: string, undo: () => void): void {
  setDeletionHistoryOwner(account);
  batches.push(items);
  save();
  dismissNotice();
  notice = { id: showToast('success', message, 0, { label: 'Undo', run: undo }), items: new Set(items.map(item => item.id)) };
}

export function latestDeletion(account: string): DeletedItem[] | undefined {
  return owner === account ? batches.at(-1) : undefined;
}

export function forgetDeletionHistory(ids: string[]): void {
  if (!ids.length || !batches.length) return;
  const gone = new Set(ids);
  if (ids.some(id => notice?.items.has(id))) dismissNotice();
  batches = batches.map(batch => batch.filter(item => !gone.has(item.id))).filter(batch => batch.length);
  save();
}
