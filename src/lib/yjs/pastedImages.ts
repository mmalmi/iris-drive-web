/**
 * Pictures that come into a document by pasting or dropping.
 *
 * A document shows only pictures it holds itself, as files in its own
 * `attachments` folder (`attachments:<name>` in the text). Pasted HTML from a
 * web page, another app or another document points somewhere else: a web
 * address, a `data:` URL, or this app's own address for a picture of another
 * document. Each such picture is fetched and stored in this document, and the
 * text is pointed at the stored copy. A picture that cannot be fetched is left
 * out rather than linked to a place other people may not reach.
 */
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { ATTACHMENT_SCHEME } from './imageAttachments';

/** Largest picture a document takes. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Attachment names are generated (`<time>-<random>.<ext>`); nothing else is rewritten. */
const COPIED_ATTACHMENT = /src="attachments:([a-z0-9][a-z0-9._-]*)"/gi;

/**
 * Copied HTML names pictures by where this browser can load them, so that
 * another document or another app can fetch them, and keeps the name.
 */
export function rewriteCopiedHtml(html: string, urlFor: (filename: string) => string | undefined, base: string): string {
  return html.replace(COPIED_ATTACHMENT, (whole, filename: string) => {
    const url = urlFor(filename);
    if (!url) return whole;
    const absolute = new URL(url, base).href;
    return `src="${absolute.replace(/"/g, '&quot;')}" data-iris-attachment="${filename}"`;
  });
}

/** True for a picture this document does not hold itself. */
export function isForeignImageSrc(src: unknown): src is string {
  return typeof src === 'string' && src.length > 0 && !src.startsWith(ATTACHMENT_SCHEME);
}

/** The image files on a clipboard or a drop, in order. */
export function imageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of data.items ?? []) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0) {
    for (const file of data.files ?? []) if (file.type.startsWith('image/')) files.push(file);
  }
  return files;
}

/**
 * Whether pasted HTML is only a wrapper around the pictures that also come as
 * files, as when a browser copies one image. The files are the exact bytes and
 * are used instead.
 */
export function htmlIsOnlyPictures(html: string | undefined): boolean {
  if (!html) return true;
  const text = html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
  return text.length === 0;
}

function nameFor(src: string, type: string): string {
  const extension = type.split('/')[1]?.replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'png';
  const last = src.startsWith('data:') ? '' : (src.split(/[?#]/)[0]!.split('/').pop() ?? '');
  const stem = last.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
  return `${stem || 'pasted'}.${extension}`;
}

async function fetchPicture(src: string): Promise<File | null> {
  try {
    const response = await fetch(src, { credentials: 'omit' });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (!blob.type.startsWith('image/') || blob.size === 0 || blob.size > MAX_IMAGE_BYTES) return null;
    return new File([blob], nameFor(src, blob.type), { type: blob.type });
  } catch {
    return null;
  }
}

export interface ForeignImageImport {
  /** Stores a picture in this document; resolves to its attachment name. */
  store: (file: File) => Promise<string>;
  /** Told how many pictures could not be brought in. */
  onMissing?: (count: number) => void;
}

function foreignSources(doc: ProseMirrorNode): Set<string> {
  const sources = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name === 'image' && isForeignImageSrc(node.attrs.src)) sources.add(node.attrs.src);
  });
  return sources;
}

/** Points every picture with `src` at `next`, or removes it when `next` is null. */
function replaceSource(editor: Editor, src: string, next: string | null): void {
  const positions: Array<{ pos: number; node: ProseMirrorNode }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'image' && node.attrs.src === src) positions.push({ pos, node });
  });
  if (positions.length === 0) return;
  const tr = editor.state.tr;
  for (const { pos, node } of positions.reverse()) {
    if (next) tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: next });
    else tr.delete(pos, pos + node.nodeSize);
  }
  tr.setMeta('addToHistory', false);
  editor.view.dispatch(tr);
}

/**
 * Brings every picture the document does not hold into it. Runs after a paste
 * or drop on this device only, so a picture is stored once, by the device
 * that pasted it.
 */
export async function importForeignImages(editor: Editor, options: ForeignImageImport): Promise<void> {
  let missing = 0;
  for (const src of foreignSources(editor.state.doc)) {
    const file = await fetchPicture(src);
    if (editor.isDestroyed) return;
    let stored: string | null = null;
    if (file) {
      try {
        stored = `${ATTACHMENT_SCHEME}${await options.store(file)}`;
      } catch {
        stored = null;
      }
    }
    if (editor.isDestroyed) return;
    if (!stored) missing += 1;
    replaceSource(editor, src, stored);
  }
  if (missing > 0) options.onMissing?.(missing);
}
