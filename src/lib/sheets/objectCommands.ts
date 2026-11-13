/** Making charts, each one undo step. Pictures come in through pasting.ts. */
import type { Rect } from './address';
import type { SheetController } from './controller.svelte';
import { dataRegion } from './dataCommands';
import { addObject, rectIds, type ChartContent, type ChartType } from './objects';

export const CHART_WIDTH = 440;
export const CHART_HEIGHT = 280;

/** The cells a new chart would show: the selection, or the table around the active cell. */
export function chartSource(ctl: SheetController): Rect | null {
  const rect = ctl.selection;
  const one = rect.r1 === rect.r2 && rect.c1 === rect.c2;
  if (!one) {
    // Whole columns are shown as far as they are filled.
    const used = ctl.sheet.usedRect();
    if (ctl.scope !== 'cells' && used) {
      return { ...rect, r2: Math.min(rect.r2, Math.max(rect.r1, used.r2)), c2: Math.min(rect.c2, Math.max(rect.c1, used.c2)) };
    }
    return rect;
  }
  return dataRegion(ctl);
}

/**
 * Adds a chart of the selected cells beside them and selects it; with
 * `room` (the width of the grid's cells in view) less than a chart is wide,
 * as on a phone, below them and as wide as fits. Returns its id.
 */
export function insertChart(ctl: SheetController, type: ChartType = 'column', room = Infinity): string | null {
  if (!ctl.canEdit) return null;
  const source = chartSource(ctl);
  if (!source) {
    ctl.say('Select the cells to show in a chart.');
    return null;
  }
  const sheet = ctl.sheet;
  const content: ChartContent = { kind: 'chart', type, title: '', legend: true, ...rectIds(sheet, source) };
  const narrow = room < CHART_WIDTH * 1.6;
  // Beside the cells, past any filled ones to their right, so it hides nothing.
  let right = source.c2;
  for (let row = source.r1; row <= Math.min(source.r2, source.r1 + 30); row += 1) {
    for (let col = right + 1; col < Math.min(sheet.cols.length, right + 30); col += 1) if (!sheet.isEmpty(row, col)) right = col;
  }
  const col = narrow ? source.c1 : Math.min(right + 1, sheet.cols.length - 1);
  const row = narrow ? Math.min(source.r2 + 2, sheet.rows.length - 1) : source.r1;
  const width = narrow ? Math.max(160, Math.min(CHART_WIDTH, room - 16)) : CHART_WIDTH;
  const id = addObject(sheet, content, {
    row: sheet.rows.ids[row],
    col: sheet.cols.ids[col],
    dx: !narrow && col > right ? 16 : 0,
    dy: 0,
    width,
    height: narrow ? Math.round(width * 0.7) : CHART_HEIGHT,
  });
  ctl.selectedObject = id;
  return id;
}
