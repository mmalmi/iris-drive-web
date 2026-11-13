/**
 * History search provider
 *
 * Uses recents store (simple prefix match on recent visits)
 */

import { get } from 'svelte/store';
import { getRecentsSync } from '../../stores/recents';
import { acceptedShares } from '../../drive/shareLibrary';
import { activeNostrIdentityRootScope } from '../../drive/profileRoute';
import { nostrStore } from '../../nostr';
import { recentDisplay, timeAgo } from '../recentDisplay';
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

  const ownProfileId = activeNostrIdentityRootScope(get(nostrStore));
  const shares = get(acceptedShares);
  const matches = getRecentsSync()
    .map((r) => ({ r, shown: recentDisplay(r, ownProfileId, shares) }))
    .filter(({ r, shown }) => {
      // Match the name people see, and the address.
      const haystack = `${shown.name}\n${r.path}`.toLowerCase();
      return keywords.some((kw) => haystack.includes(kw));
    })
    .slice(0, limit)
    .map(({ r, shown }, idx) => ({
      id: `history:${r.path}`,
      type: mapEntryType(r.type) as SearchResult['type'],
      label: shown.name,
      sublabel: timeAgo(r.timestamp),
      path: r.path,
      score: 1 - idx * 0.05, // Recency-based score
      icon: shown.icon,
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
  const ownProfileId = activeNostrIdentityRootScope(get(nostrStore));
  const shares = get(acceptedShares);
  return getRecentsSync()
    .slice(0, limit)
    .map((r) => {
      const shown = recentDisplay(r, ownProfileId, shares);
      return {
        id: `history:${r.path}`,
        type: mapEntryType(r.type) as SearchResult['type'],
        label: shown.name,
        sublabel: timeAgo(r.timestamp),
        path: r.path,
        score: 1,
        icon: shown.icon,
        timestamp: r.timestamp,
      };
    });
}
