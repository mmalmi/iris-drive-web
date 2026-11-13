/**
 * Pictures as the system clipboard takes them. Browsers put only PNG
 * pictures on it, so any other kind is redrawn as PNG first.
 */

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
