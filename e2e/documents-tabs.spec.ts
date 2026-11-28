import { expect, test } from './fixtures';
import {
  createDocument,
  createDriveProfile,
  documentBody,
  expectSaved,
  prepareFreshSession,
  typeInDocument,
} from './documents.helpers';

test.describe('one account in two tabs', () => {
  test.setTimeout(180_000);

  test('writing in one document while another tab shows a different one loses nothing', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Source');
    await typeInDocument(page, 'Written in the source.');
    await expectSaved(page);
    const sourceUrl = page.url();

    await page.getByRole('link', { name: 'Back to folder' }).click();
    await createDocument(page, 'Target');
    const targetUrl = page.url();

    // A second tab opens the other document and only looks at it.
    const second = await context.newPage();
    await second.goto(sourceUrl);
    await expect(documentBody(second)).toContainText('Written in the source.', { timeout: 60_000 });
    await second.waitForTimeout(2000);

    await page.bringToFront();
    await typeInDocument(page, 'Written in the target.');
    await expectSaved(page);
    await page.waitForTimeout(3000);
    await second.close();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(documentBody(page)).toContainText('Written in the target.', { timeout: 60_000 });
    await page.goto(sourceUrl);
    await expect(documentBody(page)).toContainText('Written in the source.', { timeout: 60_000 });
    await page.goto(targetUrl);
    await expect(documentBody(page)).toContainText('Written in the target.', { timeout: 60_000 });
  });

  test('writing in two documents in two tabs at the same time keeps both', async ({ page, context, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    await createDocument(page, 'Left');
    const leftUrl = page.url();
    await page.getByRole('link', { name: 'Back to folder' }).click();
    await createDocument(page, 'Right');
    const rightUrl = page.url();

    const second = await context.newPage();
    await second.goto(leftUrl);
    await expect(documentBody(second)).toBeVisible({ timeout: 60_000 });

    // Retain the order of root changes and publications when this regression fails.
    for (const tab of [page, second]) {
      tab.on('console', message => {
        if (message.text().startsWith('[tab-save]')) console.log(message.text());
      });
      await tab.evaluate(async (label) => {
        const { treeRootRegistry } = await import('/src/TreeRootRegistry.ts');
        const { getWorkerAdapter } = await import('/src/workerAdapter.ts');
        const { profileDriveProjection } = await import('/src/drive/profileDriveProjection.ts');
        const { toHex } = await import('@hashtree/core');
        const log = (kind: string, details: unknown) => console.log('[tab-save]', label, kind, JSON.stringify(details));
        for (const method of ['setLocal', 'setFromResolver'] as const) {
          const original = treeRootRegistry[method].bind(treeRootRegistry);
          treeRootRegistry[method] = ((...args: Parameters<typeof original>) => {
            log(method, { scope: args[0], drive: args[1], hash: toHex(args[2]), time: args[3] && typeof args[3] === 'number' ? args[3] : undefined });
            return Reflect.apply(original, treeRootRegistry, args);
          }) as typeof original;
        }
        const adapter = getWorkerAdapter()!;
        const push = adapter.pushToBlossom.bind(adapter);
        adapter.pushToBlossom = async (...args: Parameters<typeof push>) => {
          log('upload-start', toHex(args[0]));
          const result = await push(...args);
          log('upload-end', toHex(args[0]));
          return result;
        };
        const add = profileDriveProjection.add.bind(profileDriveProjection);
        profileDriveProjection.add = (...args: Parameters<typeof add>) => {
          log('contribution', { id: args[0].id, at: args[0].created_at, parsed: { seq: args[1]?.app_key_seq } });
          return add(...args);
        };
      }, tab === page ? 'right' : 'left');
    }

    for (let round = 1; round <= 3; round += 1) {
      await typeInDocument(second, ` Left ${round}.`);
      await typeInDocument(page, ` Right ${round}.`);
      await Promise.all([expectSaved(second), expectSaved(page)]);
    }
    await page.waitForTimeout(3000);
    await second.close();

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(documentBody(page)).toContainText('Right 3.', { timeout: 60_000 });
    await page.goto(leftUrl);
    await expect(documentBody(page)).toContainText('Left 1. Left 2. Left 3.', { timeout: 60_000 });
    await page.goto(rightUrl);
    await expect(documentBody(page)).toContainText('Right 1. Right 2. Right 3.', { timeout: 60_000 });
  });
});
