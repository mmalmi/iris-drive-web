import type { Page } from './fixtures';

type Observation = Record<string, string | number | boolean | null>;
const pages: Array<{ name: string; events: Observation[]; dropped: number }> = [];
const modules = new Set([
  '/@vite/client', '/src/main.ts', '/src/stores', '/src/stores/index.ts',
  '/src/treeRootCache', '/src/treeRootCache.ts', '/src/TreeRootRegistry', '/src/TreeRootRegistry.ts',
]);

export function observeDirectNavigationHttp(page: Page, name: string): void {
  const state = { name, events: [] as Observation[], dropped: 0 };
  pages.push(state);
  const record = (event: Observation) => {
    if (state.events.length >= 128) { state.dropped++; return; }
    state.events.push({ at: new Date().toISOString(), ...event });
  };
  const localPath = (value: string): string | null => {
    const url = new URL(value);
    return ['localhost', '127.0.0.1'].includes(url.hostname) ? url.pathname : null;
  };
  page.on('request', (request) => {
    const path = localPath(request.url());
    if (path && modules.has(path)) record({ type: 'request', path, resource: request.resourceType() });
  });
  page.on('response', (response) => {
    const path = localPath(response.url());
    if (path && (modules.has(path) || response.status() >= 400)) {
      record({ type: 'response', path, status: response.status(),
        contentType: response.headers()['content-type'] ?? null,
        fromServiceWorker: response.fromServiceWorker() });
    }
  });
  page.on('requestfailed', (request) => {
    const path = localPath(request.url());
    if (path) record({ type: 'requestfailed', path, resource: request.resourceType(),
      error: request.failure()?.errorText ?? null });
  });
  page.on('pageerror', (error) => record({ type: 'pageerror', message: error.message.slice(0, 2000) }));
  page.on('crash', () => record({ type: 'crash' }));
}

export function takeDirectNavigationHttpObservations() {
  return pages.splice(0);
}
