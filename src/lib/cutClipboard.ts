import { toHex, type TreeEntry } from '@hashtree/core';

const FORMAT = 'application/x-iris-drive-cut';
const STORAGE_KEY = 'iris-drive-pending-cut';

interface CutItems {
  token: string;
  account: string;
  scope: string;
  tree: string;
  path: string[];
  entries: { name: string; hash: string }[];
}

let memoryOnly: CutItems | null = null;

/** The clipboard holds names for other apps and an opaque ticket for Drive. */
export function cutItems(data: DataTransfer, account: string, scope: string, tree: string, path: string[], items: TreeEntry[]): void {
  const cut: CutItems = {
    token: crypto.randomUUID(), account, scope, tree, path: [...path],
    entries: items.map(({ name, cid }) => ({ name, hash: toHex(cid.hash) })),
  };
  data.setData('text/plain', items.map(item => item.name).join('\n'));
  data.setData(FORMAT, cut.token);
  memoryOnly = null;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cut)); } catch { memoryOnly = cut; }
}

/** A cut from this app is consumed even when it has expired, to avoid pasting a text file. */
export function pastedCut(data: DataTransfer | null): CutItems | 'expired' | null {
  const token = data?.getData(FORMAT);
  if (!token) return null;
  if (memoryOnly?.token === token) return memoryOnly;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const cut: CutItems = JSON.parse(stored);
      return cut.token === token ? cut : 'expired';
    }
  } catch { /* Use the in-memory ticket when storage is unavailable. */ }
  return 'expired';
}

export function finishCut(token: string): void {
  if (memoryOnly?.token === token) memoryOnly = null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && JSON.parse(stored).token === token) localStorage.removeItem(STORAGE_KEY);
  } catch { /* The in-memory ticket has been consumed. */ }
}
