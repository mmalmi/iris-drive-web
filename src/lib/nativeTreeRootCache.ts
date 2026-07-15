import { toHex, type CID, type TreeVisibility } from '@hashtree/core';
import { getRuntimeHtreeServerUrl } from './htreeRuntime';

const syncedRootSignatures = new Map<string, string>();

function cacheEndpoint(serverUrl: string): string {
  return `${serverUrl.replace(/\/$/, '')}/api/cache-tree-root`;
}

function rootSignature(
  npub: string,
  treeName: string,
  cid: CID,
  visibility: TreeVisibility,
): string {
  return `${toHex(cid.hash)}:${cid.key ? toHex(cid.key) : ''}:${visibility}:${npub}/${treeName}`;
}

export function resetNativeTreeRootCacheSyncState(): void {
  syncedRootSignatures.clear();
}

export async function syncNativeTreeRootCache(
  npub: string,
  treeName: string,
  cid: CID,
  visibility: TreeVisibility = 'public',
): Promise<boolean> {
  const serverUrl = getRuntimeHtreeServerUrl();
  if (!serverUrl) return false;

  const cacheKey = `${npub}/${treeName}`;
  const signature = rootSignature(npub, treeName, cid, visibility);
  if (syncedRootSignatures.get(cacheKey) === signature) {
    return true;
  }

  const response = await fetch(cacheEndpoint(serverUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      npub,
      treeName,
      hash: toHex(cid.hash),
      key: cid.key ? toHex(cid.key) : null,
      visibility,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(body || `cache-tree-root failed with ${response.status}`);
  }

  syncedRootSignatures.set(cacheKey, signature);
  return true;
}
