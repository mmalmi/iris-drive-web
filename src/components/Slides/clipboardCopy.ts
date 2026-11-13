/**
 * What goes on the clipboard beside the plain text when something is
 * copied: a picture of it as PNG, HTML showing that picture to other apps
 * and carrying our own format, and our own format with the pictures' bytes
 * in it. Loaded the first time something is copied.
 */
import { WEB_CLIPBOARD_TYPE, clipboardHtml, type Copied } from '../../lib/slides/clipboard';
import { dataUrlOf, withMediaBytes } from '../../lib/slides/clipboardMedia';
import { snapshotPng } from '../../lib/slides/snapshot';
import { SLIDE_HEIGHT, SLIDE_WIDTH } from '../../lib/slides/model';
import { frameBox, unionBox } from '../../lib/slides/geometry';

/** A picture of what was copied, drawn from the slide as it is on the page. */
async function picture(data: Copied, root: HTMLElement | undefined): Promise<Blob> {
  const slide = data.slides[0];
  if (!root || !slide) throw new Error('Nothing to draw');
  if (data.elementIds) {
    const surface = root.querySelector<HTMLElement>('[data-testid="slide-sheet"] .slide-surface');
    const box = unionBox(slide.elements.filter(element => data.elementIds!.includes(element.id)).map(frameBox));
    if (!surface || !box) throw new Error('Nothing to draw');
    const left = Math.max(0, box.left - 4);
    const top = Math.max(0, box.top - 4);
    return snapshotPng(surface, {
      keep: data.elementIds,
      box: { x: left, y: top, w: Math.min(SLIDE_WIDTH, box.right + 4) - left, h: Math.min(SLIDE_HEIGHT, box.bottom + 4) - top },
      scale: 2,
    });
  }
  const surface = root.querySelector<HTMLElement>(`[data-slide="${slide.id}"] .slide-surface`)
    ?? root.querySelector<HTMLElement>('[data-testid="slide-sheet"] .slide-surface');
  if (!surface) throw new Error('Nothing to draw');
  return snapshotPng(surface, { scale: 1.5 });
}

export async function makeClipboard(data: Copied, root: HTMLElement | undefined): Promise<{ png: Blob; html: Blob; own: Blob }> {
  const [payload, png] = await Promise.all([withMediaBytes(data.payload), picture(data, root)]);
  const url = URL.createObjectURL(png);
  const image = await dataUrlOf(url).finally(() => URL.revokeObjectURL(url));
  return {
    png,
    html: new Blob([clipboardHtml(payload, data.text, image ?? undefined)], { type: 'text/html' }),
    own: new Blob([JSON.stringify(payload)], { type: WEB_CLIPBOARD_TYPE }),
  };
}
