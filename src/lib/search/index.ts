/**
 * Unified search service
 *
 * Aggregates results from multiple providers with deduplication and ranking.
 */

import type { SearchProvider, SearchResult, SearchOptions } from './types';
import { historyProvider, getRecentHistory } from './historyProvider';
import { userProvider } from './userProvider';
import { appsProvider, getAppSuggestions } from './appsProvider';

export type { SearchProvider, SearchResult, SearchOptions } from './types';
export { recordHistoryVisit } from './historyProvider';

// Provider registry
const providers = new Map<string, SearchProvider>();

/** Register a search provider */
function registerProvider(provider: SearchProvider): void {
  providers.set(provider.id, provider);
}

// Register default providers
registerProvider(historyProvider);
registerProvider(userProvider);
registerProvider(appsProvider);

/** Search all providers and return merged results */
export async function search(
  query: string,
  options: SearchOptions = {}
): Promise<SearchResult[]> {
  const { limit = 20, sources, minScore = 0 } = options;

  // Get providers to search
  const providersToSearch = sources
    ? sources.map((id) => providers.get(id)).filter(Boolean) as SearchProvider[]
    : Array.from(providers.values()).filter((p) => p.isAvailable());

  if (providersToSearch.length === 0) {
    return [];
  }

  // Search all providers in parallel
  const perProviderLimit = Math.ceil(limit / providersToSearch.length) + 5; // Extra for dedup
  const resultArrays = await Promise.all(
    providersToSearch.map(async (provider) => {
      try {
        return await provider.search(query, perProviderLimit);
      } catch (e) {
        console.warn(`[search] Provider ${provider.id} failed:`, e);
        return [];
      }
    })
  );

  // Flatten and merge results
  const allResults = resultArrays.flat();

  // Deduplicate by path (keep highest score)
  const byPath = new Map<string, SearchResult>();
  for (const result of allResults) {
    const existing = byPath.get(result.path);
    if (!existing || result.score > existing.score) {
      byPath.set(result.path, result);
    }
  }

  // Filter by minimum score and sort
  const filtered = Array.from(byPath.values())
    .filter((r) => r.score >= minScore)
    .sort((a, b) => {
      // Sort by score descending
      if (b.score !== a.score) return b.score - a.score;
      // Then by timestamp descending (most recent first)
      const aTime = a.timestamp ?? 0;
      const bTime = b.timestamp ?? 0;
      return bTime - aTime;
    });

  return filtered.slice(0, limit);
}

/** Get suggestions for empty query (recent history + apps) */
export async function getSuggestions(limit = 10): Promise<SearchResult[]> {
  const history = await getRecentHistory(limit);

  // If no history, show app suggestions
  if (history.length === 0) {
    return getAppSuggestions().slice(0, limit);
  }

  return history;
}
