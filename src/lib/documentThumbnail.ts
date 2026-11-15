/** Read one saved revision into a temporary Y.Doc. Only the rendered picture leaves this module. */
import { LinkType, type CID } from '@hashtree/core';
import * as Y from 'yjs';
import { getTree } from '../store';
import type { DocumentKind } from './documentNames';
import { listDocumentUpdates } from './yjs/versionHistory';
import { richTextToPlain } from './slides/richTextData';

const WIDTH = 480;
const HEIGHT = 288;
const MAX_UPDATE_BYTES = 2 * 1024 * 1024;
type Context = CanvasRenderingContext2D;

export async function documentThumbnail(cid: CID, kind: DocumentKind, signal: AbortSignal): Promise<Blob> {
  const tree = getTree();
  const files = await listDocumentUpdates(tree, cid, signal);
  if (files.length > 160 || files.reduce((sum, file) => sum + file.size, 0) > MAX_UPDATE_BYTES) {
    throw new Error('Document exceeds grid preview budget');
  }
  const doc = new Y.Doc();
  try {
    let remaining = MAX_UPDATE_BYTES;
    for (const file of files) {
      signal.throwIfAborted();
      const update = await tree.readFile(file.cid, { maxBytes: remaining });
      if (!update || update.length > remaining) throw new Error('Document update unavailable');
      remaining -= update.length;
      Y.applyUpdate(doc, update);
    }
    signal.throwIfAborted();
    if (kind === 'slides') return await firstSlide(doc, cid, signal);
    const canvas = document.createElement('canvas');
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    if (kind === 'document') drawDocument(ctx, doc);
    else if (kind === 'form') await drawForm(ctx, doc);
    else await drawSheet(ctx, doc);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('Could not draw page')), 'image/webp', 0.9));
  } finally {
    doc.destroy();
  }
}

/** Wrap only the lines that will fit on this page. */
function lines(ctx: Context, text: string, x: number, y: number, step: number, count: number): number {
  const words = text.trim().slice(0, 1600).split(/\s+/);
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (line && ctx.measureText(next).width > WIDTH - 2 * x) {
      ctx.fillText(line, x, y);
      y += step;
      if (--count === 0 || y >= HEIGHT) return y;
      line = word;
    } else line = next;
  }
  if (line) ctx.fillText(line, x, y);
  return y + step;
}

function drawDocument(ctx: Context, doc: Y.Doc): void {
  const body = doc.getXmlFragment('default');
  let y = 40;
  ctx.fillStyle = '#202124';
  for (let i = 0; i < body.length && y < HEIGHT; i++) {
    const block = body.get(i);
    if (!(block instanceof Y.XmlElement)) continue;
    const heading = block.nodeName === 'heading';
    ctx.font = heading ? 'bold 25px sans-serif' : '16px sans-serif';
    for (const paragraph of richTextToPlain(block).slice(0, 2000).split('\n')) {
      y = lines(ctx, paragraph, 30, y, heading ? 32 : 23, 12);
      if (y >= HEIGHT) break;
    }
    y += 5;
  }
}

