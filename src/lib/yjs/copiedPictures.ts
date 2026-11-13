/**
 * Pictures copied out of a document, as other apps on the computer can use
 * them. A copied picture is named by where this browser loads it, which no
 * other app can reach; here the HTML gets each picture's bytes inline as a
 * `data:` URL, and a lone picture also goes as a PNG picture. Loaded the
 * first time a picture is copied.
 */
import { dataUrlOf, pngAt } from '../pictures';

/** Largest picture put inline, and the most all inline pictures may add up to. */
const MAX_INLINE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

/** Copied pictures, as `rewriteCopiedHtml` names them. */
const COPIED_PICTURE = /src="([^"]+)" data-iris-attachment="([^"]*)"/g;

function unescape(src: string): string {
  return src.replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** The copied pictures' addresses, in order. */
export function copiedPictureUrls(html: string): string[] {
  return [...html.matchAll(COPIED_PICTURE)].map(match => unescape(match[1]!));
}

/** The HTML with every picture that is small enough carried inline; a picture that cannot be read keeps its address. */
export async function inlinePictures(html: string): Promise<string> {
  const inline = new Map<string, string>();
  let total = 0;
  for (const url of new Set(copiedPictureUrls(html))) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const blob = await response.blob();
      if (!blob.type.startsWith('image/') || blob.size > MAX_INLINE_BYTES || total + blob.size > MAX_TOTAL_BYTES) continue;
      total += blob.size;
      inline.set(url, await dataUrlOf(blob));
    } catch {
      // Left as it is.
    }
  }
  return html.replace(COPIED_PICTURE, (whole, src: string, name: string) => {
    const data = inline.get(unescape(src));
    return data ? `src="${data}" data-iris-attachment="${name}"` : whole;
  });
}

/** The first copied picture as PNG. */
export function firstPicturePng(html: string): Promise<Blob> {
  const url = copiedPictureUrls(html)[0];
  return url ? pngAt(url) : Promise.reject(new Error('No picture'));
}
