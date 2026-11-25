// What holds an upload up, and what does not. Files are saved on this device
// first, so a file server that never answers changes nothing. Each file is
// then put in its folder in turn with the page's other changes: when one of
// those never ends, the upload says what it is waiting for instead of
// standing still without a word.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { configureBlossomServers, expectFolderEditable, fileRow, uploadFilesInput } from './test-utils';

const text = (name: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(`${name} ${'x'.repeat(4000)}`) });

/** Accepts every request and answers none, like a server that hangs. */
async function hangingServer(): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': '*',
        'Access-Control-Allow-Headers': '*',
      });
      response.end();
      return;
    }
    requests.push(`${request.method} ${request.url}`);
    request.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

test.describe('an upload that is held up', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page, relayUrl }) => {
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Held Up');
    await expectFolderEditable(page);
  });

  test('two files upload while the file server does not answer', async ({ page }) => {
    const server = await hangingServer();
    try {
      await configureBlossomServers(page, server.url);
      // An earlier upload leaves a send to the server under way.
      await uploadFilesInput(page).setInputFiles([text('before.txt')]);
      await expect(fileRow(page, 'before.txt')).toBeVisible({ timeout: 30_000 });
      await expect.poll(() => server.requests.length, { timeout: 30_000 }).toBeGreaterThan(0);

      await uploadFilesInput(page).setInputFiles([text('first.txt'), text('second.txt')]);
      await expect(page.getByText('Uploaded 2 files', { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(fileRow(page, 'first.txt')).toBeVisible();
      await expect(fileRow(page, 'second.txt')).toBeVisible();
    } finally {
      await server.close();
    }
  });

  test('an upload waiting for an earlier change says so, and goes on when that change ends', async ({ page }) => {
    // A change to the Drive that does not end until it is let go.
    await page.evaluate(async () => {
      const { inTurn } = await import('/src/lib/driveWrites.ts');
      void inTurn(() => new Promise<void>((resolve) => {
        (window as unknown as { __endEarlierChange: () => void }).__endEarlierChange = resolve;
      }));
    });

    await uploadFilesInput(page).setInputFiles([text('first.txt'), text('second.txt')]);
    await expect(page.getByText('Saving first.txt is taking longer than expected...', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(fileRow(page, 'first.txt')).toHaveCount(0);
    // It stays for as long as the wait does.
    await page.waitForTimeout(6000);
    await expect(page.getByText('Saving first.txt is taking longer than expected...', { exact: true })).toBeVisible();

    await page.evaluate(() => (window as unknown as { __endEarlierChange: () => void }).__endEarlierChange());
    await expect(page.getByText('Saving first.txt is taking longer than expected...', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Uploaded 2 files', { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(fileRow(page, 'first.txt')).toBeVisible();
    await expect(fileRow(page, 'second.txt')).toBeVisible();
  });
});
