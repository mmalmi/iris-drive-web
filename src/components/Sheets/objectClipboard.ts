/**
 * Pictures and charts on the clipboard. Other apps get a PNG picture and an
 * <img> in HTML; this spreadsheet recognises its own copy by a token and
 * pastes a true copy, so a chart stays a chart. Another spreadsheet stores
 * the picture again among its own attachments.
 */
import type { SheetController } from '../../lib/sheets/controller.svelte';
import type { CopiedCells } from '../../lib/sheets/controller.svelte';
import { chartsNow, loadCharts } from './chartLoader';
import { addObject, removeObject, type ChartContent, type SheetObject } from '../../lib/sheets/objects';

/** The object this tab copied last, to paste it as itself rather than as a picture. */
let lastCopy: { token: string; sheetId: string; object: SheetObject } | null = null;

function escapeAttr(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** The chart as SVG on a light background, as it goes to other apps. */
function lightChartSvg(ctl: SheetController, chart: ChartContent, width: number, height: number): string {
  const charts = chartsNow();
  if (!charts) return '';
  const { LIGHT_CHART, chartData, chartSvg } = charts;
  const dataSheet = chart.sheet && ctl.book.nameOf(chart.sheet) !== undefined ? ctl.book.sheet(chart.sheet) : ctl.sheet;
  return chartSvg(chart, chartData(dataSheet, ctl.engine, chart), { width, height, theme: LIGHT_CHART, locale: ctl.engine.locale });
}

/** A picture's pixels as PNG, from where it is shown. */
async function picturePng(url: string): Promise<Blob> {
  const blob = await (await fetch(url)).blob();
  if (blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob(png => (png ? resolve(png) : reject(new Error('No picture'))), 'image/png'));
}

async function pngOf(ctl: SheetController, object: SheetObject): Promise<Blob> {
  const { content, placement } = object;
  if (content.kind === 'chart') {
    const { chartPng } = await loadCharts();
    const png = await chartPng(lightChartSvg(ctl, content, placement.width, placement.height), placement.width, placement.height);
    if (!png) throw new Error('The chart could not be drawn');
    return png;
  }
  const url = ctl.media?.urlOf(content.file);
  if (!url) throw new Error('The picture is not loaded yet');
  return picturePng(url);
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Puts a picture or chart on the clipboard; with `cut`, takes it off the sheet. */
export async function copyObject(ctl: SheetController, object: SheetObject, cut = false): Promise<void> {
  const token = Math.random().toString(36).slice(2, 12);
  lastCopy = { token, sheetId: ctl.sheetId, object };
  const png = pngOf(ctl, object);
  const html = png.then(async (blob) => {
    const { dx, dy, width, height } = object.placement;
    const note = escapeAttr(JSON.stringify({ dx, dy, width, height }));
    return new Blob([`<img src="${await dataUrl(blob)}" width="${width}" height="${height}" data-iris-object="${note}" data-iris-token="${token}">`], { type: 'text/html' });
  });
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png, 'text/html': html })]);
  } catch (error) {
    console.error('[Sheets] Could not copy:', error);
    ctl.say('That could not be copied.');
    return;
  }
  if (cut && ctl.canEdit) {
    removeObject(ctl.sheet, object.id);
    ctl.selectedObject = null;
  }
}

/** Pastes this tab's own copied object as itself, when the HTML is that copy. Returns whether it did. */
export function pasteOwnObject(ctl: SheetController, html: string): boolean {
  if (!lastCopy || !ctl.canEdit || !html.includes(`data-iris-token="${lastCopy.token}"`)) return false;
  const { object, sheetId } = lastCopy;
  const sheet = ctl.sheet;
  const { row, col } = ctl.active;
  let content = object.content;
  if (content.kind === 'chart' && sheetId !== sheet.id && !content.sheet) content = { ...content, sheet: sheetId };
  const { dx, dy, width, height } = object.placement;
  const id = addObject(sheet, content, { row: sheet.rows.ids[row], col: sheet.cols.ids[col], dx: Math.min(dx, 8), dy: Math.min(dy, 8), width, height });
  ctl.selectedObject = id;
  return true;
}

/**
 * The <img> for a picture or chart copied along with cells, for the HTML
 * other apps receive. Pictures are read from where the sheet shows them.
 */
export function copiedObjectHtml(ctl: SheetController): (object: CopiedCells['objects'][number]) => string {
  return (object) => {
    const note = escapeAttr(JSON.stringify({ dx: object.dx, dy: object.dy, width: object.width, height: object.height }));
    let src = '';
    if (object.content.kind === 'chart') {
      const svg = lightChartSvg(ctl, object.content, object.width, object.height);
      if (svg) {
        let binary = '';
        for (const byte of new TextEncoder().encode(svg)) binary += String.fromCharCode(byte);
        src = `data:image/svg+xml;base64,${btoa(binary)}`;
      }
    } else {
      const shown = document.querySelector<HTMLImageElement>(`[data-object-id="${object.id}"] img`);
      if (shown?.complete && shown.naturalWidth > 0) {
        const canvas = document.createElement('canvas');
        canvas.width = shown.naturalWidth;
        canvas.height = shown.naturalHeight;
        try {
          canvas.getContext('2d')?.drawImage(shown, 0, 0);
          src = canvas.toDataURL('image/png');
        } catch {
          src = '';
        }
      }
    }
    return src ? `<img src="${src}" width="${object.width}" height="${object.height}" data-iris-object="${note}">` : '';
  };
}
