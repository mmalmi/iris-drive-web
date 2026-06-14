/**
 * Apps search provider
 *
 * Provides suggestions for local apps.
 */

import type { SearchProvider, SearchResult } from './types';

// Local apps
const localApps: SearchResult[] = [
  {
    id: 'app:files',
    type: 'tree' as const,
    label: 'Files',
    sublabel: 'Browse your files',
    path: '/',
    score: 0.9,
    icon: 'i-lucide-folder',
  },
];

/** Apps search provider */
export const appsProvider: SearchProvider = {
  id: 'apps',
  name: 'Apps',
  priority: 3,

  isAvailable(): boolean {
    return true;
  },

  async search(query: string, limit: number): Promise<SearchResult[]> {
    const queryLower = query.toLowerCase();

    const matches = localApps.filter((app) => {
      const labelMatch = app.label.toLowerCase().includes(queryLower);
      const sublabelMatch = app.sublabel?.toLowerCase().includes(queryLower);
      return labelMatch || sublabelMatch;
    });

    return matches.slice(0, limit);
  },
};

/** Get app suggestions (for empty query) */
export function getAppSuggestions(): SearchResult[] {
  return localApps;
}
