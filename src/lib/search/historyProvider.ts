/**
 * History search provider
 *
 * Uses recents store (simple prefix match on recent visits)
 */

import { getRecentsSync } from '../../stores/recents';
import { parseKeywords } from '../../stores/searchIndex';
import type { SearchProvider, SearchResult } from './types';

/** Record a history visit (no-op in web - recents store handles this) */
export async function recordHistoryVisit(
  _path: string,
  _label: string,
  _entryType: string,
  _npub?: string,
  _treeName?: string
): Promise<void> {
  // History recording is handled by the recents store in the web app
}

/** Search history (simple prefix match on recents) */
function searchHistoryWeb(query: string, limit: number): SearchResult[] {
  // Filter stop words from query - if no keywords remain, return empty
  const keywords = parseKeywords(query);
  if (keywords.length === 0) {
    return [];
  }

  const recents = getRecentsSync();

  const matches = recents
    .filter((r) => {
      // Check if any query keyword matches label, path, or treeName
      const labelLower = r.label.toLowerCase();
      const pathLower = r.path.toLowerCase();
      const treeLower = r.treeName?.toLowerCase() ?? '';

      return keywords.some(
        (kw) => labelLower.includes(kw) || pathLower.includes(kw) || treeLower.includes(kw)
      );
    })
    .slice(0, limit)
    .map((r, idx) => ({
      id: `history:${r.path}`,
      type: mapEntryType(r.type) as SearchResult['type'],
      label: r.label,
      sublabel: formatTimeAgo(r.timestamp),
      path: r.path,
      score: 1 - idx * 0.05, // Recency-based score
      icon: getIconForType(r.type),
      timestamp: r.timestamp,
    }));

  return matches;
}

/** Map entry type to SearchResult type */
function mapEntryType(entryType: string): SearchResult['type'] {
  switch (entryType) {
    case 'video':
      return 'video';
    case 'user':
      return 'user';
    case 'tree':
    case 'dir':
      return 'tree';
    case 'file':
      return 'file';
    default:
      return 'history';
  }
}

/** Get icon class for entry type */
function getIconForType(entryType: string): string {
  switch (entryType) {
    case 'video':
      return 'i-lucide-play-circle';
    case 'user':
      return 'i-lucide-user';
    case 'tree':
    case 'dir':
      return 'i-lucide-folder';
    case 'file':
      return 'i-lucide-file';
    case 'app':
      return 'i-lucide-layout-grid';
    case 'hash':
      return 'i-lucide-link';
    default:
      return 'i-lucide-clock';
  }
}

/** Format timestamp as relative time */
function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** History search provider */
export const historyProvider: SearchProvider = {
  id: 'history',
  name: 'History',
  priority: 10, // Show history first

  isAvailable(): boolean {
    return true;
  },

  async search(query: string, limit: number): Promise<SearchResult[]> {
    return searchHistoryWeb(query, limit);
  },
};

/** Get recent history without search (for empty query) */
export async function getRecentHistory(limit: number): Promise<SearchResult[]> {
  return getRecentsSync()
    .slice(0, limit)
    .map((r) => ({
      id: `history:${r.path}`,
      type: mapEntryType(r.type) as SearchResult['type'],
      label: r.label,
      sublabel: formatTimeAgo(r.timestamp),
      path: r.path,
      score: 1,
      icon: getIconForType(r.type),
      timestamp: r.timestamp,
    }));
}
