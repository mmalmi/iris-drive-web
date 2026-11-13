import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { fillFromFile, isBlank } from '../src/components/Sheets/sheetFiles';
import { SheetController } from '../src/lib/sheets/controller.svelte';

function blank(): SheetController {
  const ctl = new SheetController(new Y.Doc());
  ctl.start(true);
  return ctl;
}

describe('opening a file into a new spreadsheet', () => {
  it('puts a CSV file in place of the empty first sheet, as nothing to undo', async () => {
    const ctl = blank();
    expect(isBlank(ctl)).toBe(true);
    const filled = await fillFromFile(ctl, 'Tasks.csv', new TextEncoder().encode('Task,Done\nWrite,1\n'));
    expect(filled).toBe(true);
    expect(ctl.book.sheets.map(sheet => sheet.name)).toEqual(['Tasks']);
    expect(ctl.engine.textAt(ctl.sheet, 1, 0)).toBe('Write');
    expect(ctl.canUndo).toBe(false);
    expect(isBlank(ctl)).toBe(false);
  });

  it('says no for a file that is not a workbook and leaves the spreadsheet as it was', async () => {
    const ctl = blank();
    const filled = await fillFromFile(ctl, 'Broken.xlsx', new Uint8Array([1, 2, 3]));
    expect(filled).toBe(false);
    expect(ctl.book.sheets).toHaveLength(1);
    expect(ctl.notice).toContain('could not be read');
  });
});
