/**
 * Pictures and charts on the clipboard. Other apps get a PNG picture and an
 * <img> in HTML; this spreadsheet recognises its own copy by a token and
 * pastes a true copy, so a chart stays a chart. Another spreadsheet stores
 * the picture again among its own attachments.
 */
import type { SheetController } from '../../lib/sheets/controller.svelte';
import type { CopiedCells } from '../../lib/sheets/controller.svelte';
import { chartsNow, loadCharts } from './chartLoader';
import { pngAt } from '../../lib/clipboardPng';
import { escapeHtml } from '../../lib/markup';
import { addObject, removeObject, type ChartContent, type SheetObject } from '../../lib/sheets/objects';

/** The object this tab copied last, to paste it as itself rather than as a picture. */
let lastCopy: { token: string; sheetId: string; object: SheetObject } | null = null;

/** The chart as SVG on a light background, as it goes to other apps. */
function lightChartSvg(ctl: SheetController, chart: ChartContent, width: number, height: number): string {
  const charts = chartsNow();
  if (!charts) return '';
  const { LIGHT_CHART, chartData, chartSvg } = charts;
  const dataSheet = chart.sheet && ctl.book.nameOf(chart.sheet) !== undefined ? ctl.book.sheet(chart.sheet) : ctl.sheet;
  return chartSvg(chart, chartData(dataSheet, ctl.engine, chart), { width, height, theme: LIGHT_CHART, locale: ctl.engine.locale });
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
  return pngAt(url);
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
    const note = escapeHtml(JSON.stringify({ dx, dy, width, height }));
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

/** "Copy image": only the picture, as PNG, for apps that would take the HTML over it. */
export function copyObjectImage(ctl: SheetController, object: SheetObject): void {
  if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function') {
    ctl.say('This browser cannot copy pictures.');
    return;
  }
  navigator.clipboard.write([new ClipboardItem({ 'image/png': pngOf(ctl, object) })]).catch((error: unknown) => {
    console.error('[Sheets] Could not copy the image:', error);
    ctl.say('That image could not be copied.');
  });
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
    const note = escapeHtml(JSON.stringify({ dx: object.dx, dy: object.dy, width: object.width, height: object.height }));
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
