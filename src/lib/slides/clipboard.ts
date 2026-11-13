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
import { escapeHtml } from '../markup';
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

/** The pictures elements name. */
export function imagesOf(elements: ElementJson[]): string[] {
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
