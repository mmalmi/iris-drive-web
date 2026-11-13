/**
 * Copying and pasting slides and what is on them, with their pictures.
 *
 * What is copied goes on the clipboard three ways at once: our own format,
 * for pasting here or into another deck in this or another tab; HTML, which
 * carries the same thing for browsers that keep only common formats and
 * shows text and pictures to other apps; and plain text. Where the browser
 * lets a page write it, a picture of what was copied goes along too.
 *
 * Pictures belong to the deck they are in, so copied elements carry where
 * their pictures can be had (and, where there is time to read them, the
 * pictures themselves). Pasted into another deck, each picture is stored
 * there anew; a pasted element never points at another deck's file.
 */
import {
  elementToJson,
  richTextToPlain,
  type ElementJson,
  type Slide,
  type SlideElement,
} from './model';
import type { Transition } from './motion';
import type { SlidesEditorState } from './editorState.svelte';

export const CLIPBOARD_TYPE = 'application/x-iris-slides';
/** The same, as a custom format the asynchronous clipboard can carry between tabs. */
export const WEB_CLIPBOARD_TYPE = `web ${CLIPBOARD_TYPE}`;
const HTML_ATTRIBUTE = 'data-iris-slides';

export interface ClipboardSlide {
  layout: string;
  background?: string;
  transition?: Transition;
  build?: boolean;
  notes: string;
  elements: ElementJson[];
}

/** Where a copied picture can be had: its bytes as a data URL, or a URL to fetch it from. */
export interface ClipboardMedia {
  data?: string;
  url?: string;
}

export interface ClipboardPayload {
  kind: 'iris-slides';
  version: 1;
  elements?: ElementJson[];
  slides?: ClipboardSlide[];
  /** The pictures the elements name, by their name in the deck they were copied from. */
  media?: Record<string, ClipboardMedia>;
}

export interface Copied {
  payload: ClipboardPayload;
  text: string;
  /** Slides as drawn, when slides were copied; otherwise the slide the elements are on. */
  slides: Slide[];
  /** The ids of the elements copied, when elements were. */
  elementIds: string[] | null;
}

function imagesOf(elements: ElementJson[]): string[] {
  return elements.filter(element => element.type === 'image' && typeof element.src === 'string').map(element => element.src!);
}

/** What the slide strip or the canvas has picked, ready to put on the clipboard; null when nothing is. */
export function copyPayload(state: SlidesEditorState, urls?: Map<string, string>): Copied | null {
  let copied: Copied | null = null;
  if (state.area === 'strip') {
    const slides = state.slides.filter(slide => state.pickedSlides.includes(slide.id));
    if (slides.length === 0) return null;
    copied = {
      payload: {
        kind: 'iris-slides',
        version: 1,
        slides: slides.map(slide => ({
          layout: slide.layout,
          ...(slide.background ? { background: slide.background } : {}),
          ...(slide.transition ? { transition: slide.transition } : {}),
          ...(slide.build ? { build: true } : {}),
          notes: slide.notes?.toString() ?? '',
          elements: slide.elements.map(elementToJson),
        })),
      },
      text: slides.map(slide => plainOf(slide.elements)).join('\n\n'),
      slides,
      elementIds: null,
    };
  } else if (state.selection.length > 0 && state.current) {
    copied = {
      payload: { kind: 'iris-slides', version: 1, elements: state.selected.map(elementToJson) },
      text: plainOf(state.selected),
      slides: [state.current],
      elementIds: state.selected.map(element => element.id),
    };
  }
  if (!copied) return null;
  const all = [...(copied.payload.elements ?? []), ...(copied.payload.slides ?? []).flatMap(slide => slide.elements)];
  const media: Record<string, ClipboardMedia> = {};
  for (const src of imagesOf(all)) {
    const url = urls?.get(src);
    media[src] = url ? { url: new URL(url, window.location.href).href } : {};
  }
  if (Object.keys(media).length) copied.payload.media = media;
  return copied;
}

function plainOf(elements: SlideElement[]): string {
  const lines: string[] = [];
  for (const element of elements) {
    if (element.table) {
      for (const row of element.table.rows) {
        lines.push(element.table.cols.map(col => richTextToPlain(element.table!.cells.get(`${row.id}:${col.id}`)?.content).replace(/\n/g, ' ')).join('\t'));
      }
    } else {
      const text = richTextToPlain(element.content);
      if (text) lines.push(text);
    }
  }
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

function fromBase64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return new TextDecoder().decode(bytes);
}

/**
 * The HTML put on the clipboard: what was copied, readable by other apps as
 * text and pictures, with our own format kept in an attribute.
 */
export function clipboardHtml(payload: ClipboardPayload, text: string, picture?: string): string {
  const body = picture
    ? `<img src="${escapeHtml(picture)}" alt="${escapeHtml(text.split('\n')[0] ?? '')}">`
    : text.split('\n').map(line => `<p>${escapeHtml(line) || '<br>'}</p>`).join('');
  return `<div ${HTML_ATTRIBUTE}="${toBase64(JSON.stringify(payload))}">${body}</div>`;
}

/** Our own format, when the HTML on the clipboard came from here. */
export function payloadFromHtml(html: string): ClipboardPayload | null {
  const match = new RegExp(`${HTML_ATTRIBUTE}="([A-Za-z0-9+/=]+)"`).exec(html);
  return match ? readPayload(fromBase64(match[1]!)) : null;
}

export function readPayload(raw: string | null | undefined): ClipboardPayload | null {
  if (!raw) return null;
  try {
    const payload = JSON.parse(raw) as ClipboardPayload;
    return payload?.kind === 'iris-slides' ? payload : null;
  } catch {
    return null;
  }
}

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
