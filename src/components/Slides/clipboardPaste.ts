/**
 * Making sense of what is pasted: something copied from a deck, pictures and
 * words from another app, a picture alone, or plain text. Loaded the first
 * time something is pasted.
 */
import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
import { WEB_CLIPBOARD_TYPE, payloadFromHtml, readPayload, type ClipboardPayload, type Copied } from '../../lib/slides/clipboard';
import { adoptMedia, imageFromSource, readForeignHtml } from '../../lib/slides/clipboardMedia';
import type { ClipboardOptions, Held } from './clipboardEvents';
import { parseClipboardTable } from '../../lib/sheets/table';

/** Cells copied from a spreadsheet or a web page's table: tab-separated text with more than one cell in a row, small enough for a slide. */
function copiedCells(text: string): string[][] | null {
  if (!text.includes('\t')) return null;
  const rows = parseClipboardTable(text.replace(/[\r\n]+$/, ''));
  if (rows.length > 40 || rows.some(row => row.length > 40)) return null;
  return rows.some(row => row.length > 1) ? rows : null;
}

/** Plain text: cells become a table, anything else a text box. */
function pasteWords(current: SlidesEditorState, text: string): void {
  const cells = copiedCells(text);
  if (cells) current.pasteTable(cells);
  else current.pasteText(text);
}

/** Pastes something copied from a deck, with its pictures made this deck's own first. */
export async function pastePayload(current: SlidesEditorState, payload: ClipboardPayload, options: ClipboardOptions): Promise<void> {
  const { payload: own, missing } = await adoptMedia(payload, options.urls, options.addAttachment);
  current.paste(own);
  if (missing) current.notice = missing === 1 ? 'One picture could not be copied.' : `${missing} pictures could not be copied.`;
}

/**
 * Pastes words and pictures from another app: the words as a text box on
 * the left, the pictures one under the other on the right; alone, either
 * takes the middle.
 */
async function pasteForeign(current: SlidesEditorState, found: { text: string; images: string[] }, files: File[]): Promise<void> {
  const both = !!found.text && found.images.length > 0;
  if (found.text) current.pasteText(found.text, both ? { x: 80, y: 120, w: 520 } : undefined);
  const read = await Promise.all(found.images.map(async (src, index) => await imageFromSource(src) ?? files[index] ?? null));
  const pictures = read.filter((file): file is File => !!file);
  const room = { w: both ? 520 : 760, h: Math.max(120, Math.floor((both ? 560 : 520) / Math.max(1, pictures.length))) };
  for (const [index, file] of pictures.entries()) {
    const at = both || pictures.length > 1 ? { x: both ? 940 : 640, y: 80 + room.h * (index + 0.5) } : undefined;
    await current.addImage(file, at, room);
  }
  if (read.length > pictures.length) current.notice = 'Some pictures could not be read from where they were copied.';
}

/** What a paste event held. */
export async function pasteHeld(current: SlidesEditorState, held: Held, copied: Copied | null, options: ClipboardOptions): Promise<void> {
  const payload = readPayload(held.own) ?? (held.html ? payloadFromHtml(held.html) : null);
  if (payload) return pastePayload(current, payload, options);
  const foreign = held.html ? readForeignHtml(held.html) : null;
  if (foreign && foreign.images.length && (foreign.text || !held.files.length)) return pasteForeign(current, foreign, held.files);
  if (held.files.length) {
    for (const file of held.files) await current.addImage(file);
    return;
  }
  if (!held.text) return;
  if (copied && (copied.text || ' ') === held.text) return pastePayload(current, copied.payload, options);
  pasteWords(current, held.text);
}

/** What the clipboard holds, read when the browser allows it; otherwise what was last copied here. */
export async function pasteFromClipboard(current: SlidesEditorState, copied: Copied | null, options: ClipboardOptions): Promise<void> {
  let text: string | null = null;
  try {
    for (const item of await navigator.clipboard.read()) {
      const own = item.types.includes(WEB_CLIPBOARD_TYPE) ? await (await item.getType(WEB_CLIPBOARD_TYPE)).text() : '';
      const html = item.types.includes('text/html') ? await (await item.getType('text/html')).text() : '';
      const payload = readPayload(own) ?? (html ? payloadFromHtml(html) : null);
      if (payload) return await pastePayload(current, payload, options);
      const foreign = html ? readForeignHtml(html) : null;
      if (foreign?.images.length && foreign.text) return await pasteForeign(current, foreign, []);
      const image = item.types.find(type => type.startsWith('image/'));
      if (image) {
        const blob = await item.getType(image);
        await current.addImage(new File([blob], `pasted.${image.split('/')[1] ?? 'png'}`, { type: image }));
        return;
      }
      if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
    }
  } catch {
    text = await navigator.clipboard?.readText?.().catch(() => null) ?? null;
  }
  if (copied && (text === null || text === (copied.text || ' '))) await pastePayload(current, copied.payload, options);
  else if (text) pasteWords(current, text);
}
