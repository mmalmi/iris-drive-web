/**
 * Route store for Svelte
 * Provides route information from current URL
 */
import { writable, derived, get } from 'svelte/store';
import { parseRouteFromHash, type RouteInfo } from '../utils/route';

export { parseRouteFromHash };

// Store for the current hash
export const currentHash = writable<string>(typeof window !== 'undefined' ? window.location.hash : '');

// Initialize hash listener
if (typeof window !== 'undefined') {
  const syncHash = () => {
    currentHash.set(window.location.hash);
  };

  window.addEventListener('hashchange', syncHash);

  // Ensure the initial hash is captured after the app is mounted.
  // This avoids missing the direct-nav hash if module load happens too early.
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', syncHash, { once: true });
  } else {
    requestAnimationFrame(syncHash);
  }
}

/**
 * Derived store for route info
 */
export const routeStore = derived(currentHash, ($hash) => parseRouteFromHash($hash));

/**
 * Get current route synchronously
 */
export function getRouteSync(): RouteInfo {
  return parseRouteFromHash(get(currentHash));
}

/**
 * Derived store for just the current path
 */
export const currentPathStore = derived(routeStore, ($route) => $route.path);
