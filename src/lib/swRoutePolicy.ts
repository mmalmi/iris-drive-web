export function shouldInterceptHtreeRequestForWorker(
  path: string,
  clientKey: string | null,
  rangeHeader: string | null,
  requestDestination: string | null = null,
): boolean {
  if (!path.startsWith('/htree/')) {
    return false;
  }

  if (clientKey || rangeHeader) {
    return true;
  }

  const filePath = getHtreeFilePath(path);
  if (!filePath) {
    return false;
  }

  return !isAppShellFilePath(filePath, requestDestination);
}

function getHtreeFilePath(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'htree' || parts.length < 2) {
    return null;
  }

  const root = parts[1] ?? '';
  if (root.startsWith('nhash1')) {
    return parts.slice(2).join('/');
  }
  if (root.startsWith('npub1')) {
    if (parts.length < 3) {
      return null;
    }
    return parts.slice(3).join('/');
  }
  return null;
}

function isAppShellFilePath(filePath: string, requestDestination: string | null): boolean {
  const normalized = filePath.replace(/^\/+/, '');
  if (!normalized) {
    return true;
  }
  if (normalized.startsWith('assets/')) {
    return ['script', 'style', 'worker', 'sharedworker', 'font'].includes(requestDestination ?? '');
  }
  return [
    'index.html',
    'sw.js',
    'manifest.webmanifest',
    'stats.html',
    'stats-list.txt',
  ].includes(normalized);
}
