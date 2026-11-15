// Photos: every picture and video in the Drive, newest first under date
// headings, and one at a time over the whole screen. With PHOTOS_SHOTS set
// it saves screenshots there.
import { expect, test, type Page } from './fixtures';
import { createDriveProfile, prepareFreshSession } from './documents.helpers';
import { fileRow, uploadIntoFolder } from './test-utils';
import { jpegWithExif } from '../tests/fixtures/exif';
import { expectShown, jpeg, picture, shot } from './photos.helpers';

/** A second of WebM video recorded by the browser from a moving drawing. */
async function video(page: Page): Promise<Uint8Array> {
  const bytes = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 240;
    const context = canvas.getContext('2d')!;
    const recorder = new MediaRecorder(canvas.captureStream(25), { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
    recorder.start();
    const started = performance.now();
    await new Promise<void>((resolve) => {
      const draw = () => {
        const t = (performance.now() - started) / 1000;
        context.fillStyle = '#0f766e';
        context.fillRect(0, 0, 320, 240);
        context.fillStyle = '#fde047';
        context.beginPath();
        context.arc(40 + t * 240, 120, 30, 0, Math.PI * 2);
        context.fill();
        if (t < 1) requestAnimationFrame(draw);
        else resolve();
      };
      draw();
    });
    recorder.stop();
    await stopped;
    return Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()));
  });
  return new Uint8Array(bytes);
}

const tiles = (page: Page) => page.getByTestId('photo-tile');
const viewer = (page: Page) => page.getByTestId('photo-viewer');
const viewerName = (page: Page) => page.getByTestId('photo-viewer-name');

