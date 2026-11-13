/**
 * The pictures of what is copied and pasted: read into the clipboard so they
 * travel between decks, made a deck's own when pasted, and found in HTML
 * from other apps. Loaded the first time something is copied or pasted.
 */
import { imagesOf, type ClipboardMedia, type ClipboardPayload } from './clipboard';
import type { ElementJson } from './model';

async function bytesOf(media: ClipboardMedia | undefined): Promise<Blob | null> {
  for (const source of [media?.data, media?.url]) {
    if (!source) continue;
    try {
      const response = await fetch(source);
      if (response.ok) return await response.blob();
    } catch {
      // Try the next way of getting it.
    }
  }
  return null;
}

function extensionFor(type: string): string {
  return ({ 'image/jpeg': 'jpg', 'image/svg+xml': 'svg', 'image/gif': 'gif', 'image/webp': 'webp' } as Record<string, string>)[type] ?? 'png';
}

/**
 * The payload with every picture made this deck's own: kept when this deck
 * already has it, otherwise stored here from its bytes. Elements whose
 * picture cannot be had are left out, and `missing` counts them.
 */
export async function adoptMedia(
  payload: ClipboardPayload,
  urls: Map<string, string>,
  addAttachment: (file: File) => Promise<string>,
): Promise<{ payload: ClipboardPayload; missing: number }> {
  const all = [...(payload.elements ?? []), ...(payload.slides ?? []).flatMap(slide => slide.elements ?? [])];
  const wanted = [...new Set(imagesOf(all))].filter(src => !urls.has(src));
  const renamed = new Map<string, string | null>();
  await Promise.all(wanted.map(async (src) => {
    const blob = await bytesOf(payload.media?.[src]);
    if (!blob || !(blob.type.startsWith('image/') || blob.type === '' || blob.type === 'application/octet-stream')) {
      renamed.set(src, null);
      return;
    }
    const type = blob.type.startsWith('image/') ? blob.type : `image/${src.split('.').pop() === 'jpg' ? 'jpeg' : src.split('.').pop() ?? 'png'}`;
    try {
      renamed.set(src, await addAttachment(new File([blob], `pasted.${extensionFor(type)}`, { type })));
    } catch {
      renamed.set(src, null);
    }
  }));
  let missing = 0;
  const fix = (elements: ElementJson[] | undefined): ElementJson[] | undefined => elements?.flatMap((element) => {
    if (element.type !== 'image' || !element.src || !renamed.has(element.src)) return [element];
    const src = renamed.get(element.src);
    if (!src) {
      missing += 1;
      return [];
    }
    return [{ ...element, src }];
  });
  const adopted: ClipboardPayload = { ...payload, elements: fix(payload.elements) };
  if (payload.slides) adopted.slides = payload.slides.map(slide => ({ ...slide, elements: fix(slide.elements) ?? [] }));
  delete adopted.media;
  return { payload: adopted, missing };
}

/** Pictures and words found in HTML from another app, in the order they come. */
export function readForeignHtml(html: string): { text: string; images: string[] } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const images = [...doc.querySelectorAll('img')]
    .map(image => image.getAttribute('src') ?? '')
    .filter(src => /^(data:image\/|https?:|blob:)/i.test(src));
  for (const image of doc.querySelectorAll('img, style, script, title, meta')) image.remove();
  const blocks: string[] = [];
  const walk = (node: Element) => {
    const block = /^(P|DIV|LI|H[1-6]|TR|BLOCKQUOTE|PRE)$/.test(node.tagName);
    if (block && ![...node.children].some(child => /^(P|DIV|LI|H[1-6]|TR|UL|OL|TABLE|BLOCKQUOTE|PRE)$/.test(child.tagName))) {
      const line = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (line) blocks.push(node.tagName === 'TR' ? [...node.children].map(cell => (cell.textContent ?? '').trim()).join('\t') : line);
      return;
    }
    for (const child of node.children) walk(child);
  };
  walk(doc.body);
  const text = blocks.length ? blocks.join('\n') : (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  return { text, images };
}

/** A picture from another app's HTML as a file, or null when it cannot be read (another site may not allow it). */
export async function imageFromSource(src: string): Promise<File | null> {
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith('image/')) return null;
    return new File([blob], `pasted.${extensionFor(blob.type)}`, { type: blob.type });
  } catch {
    return null;
  }
}

/** Reads a picture into a data URL, so its bytes travel with what is copied. */
export async function dataUrlOf(url: string): Promise<string | null> {
  try {
    const blob = await (await fetch(url)).blob();
    if (blob.size > 12 * 1024 * 1024) return null;
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/** The payload with the bytes of each picture in it, so it pastes into another deck without fetching anything. */
export async function withMediaBytes(payload: ClipboardPayload): Promise<ClipboardPayload> {
  if (!payload.media) return payload;
  const media: Record<string, ClipboardMedia> = {};
  await Promise.all(Object.entries(payload.media).map(async ([src, entry]) => {
    const data = entry.url ? await dataUrlOf(entry.url) : null;
    media[src] = data ? { ...entry, data } : entry;
  }));
  return { ...payload, media };
}
