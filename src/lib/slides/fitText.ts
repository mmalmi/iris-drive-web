/**
 * Shrinking text to fit its box. A title, subtitle or body box never lets
 * text spill out of sight: when the text is taller than the box, all of it
 * is scaled down by the same share until it fits, down to a floor below
 * which it would be too small to read. The scale is worked out wherever the
 * box is drawn, from the text as laid out there, and is not stored.
 */

/**
 * The smallest share of its size text is shrunk to. A list of points can
 * get quite a bit smaller and still be read; a title or subtitle made much
 * smaller stops looking like one, so its box grows sooner instead.
 */
export const MIN_FIT = { title: 0.6, subtitle: 0.7, body: 0.5 } as const;

/** Space above and below the text of a text box, in slide units; the stylesheet uses the same. */
export const TEXT_PAD_Y = 8;

/**
 * Sets `--fit` on `box` so that `inner`, the text inside it, is no taller
 * than `available`. Returns the share chosen. Heights are read in layout
 * units, so the answer is the same at any zoom.
 */
export function fitText(box: HTMLElement, inner: HTMLElement, available: number, floor: number): number {
  const set = (fit: number) => box.style.setProperty('--fit', String(fit));
  set(1);
  if (available <= 0 || inner.offsetHeight <= available + 0.5) return 1;
  // Text re-wraps as it shrinks, so the height is not a simple function of the scale: search for it.
  let low = floor;
  let high = 1;
  for (let step = 0; step < 6; step += 1) {
    const middle = (low + high) / 2;
    set(middle);
    if (inner.offsetHeight <= available + 0.5) low = middle;
    else high = middle;
  }
  const fit = Math.round(low * 1000) / 1000;
  set(fit);
  return fit;
}

/** Text is drawn at its own size again. */
export function clearFit(box: HTMLElement): void {
  box.style.removeProperty('--fit');
}