async function drawForm(ctx: Context, doc: Y.Doc): Promise<void> {
  const { readForm, hasOptions } = await import('./forms/model');
  const form = readForm(doc);
  ctx.fillStyle = '#673ab7';
  ctx.fillRect(0, 0, WIDTH, 9);
  let y = 43;
  ctx.fillStyle = '#342943';
  ctx.font = '16px sans-serif';
  if (form.description) y = lines(ctx, form.description, 26, y, 22, 2) + 15;
  for (const question of form.questions) {
    if (y >= HEIGHT) break;
    ctx.fillStyle = '#26212c';
    ctx.font = '600 18px sans-serif';
    y = lines(ctx, question.title || 'Untitled question', 26, y, 23, 2) + 4;
    ctx.strokeStyle = '#9f96a8';
    if (hasOptions(question.type)) {
      ctx.font = '15px sans-serif';
      for (const option of question.options.slice(0, 2)) {
        if (question.type === 'checkboxes') ctx.strokeRect(27, y - 11, 11, 11);
        else {
          ctx.beginPath();
          ctx.arc(33, y - 5, 6, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.fillText(option.slice(0, 80), 50, y);
        y += 23;
      }
    } else {
      ctx.fillStyle = '#dedbe2';
      ctx.fillRect(26, y + 3, 245, 1);
      y += 15;
    }
    y += 21;
  }
}

async function drawSheet(ctx: Context, doc: Y.Doc): Promise<void> {
  const { Book, decodeRaw, isFormula } = await import('./sheets/model');
  const { formatValue } = await import('./sheets/format');
  const { toDisplay } = await import('./sheets/refs');
  const { columnName } = await import('./sheets/address');
  const book = new Book(doc);
  try {
    if (book.isEmpty) return;
    const sheet = book.sheet(book.sheets[0].id);
    const hiddenRows = sheet.hidden('row');
    const hiddenCols = sheet.hidden('col');
    const rowHeight = 27;
    const colWidth = 110;
    const gutter = 36;
    ctx.fillStyle = '#edf5ef';
    ctx.fillRect(0, 0, WIDTH, rowHeight);
    ctx.fillRect(0, 0, gutter, HEIGHT);
    let y = rowHeight;
    for (let row = 0; row < sheet.rows.length && y < HEIGHT; row++) {
      if (hiddenRows.has(row)) continue;
      ctx.fillStyle = '#54655a';
      ctx.font = '14px sans-serif';
      ctx.fillText(String(row + 1), 10, y + 19);
      let x = gutter;
      for (let col = 0; col < sheet.cols.length && x < WIDTH; col++) {
        if (hiddenCols.has(col)) continue;
        if (y === rowHeight) {
          ctx.fillStyle = '#54655a';
          ctx.font = '14px sans-serif';
          ctx.fillText(columnName(col), x + colWidth / 2 - 5, 19);
        }
        const style = sheet.styleAt(row, col);
        const raw = sheet.rawAt(row, col);
        // Showing a formula in A1 notation avoids recalculating the whole workbook for a tile.
        const text = isFormula(raw) ? toDisplay(raw, book, sheet)
          : formatValue(decodeRaw(raw), style.nf, book.numberLocale);
        if (style.bg) {
          ctx.fillStyle = style.bg;
          ctx.fillRect(x, y, colWidth, rowHeight);
        }
        ctx.strokeStyle = '#d8dedb';
        ctx.strokeRect(x + 0.5, y + 0.5, colWidth, rowHeight);
        ctx.save();
        ctx.beginPath();
        ctx.rect(x + 3, y, colWidth - 6, rowHeight);
        ctx.clip();
        ctx.fillStyle = style.c ?? '#26332b';
        ctx.font = style.b ? 'bold 15px sans-serif' : '15px sans-serif';
        ctx.fillText(text.slice(0, 160), x + 6, y + 19);
        ctx.restore();
        x += colWidth;
      }
      y += rowHeight;
    }
  } finally { book.destroy(); }
}

async function firstSlide(doc: Y.Doc, cid: CID, signal: AbortSignal): Promise<Blob> {
  const { Deck, SLIDE_WIDTH } = await import('./slides/model');
  const { themeById } = await import('./slides/themes');
  const { snapshotPng } = await import('./slides/snapshot');
  const { default: SlideView } = await import('../components/Slides/SlideView.svelte');
  const { flushSync, mount, unmount } = await import('svelte');
  const deck = new Deck(doc);
  const slide = deck.readSlides()[0];
  if (!slide) throw new Error('No slides');
  const urls = new Map<string, string>();
  const images = new Set(slide.elements.flatMap(el => el.type === 'image' && el.src ? [el.src] : []));
  if (images.size) {
    const { ATTACHMENTS_DIRECTORY } = await import('./yjs/imageAttachments');
    const { getNhashFileUrl } = await import('./mediaUrl');
    const tree = getTree();
    const folder = (await tree.listDirectory(cid, signal)).find(e => e.name === ATTACHMENTS_DIRECTORY && e.type === LinkType.Dir);
    if (folder) {
      let remaining = MAX_UPDATE_BYTES;
      for (const file of await tree.listDirectory(folder.cid, signal)) {
        if (!images.has(file.name) || file.type === LinkType.Dir || file.size > remaining) continue;
        urls.set(file.name, getNhashFileUrl(file.cid, file.name));
        remaining -= file.size;
      }
    }
  }
  signal.throwIfAborted();
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none';
  holder.inert = true;
  document.body.append(holder);
  const view = mount(SlideView, { target: holder, props: { slide, theme: themeById(deck.theme), urls, width: WIDTH } });
  try {
    flushSync();
    return await snapshotPng(holder.querySelector<HTMLElement>('.slide-surface')!, { scale: WIDTH / SLIDE_WIDTH, signal });
  } finally {
    await unmount(view);
    holder.remove();
  }
}
