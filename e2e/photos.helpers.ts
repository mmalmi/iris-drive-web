// What the Photos specs share: pictures drawn by the browser, and screenshots
// saved where PHOTOS_SHOTS names.
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from './fixtures';

const shots = process.env.PHOTOS_SHOTS;

export async function shot(page: Page, name: string): Promise<void> {
  if (!shots) return;
  fs.mkdirSync(shots, { recursive: true });
  await page.mouse.move(1, 1);
  // Colours ease into a new scheme.
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, `${name}.png`) });
}

/** A JPEG drawn by the browser: a sky over a hill, in the given colours. */
export async function picture(page: Page, sky: string, hill: string, width: number, height: number): Promise<Uint8Array> {
  const bytes = await page.evaluate(async ({ sky, hill, width, height }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, sky);
    gradient.addColorStop(1, '#fff7ed');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = hill;
    context.beginPath();
    context.ellipse(width * 0.6, height, width * 0.7, height * 0.35, 0, 0, Math.PI * 2);
    context.fill();
    const blob = await new Promise<Blob>((resolve) => canvas.toBlob((made) => resolve(made!), 'image/jpeg', 0.8));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  }, { sky, hill, width, height });
  return new Uint8Array(bytes);
}

export const jpeg = (name: string, bytes: Uint8Array) => ({ name, mimeType: 'image/jpeg', buffer: Buffer.from(bytes) });

/** Waits until the square of the photo called `name` shows its picture. */
export async function expectShown(page: Page, name: string): Promise<void> {
  const image = page.getByTestId('photos-view').getByRole('link', { name, exact: true }).locator('img');
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 30_000 }).toBeGreaterThan(0);
}
