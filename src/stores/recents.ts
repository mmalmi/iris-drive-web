/**
 * Store for managing recently visited locations
 * Persists to localStorage, uses Svelte stores
 */
import { writable, get } from 'svelte/store';
import type { TreeVisibility } from '@hashtree/core';
import { routeStore } from './route';

const STORAGE_KEY = 'hashtree:recents';
const MAX_RECENTS = 20;

export interface RecentItem {
  type: 'tree' | 'file' | 'dir' | 'hash';
  /** Display label */
  label: string;
  /** URL path to navigate to (without query params) */
  path: string;
  /** Timestamp of last visit */
  timestamp: number;
  /** Optional npub for tree/file types */
  npub?: string;
  /** Optional tree name */
  treeName?: string;
  /** Optional visibility for tree/file types */
  visibility?: TreeVisibility;
  /** Optional link key for link-visible trees */
  linkKey?: string;
  /** For hash type: whether it has an encryption key */
  hasKey?: boolean;
}

function loadRecents(): RecentItem[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const items: RecentItem[] = JSON.parse(stored);
    // Clean up: hash type items shouldn't have npub
    let cleaned = false;
    const cleanedItems = items.map(item => {
      if (item.type === 'hash' && item.npub) {
        cleaned = true;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { npub, ...rest } = item;
        return rest;
      }
      return item;
    });
    // Persist cleaned data
    if (cleaned) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(cleanedItems));
    }
    return cleanedItems;
  } catch {
    return [];
  }
}

function saveRecents(items: RecentItem[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  } catch {
    // Ignore storage errors
  }
}

// Svelte store for recents
export const recentsStore = writable<RecentItem[]>(loadRecents());

/**
 * Add or update a recent item
 * Moves existing items to top, deduplicates by normalized path
 */
export function addRecent(item: Omit<RecentItem, 'timestamp'>) {
  recentsStore.update(current => {
    const newItem: RecentItem = {
      ...item,
      timestamp: Date.now(),
    };

    // Remove existing item with same path
    const filtered = current.filter(r => r.path !== item.path);

    // Add to front, trim to max
    const updated = [newItem, ...filtered].slice(0, MAX_RECENTS);
    saveRecents(updated);
    return updated;
  });
}

/**
 * Update a recent item's visibility by path
 */
export function updateRecentVisibility(path: string, visibility: TreeVisibility) {
  recentsStore.update(current => {
    const updated = current.map(item =>
      item.path === path ? { ...item, visibility } : item
    );
    saveRecents(updated);
    return updated;
  });
}

/**
 * Update a recent item's label by path
 */
export function updateRecentLabel(path: string, label: string) {
  recentsStore.update(current => {
    const updated = current.map(item =>
      item.path === path ? { ...item, label } : item
    );
    saveRecents(updated);
    return updated;
  });
}

/**
 * Remove a recent item by tree name (for when trees are deleted)
 */
export function removeRecentByTreeName(npub: string, treeName: string) {
  recentsStore.update(current => {
    const filtered = current.filter(item =>
      !(item.npub === npub && item.treeName === treeName)
    );
    saveRecents(filtered);
    return filtered;
  });
}

/**
 * Clear all recents
 */
export function clearRecents() {
  recentsStore.set([]);
  saveRecents([]);
}

/**
 * Clear recents by tree name prefix (e.g., 'docs/')
 */
export function clearRecentsByPrefix(prefix: string) {
  recentsStore.update(current => {
    const filtered = current.filter(item => !item.treeName?.startsWith(prefix));
    saveRecents(filtered);
    return filtered;
  });
}

/**
 * Get current recents synchronously
 */
export function getRecentsSync(): RecentItem[] {
  return get(recentsStore);
}

// Track nhash visits automatically
const HMR_KEY = '__recentsNhashInitialized';
const globalObj = typeof globalThis !== 'undefined' ? globalThis : window;

if (!(globalObj as Record<string, unknown>)[HMR_KEY]) {
  (globalObj as Record<string, unknown>)[HMR_KEY] = true;

  routeStore.subscribe((route) => {
    if (route.isPermalink && route.cid?.hash) {
      // Build nhash from current URL
      const hashPath = window.location.hash.replace(/^#\/?/, '');
      const nhash = hashPath.split('/')[0];

      if (!nhash) return;

      addRecent({
        type: 'hash',
        label: nhash.slice(0, 16) + '...',
        path: '/' + nhash,
        hasKey: !!route.cid.key,
      });
    }
  });
}
