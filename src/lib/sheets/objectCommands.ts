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

/** Adds a chart of the selected cells beside them and selects it. Returns its id. */
export function insertChart(ctl: SheetController, type: ChartType = 'column'): string | null {
  if (!ctl.canEdit) return null;
  const source = chartSource(ctl);
  if (!source) {
    ctl.say('Select the cells to show in a chart.');
    return null;
  }
  const sheet = ctl.sheet;
  const content: ChartContent = { kind: 'chart', type, title: '', legend: true, ...rectIds(sheet, source) };
  const col = Math.min(source.c2 + 1, sheet.cols.length - 1);
  const id = addObject(sheet, content, {
    row: sheet.rows.ids[source.r1],
    col: sheet.cols.ids[col],
    dx: col > source.c2 ? 16 : 0,
    dy: 0,
    width: CHART_WIDTH,
    height: CHART_HEIGHT,
  });
  ctl.selectedObject = id;
  return id;
}
