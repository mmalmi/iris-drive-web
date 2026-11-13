/**
 * Pictures in the browser: their size, their bytes as a data URL, and PNG
 * copies for the system clipboard. Browsers put only PNG pictures on it, so
 * any other kind is redrawn as PNG first.
 */

/** A picture's own size in pixels (0 where it has none), or null when the data is not a picture a browser can show. */
export async function pictureSize(blob: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === 'function' && blob.type !== 'image/svg+xml') {
    // Some pictures a page shows are refused here; those are measured as an <img> below.
    const bitmap = await createImageBitmap(blob).catch(() => null);
    if (bitmap) {
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return { width: image.naturalWidth, height: image.naturalHeight };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The bytes as a `data:` URL, as HTML for other apps carries pictures. */
export function dataUrlOf(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * A picture redrawn as PNG. A PNG is redrawn too: Chrome turns away a PNG
 * file it can show but whose bytes it finds slightly off, and a fresh one is
 * always taken.
 */
export async function pngOf(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth || 1;
    canvas.height = image.naturalHeight || 1;
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(png => (png ? resolve(png) : reject(new Error('The picture could not be drawn'))), 'image/png'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The picture at `url` (where this page shows it) as PNG. */
export async function pngAt(url: string): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error('The picture could not be read');
  return pngOf(await response.blob());
}

/**
 * Puts one picture on the system clipboard as PNG. Asked for at once, while
 * it is still the person's own act; the picture is made as it is needed.
 */
export function writePng(png: Promise<Blob>): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function') {
    return Promise.reject(new Error('This browser cannot copy pictures'));
  }
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
