/** Lets automated tests find cells on the canvas and read what they show. Only installed in test mode. */
import type { SheetController } from '../../lib/sheets/controller.svelte';
import { columnX, rowY, type Viewport } from '../../lib/sheets/layout';

export function installTestHandle(
  controller: () => SheetController,
  place: () => { view: Viewport; canvas: HTMLCanvasElement } | null,
): void {
  (window as unknown as { __sheet?: unknown }).__sheet = {
    get ctl() { return controller(); },
    text: (row: number, col: number) => controller().engine.textAt(controller().sheet, row, col),
    style: (row: number, col: number) => ({ ...controller().sheet.styleAt(row, col) }),
    link: (row: number, col: number) => controller().engine.linkAt(controller().sheet, row, col),
    box: (row: number, col: number) => {
      const where = place();
      if (!where) return null;
      const bounds = where.canvas.getBoundingClientRect();
      return {
        x: bounds.left + columnX(where.view, col),
        y: bounds.top + rowY(where.view, row),
        width: where.view.cols.size(col),
        height: where.view.rows.size(row),
        headerWidth: where.view.headerWidth,
        left: bounds.left,
        top: bounds.top,
      };
    },
  };
}
