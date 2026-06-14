import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Route,
} from '@playwright/test';
import { attachRenderLoopGuardToContext, formatRenderLoopFailures } from './renderLoopGuard';

type Fixtures = {
  relayUrl: string;
  renderLoopErrors: Set<string>;
  renderLoopGuard: void;
};

async function initializeContext(context: BrowserContext, relayUrl: string, renderLoopErrors: Set<string>) {
  await context.addInitScript((url: string) => {
    (window as unknown as { __testRelayUrl?: string }).__testRelayUrl = url;
  }, relayUrl);
  attachRenderLoopGuardToContext(context, renderLoopErrors);
}

const test = base.extend<Fixtures>({
  relayUrl: [async ({}, use, workerInfo) => {
    const namespace = `w${workerInfo.workerIndex}`;
    const relayUrl = `ws://localhost:4736/${namespace}`;
    process.env.PW_TEST_RELAY_URL = relayUrl;
    await use(relayUrl);
  }, { scope: 'worker' }],
  renderLoopErrors: [async ({}, use) => {
    await use(new Set<string>());
  }, { scope: 'worker' }],
  renderLoopGuard: [async ({ renderLoopErrors }, use) => {
    const before = new Set(renderLoopErrors);
    await use();
    const failures = new Set(
      Array.from(renderLoopErrors).filter(message => !before.has(message))
    );
    if (failures.size > 0) {
      throw new Error(formatRenderLoopFailures(failures));
    }
  }, { auto: true }],
  context: async ({ context, relayUrl, renderLoopErrors }, use) => {
    await initializeContext(context, relayUrl, renderLoopErrors);
    await use(context);
  },
  browser: async ({ browser, relayUrl, renderLoopErrors }, use) => {
    const originalNewContext = browser.newContext.bind(browser);
    const wrappedBrowser = new Proxy(browser, {
      get(target, prop, receiver) {
        if (prop === 'newContext') {
          return async (options?: Parameters<Browser['newContext']>[0]) => {
            const context = await originalNewContext(options);
            await initializeContext(context, relayUrl, renderLoopErrors);
            return context;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    await use(wrappedBrowser as Browser);
  },
});

export { test, expect };
export type { Browser, BrowserContext, Page, Request, Route };
