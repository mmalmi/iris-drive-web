import type { BrowserContext, Page } from '@playwright/test';

const RENDER_LOOP_PATTERNS = [
  'effect_update_depth_exceeded',
  'Maximum update depth exceeded',
];

export function isRenderLoopMessage(message: string): boolean {
  return RENDER_LOOP_PATTERNS.some(pattern => message.includes(pattern));
}

export function formatRenderLoopFailures(failures: Set<string>): string {
  return `Detected Svelte render/update loop:\n${Array.from(failures).join('\n')}`;
}

export function attachRenderLoopGuardToContext(context: BrowserContext, failures: Set<string>) {
  const guardedPages = new WeakSet<Page>();

  const recordFailure = (source: 'console' | 'pageerror', page: Page, message: string) => {
    if (!isRenderLoopMessage(message)) return;
    failures.add(`[${source}] ${page.url() || 'about:blank'} ${message}`);
  };

  const guardPage = (page: Page) => {
    if (guardedPages.has(page)) return;
    guardedPages.add(page);

    page.on('pageerror', (error) => {
      recordFailure('pageerror', page, error.stack || error.message);
    });

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      recordFailure('console', page, message.text());
    });
  };

  context.pages().forEach(guardPage);
  context.on('page', guardPage);
}
