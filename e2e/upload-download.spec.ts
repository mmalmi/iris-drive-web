import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { uploadFilesInput } from './test-utils';

const VIDEO = path.join(process.cwd(), 'e2e', 'fixtures', 'Big_Buck_Bunny_360_10s.webm');
const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

test('a video added to My Drive plays at its full length and downloads byte for byte', async ({ page, relayUrl }) => {
  test.setTimeout(120_000);
  await prepareFreshSession(page, relayUrl);
  await createDriveProfile(page, 'Video Test');
  // One file added is opened.
  await uploadFilesInput(page).setInputFiles(VIDEO);
  const video = page.locator('video');
  await expect(video).toBeVisible({ timeout: 30_000 });
  await video.evaluate((element: HTMLVideoElement) => {
    element.muted = true;
    void element.play().catch(() => {});
  });
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 60_000 }).toBeGreaterThanOrEqual(1);
  const shown = await video.evaluate((element: HTMLVideoElement) => ({
    duration: element.duration,
    width: element.videoWidth,
    height: element.videoHeight,
  }));
  expect(shown.duration).toBeGreaterThan(9);
  expect(shown.duration).toBeLessThan(11);
  expect([shown.width, shown.height]).toEqual([640, 360]);

  // Without the file picker the browser downloads it.
  await page.evaluate(() => { delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker; });
  const pending = page.waitForEvent('download');
  await page.getByTestId('viewer-download').click();
  const downloaded = fs.readFileSync((await (await pending).path())!);
  expect(downloaded.length).toBe(fs.statSync(VIDEO).size);
  expect(sha256(downloaded)).toBe(sha256(fs.readFileSync(VIDEO)));
});
