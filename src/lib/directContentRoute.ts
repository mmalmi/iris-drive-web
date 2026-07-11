import { isNHash, isNPath } from '@hashtree/core';

export interface DirectContentRouteMatch {
  id: string;
  wild: string;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function matchDirectContentRoute(path: string): DirectContentRouteMatch | null {
  const segments = path.split('/').filter(Boolean).map(safeDecodeURIComponent);
  const id = segments[0];
  if (!id || (!isNHash(id) && !isNPath(id))) return null;

  return {
    id,
    wild: segments.slice(1).join('/'),
  };
}
