/**
 * How a recently opened item is named and drawn, the same in Recent and in
 * search: documents by their title and kind, a Drive's own top folder as
 * "My Drive" (or a shared folder by its name), everything else by its label.
 */
import { fileIcon } from './fileIcon';
import type { AcceptedShareRecord } from '../drive/shareLibrary';
import type { RecentItem } from '../stores/recents';
import { documentKindInfo, documentTitle } from './documentNames';

type RecentLike = Pick<RecentItem, 'type' | 'label' | 'path' | 'npub' | 'treeName'>;

export function recentDisplay(
  item: RecentLike,
  ownProfileId: string | null,
  shares: AcceptedShareRecord[],
): { name: string; icon: string } {
  const last = item.path.split('/').at(-1) ?? '';
  const kind = documentKindInfo(last);
  if (kind) return { name: documentTitle(last), icon: kind.icon };
  if (item.type === 'hash') return { name: item.label, icon: 'i-lucide-hash text-accent' };
  if (item.type === 'tree' && item.treeName === 'main' && item.npub) {
    if (item.npub === ownProfileId) return { name: 'My Drive', icon: 'i-lucide-hard-drive text-text-2' };
    const shared = shares.find((record) => record.share_id === item.npub);
    if (shared) return { name: shared.folder.display_name, icon: 'i-lucide-folder text-warning' };
  }
  if (item.type === 'tree' || item.type === 'dir') return { name: item.label, icon: 'i-lucide-folder text-warning' };
  return { name: item.label, icon: `${fileIcon(item.label)} text-text-2` };
}

/** Where a recent item opens. */
export function recentHref(item: Pick<RecentItem, 'type' | 'path' | 'npub' | 'treeName' | 'linkKey'>): string {
  let encodedPath = item.path;
  if (item.type === 'file' && item.path) {
    // /owner/tree/path/to/file, each part encoded once.
    const [owner, ...rest] = item.path.split('/').filter(Boolean);
    if (owner && rest.length > 0) encodedPath = `/${owner}/${rest.map(encodeURIComponent).join('/')}`;
  } else if (item.treeName) {
    encodedPath = `/${item.npub}/${encodeURIComponent(item.treeName)}`;
  }
  return item.linkKey ? `#${encodedPath}?k=${item.linkKey}` : `#${encodedPath}`;
}

/** "Just now", "5m ago", "3h ago", "2d ago", then the date. */
export function timeAgo(timestamp: number, now = Date.now()): string {
  const minutes = Math.floor((now - timestamp) / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}
