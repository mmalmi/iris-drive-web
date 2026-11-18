/**
 * Route parsing utilities
 * Parses URL hash to extract route info without needing React Router context
 */
import { getQueryParamsFromHash } from '../lib/router.svelte';
import { isNHash, isNPath, nhashDecode, npathDecode, type CID } from '@hashtree/core';
import { nip19 } from 'nostr-tools';

/** Decoded CID for permalink routing */
export type RouteCid = CID;

export interface RouteInfo {
  npub: string | null;
  treeName: string | null;
  /** CID for permalink routes (hash + optional decrypt key) */
  cid: RouteCid | null;
  path: string[];
  /** True when viewing a permalink (nhash route) */
  isPermalink: boolean;
  /** All query params from URL - use params.get('k'), params.get('t'), etc. */
  params: URLSearchParams;
}

const NOSTR_IDENTITY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NON_TREE_ROUTES = new Set(['settings', 'users']);
const USER_ROUTES = new Set(['profile', 'follows', 'followers', 'edit']);

export function isNostrIdentityId(value: string | undefined): value is string {
  return !!value && NOSTR_IDENTITY_ID_RE.test(value);
}

export function isIrisDriveRouteScope(value: string | undefined): value is string {
  return !!value && (value.startsWith('npub') || isNostrIdentityId(value));
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse route info from a URL hash.
 * Handles:
 * - #/npub/treeName/path/to/file
 * - #/nhash1.../path/to/file
 * - #/npub (user view)
 * - #/npub/profile
 */
export function parseRouteFromHash(hash: string): RouteInfo {
  const hashPath = hash.replace(/^#\/?/, '');
  const queryIndex = hashPath.indexOf('?');
  const path = queryIndex === -1 ? hashPath : hashPath.slice(0, queryIndex);
  const parts = path.split('/').filter(Boolean).map(safeDecodeURIComponent);
  const params = getQueryParamsFromHash(hash);
  const emptyParams = new URLSearchParams();

  // nhash route: /nhash1.../path...
  if (parts[0] && isNHash(parts[0])) {
    try {
      const cid = nhashDecode(parts[0]);
      return {
        npub: null,
        treeName: null,
        cid,
        path: parts.slice(1),
        isPermalink: true,
        params,
      };
    } catch {
      // Invalid nhash, fall through.
    }
  }

  // npath route: /npath1...
  if (parts[0] && isNPath(parts[0])) {
    try {
      const decoded = npathDecode(parts[0]);
      return {
        npub: nip19.npubEncode(decoded.pubkey),
        treeName: decoded.treeName,
        cid: null,
        path: decoded.path || [],
        isPermalink: false,
        params,
      };
    } catch {
      // Invalid npath, fall through.
    }
  }

  // Special routes (no tree context)
  if (NON_TREE_ROUTES.has(parts[0]) || (isNostrIdentityId(parts[0]) && parts[1] === 'trash')) {
    return { npub: null, treeName: null, cid: null, path: [], isPermalink: false, params: emptyParams };
  }

  // User / NostrIdentity routes
  if (isIrisDriveRouteScope(parts[0])) {
    const npub = parts[0];

    // Special user routes (profile, follows, followers, edit)
    if (USER_ROUTES.has(parts[1])) {
      return { npub, treeName: null, cid: null, path: [], isPermalink: false, params: emptyParams };
    }

    // Tree route: #/npub/treeName/path...
    if (parts[1]) {
      return {
        npub,
        treeName: parts[1],
        cid: null,
        path: parts.slice(2),
        isPermalink: false,
        params,
      };
    }

    // User view: #/npub
    return { npub, treeName: null, cid: null, path: [], isPermalink: false, params: emptyParams };
  }

  // Home route
  return { npub: null, treeName: null, cid: null, path: [], isPermalink: false, params: emptyParams };
}

/** Parse route info from the browser's current hash. */
export function parseRoute(): RouteInfo {
  return parseRouteFromHash(window.location.hash);
}