test.describe('Photos', () => {
  test.setTimeout(180_000);

  test('shows the pictures in the Drive newest first, and opens them one at a time', async ({ page, relayUrl }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await prepareFreshSession(page, relayUrl);
    const { profileId } = await createDriveProfile(page, 'Photo Test');
    const sidebar = page.getByTestId('drive-sidebar');

    await sidebar.getByRole('link', { name: 'Photos' }).click();
    await expect(page).toHaveURL(/#\/photos$/);
    await expect(sidebar.getByRole('link', { name: 'Photos' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('photos-empty')).toContainText('Photos and videos in your Drive show up here', { timeout: 30_000 });

    // Uploaded here, they go into a new Photos folder of My Drive. The lake's camera says it was taken last year.
    const sunset = await picture(page, '#fb923c', '#7c2d12', 1600, 1000);
    const lake = jpegWithExif(await picture(page, '#38bdf8', '#14532d', 800, 1200), { original: '2025:06:01 12:30:00' });
    await page.getByTestId('photos-upload-input').setInputFiles([jpeg('sunset.jpg', sunset), jpeg('lake.jpg', lake)]);
    await expect(tiles(page)).toHaveCount(2, { timeout: 30_000 });
    const headings = page.getByTestId('photos-group').getByRole('heading');
    await expect(headings).toHaveText(['Today', 'June 2025'], { timeout: 30_000 });

    // One uploaded into My Drive shows here too, and the Photos folder is there.
    await sidebar.getByRole('link', { name: 'My Drive' }).click();
    await expect(fileRow(page, 'Photos')).toBeVisible({ timeout: 30_000 });
    await uploadIntoFolder(page, jpeg('meadow.jpg', await picture(page, '#a5b4fc', '#15803d', 1200, 900)));
    await sidebar.getByRole('link', { name: 'Photos' }).click();
    await expect(tiles(page)).toHaveCount(3, { timeout: 30_000 });
    await expect(tiles(page).first()).toHaveAttribute('aria-label', 'meadow.jpg');
    await expect(tiles(page).last()).toHaveAttribute('aria-label', 'lake.jpg');
    for (const name of ['meadow.jpg', 'sunset.jpg', 'lake.jpg']) await expectShown(page, name);
    // The squares show small copies, kept on this device, not the whole pictures.
    const sunsetSquare = page.getByTestId('photos-view').getByRole('link', { name: 'sunset.jpg', exact: true }).locator('img');
    expect(await sunsetSquare.evaluate((img: HTMLImageElement) => [img.src.slice(0, 5), img.naturalWidth, img.naturalHeight])).toEqual(['blob:', 512, 320]);
    await shot(page, 'desktop-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'desktop-dark');
    await page.emulateMedia({ colorScheme: 'light' });

    // Full screen: the arrow keys and the buttons step, Escape and Back close.
    await tiles(page).first().click();
    await expect(viewer(page)).toBeVisible();
    await expect(viewerName(page)).toHaveText('meadow.jpg');
    await page.keyboard.press('ArrowRight');
    await expect(viewerName(page)).toHaveText('sunset.jpg');
    await page.getByTestId('photo-viewer-next').click();
    await expect(viewerName(page)).toHaveText('lake.jpg');
    await expect(page.getByTestId('photo-viewer-next')).toHaveCount(0);
    await expect.poll(() => page.getByTestId('photo-viewer-image').evaluate((img: HTMLImageElement) => img.naturalWidth), { timeout: 30_000 }).toBe(800);
    await shot(page, 'viewer-desktop');
    await page.keyboard.press('ArrowLeft');
    await expect(viewerName(page)).toHaveText('sunset.jpg');
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);
    await expect(page).toHaveURL(/#\/photos$/);
    await expect(tiles(page).nth(1)).toBeFocused();

    await tiles(page).nth(2).click();
    await expect(viewerName(page)).toHaveText('lake.jpg');
    await page.goBack();
    await expect(viewer(page)).toHaveCount(0);
    await expect(page).toHaveURL(/#\/photos$/);

    // Open in folder: the file in its place in Drive.
    await tiles(page).nth(2).click();
    await page.getByTestId('photo-viewer-open-in-folder').click();
    await expect(page).toHaveURL(new RegExp(`#/${profileId}/main/Photos/lake\\.jpg$`));
    await expect(page.getByTestId('viewer-header')).toContainText('lake.jpg', { timeout: 30_000 });

    // A photo's own address opens it after a reload.
    await page.goBack();
    await expect(viewerName(page)).toHaveText('lake.jpg');
    await page.reload();
    await expect(viewerName(page)).toHaveText('lake.jpg', { timeout: 30_000 });
    await page.keyboard.press('Escape');
    await expect(page).toHaveURL(/#\/photos$/);
    await expect(tiles(page)).toHaveCount(3);

    // A video shows its first frame, and plays full screen.
    await page.getByTestId('photos-upload-input').setInputFiles({ name: 'clip.webm', mimeType: 'video/webm', buffer: Buffer.from(await video(page)) });
    await expect(tiles(page)).toHaveCount(4, { timeout: 30_000 });
    const clip = page.getByTestId('photos-view').getByRole('link', { name: 'clip.webm', exact: true });
    await expectShown(page, 'clip.webm');
    await expect(clip.locator('video')).toHaveCount(0);
    const poster = await clip.locator('img').evaluate((img: HTMLImageElement) => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      return { url: img.src, width: img.naturalWidth, green: ctx.getImageData(5, 5, 1, 1).data[1] };
    });
    expect(poster.url).toMatch(/^blob:/);
    expect(poster.width).toBe(320);
    expect(poster.green).toBeGreaterThan(75);
    await shot(page, 'desktop-video');
    await clip.click();
    await expect(viewerName(page)).toHaveText('clip.webm');
    await expect.poll(() => viewer(page).locator('video').evaluate((element: HTMLVideoElement) => element.readyState), { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    await shot(page, 'viewer-video');
    await page.keyboard.press('Escape');
    await expect(viewer(page)).toHaveCount(0);

    // A fresh page can show the stored poster without opening the video again.
    await page.reload();
    await expectShown(page, 'clip.webm');
    expect(await page.evaluate(() => performance.getEntriesByType('resource')
      .filter(entry => entry.name.includes('/htree/') && entry.name.includes('clip.webm')).length)).toBe(0);
  });


  test('scrolling the folder grid releases a panorama and restores its bounded thumbnail', async ({ page, relayUrl }) => {
    await page.setViewportSize({ width: 860, height: 460 });
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page);
    const name = '01-panorama.jpg';
    const photo = jpeg(name, await picture(page, '#7ab8df', '#487150', 6400, 400));
    const filler = Array.from({ length: 36 }, (_, i) => ({
      name: 'note-' + i + '.txt', mimeType: 'text/plain', buffer: Buffer.from('note'),
    }));
    await uploadIntoFolder(page, [photo, ...filler]);
    await page.getByRole('button', { name: 'Grid view' }).click();
    const grid = page.getByTestId('file-list');
    const image = fileRow(page, name).locator('img');
    await expect(image).toHaveJSProperty('naturalWidth', 640);
    await expect(image).toHaveJSProperty('naturalHeight', 320);
    const src = await image.getAttribute('src');
    await grid.evaluate(el => el.scrollTo(0, el.scrollHeight));
    await expect(image).toHaveCount(0);
    expect(await page.evaluate(url => fetch(url!).then(() => true, () => false), src)).toBe(false);
    await grid.evaluate(el => el.scrollTo(0, 0));
    await expect(image).toHaveJSProperty('naturalWidth', 640);
  });

  test('on a phone, Photos is a tab and a swipe steps', async ({ page, relayUrl }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await prepareFreshSession(page, relayUrl);
    await createDriveProfile(page, 'Phone Photos');
    const tabs = page.getByTestId('drive-tabs');
    await tabs.getByRole('link', { name: 'Photos' }).click();
    await expect(tabs.getByRole('link', { name: 'Photos' })).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('photos-empty')).toBeVisible({ timeout: 30_000 });
    await shot(page, 'phone-empty');

    const pictures = [
      jpeg('dunes.jpg', await picture(page, '#fde68a', '#b45309', 1200, 900)),
      jpeg('forest.jpg', await picture(page, '#bbf7d0', '#166534', 900, 1200)),
      jpeg('harbour.jpg', await picture(page, '#bfdbfe', '#1e3a8a', 1200, 1200)),
      jpeg('peaks.jpg', jpegWithExif(await picture(page, '#e0e7ff', '#334155', 1200, 800), { original: '2026:10:02 08:00:00' })),
    ];
    await page.getByTestId('photos-upload-input').setInputFiles(pictures);
    await expect(tiles(page)).toHaveCount(4, { timeout: 30_000 });
    for (const { name } of pictures) await expectShown(page, name);
    // Three or more to a row.
    const [first, second, third] = await Promise.all([0, 1, 2].map((index) => tiles(page).nth(index).boundingBox()));
    expect(first!.y).toBe(third!.y);
    expect(second!.width).toBeGreaterThan(90);
    await shot(page, 'phone-light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await shot(page, 'phone-dark');

    await tiles(page).first().click();
    const firstName = await viewerName(page).textContent();
    const swipe = async (fromX: number, toX: number) => {
      await page.getByTestId('photo-viewer').evaluate((dialog, [from, to]) => {
        const area = dialog.querySelector('img')!.parentElement!;
        const touch = (x: number) => new Touch({ identifier: 1, target: area, clientX: x, clientY: 400 });
        area.dispatchEvent(new TouchEvent('touchstart', { touches: [touch(from!)], changedTouches: [touch(from!)], bubbles: true }));
        area.dispatchEvent(new TouchEvent('touchend', { touches: [], changedTouches: [touch(to!)], bubbles: true }));
      }, [fromX, toX]);
    };
    await expect(page.getByTestId('photo-viewer-image')).toBeVisible();
    await swipe(320, 80);
    await expect(viewerName(page)).not.toHaveText(firstName!);
    await shot(page, 'viewer-phone-dark');
    await swipe(80, 320);
    await expect(viewerName(page)).toHaveText(firstName!);
    await page.getByTestId('photo-viewer-close').click();
    await expect(viewer(page)).toHaveCount(0);
  });
});
