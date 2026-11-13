// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parseRectName } from '../src/lib/sheets/address';
import { LIGHT_CHART, chartData, chartSvg, niceTicks } from '../src/lib/sheets/chart';
import { copiedHtml, copySelection, pasteText } from '../src/lib/sheets/commands';
import { SheetController } from '../src/lib/sheets/controller.svelte';
import { readHtmlTable, styleFromCss } from '../src/lib/sheets/htmlPaste';
import { addObject, changeObject, listObjects, placeObject, removeObject, type ChartContent } from '../src/lib/sheets/objects';
import { insertChart } from '../src/lib/sheets/objectCommands';
import { pasteTable } from '../src/lib/sheets/pasting';

function open(doc = new Y.Doc()) {
  const ctl = new SheetController(doc);
  ctl.start(true);
  const select = (name: string) => {
    const rect = parseRectName(name);
    if (!rect) throw new Error(`Bad name ${name}`);
    ctl.setSelection({ row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 });
  };
  const type = (name: string, text: string) => {
    select(name);
    ctl.startEdit({ text });
    ctl.commitEdit();
  };
  const show = (name: string) => {
    const rect = parseRectName(name);
    return rect ? ctl.engine.textAt(ctl.sheet, rect.r1, rect.c1) : '';
  };
  return { ctl, doc, select, type, show };
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'stored');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'stored');
}

function salesTable(type: (name: string, text: string) => void): void {
  [['A1', 'Month'], ['B1', 'North'], ['C1', 'South'], ['A2', 'Jan'], ['B2', '120'], ['C2', '80'], ['A3', 'Feb'], ['B3', '150'], ['C3', '95']]
    .forEach(([name, text]) => type(name, text));
}

describe('pictures and charts over the grid', () => {
  it('stay with their cells when rows are added above, and near them when their row goes', () => {
    const { ctl } = open();
    const sheet = ctl.sheet;
    const id = addObject(sheet, { kind: 'picture', file: 'a.png', width: 100, height: 50 }, { row: sheet.rows.ids[4], col: sheet.cols.ids[2], dx: 5, dy: 6, width: 100, height: 50 });
    sheet.insert('row', 0, 2);
    expect(listObjects(sheet)[0]).toMatchObject({ id, row: 6, col: 2 });
    sheet.remove('row', 6, 1);
    expect(listObjects(sheet)[0]).toMatchObject({ id, row: 6, col: 2 });
  });

  it('a chart moved on one device and retitled on another keeps both changes', () => {
    const one = open();
    const two = open(new Y.Doc());
    salesTable(one.type);
    one.select('A1:C3');
    const id = insertChart(one.ctl) as string;
    sync(one.doc, two.doc);
    const placed = listObjects(two.ctl.sheet)[0];
    placeObject(one.ctl.sheet, id, { ...placed.placement, row: one.ctl.sheet.rows.ids[10] });
    changeObject(two.ctl.sheet, id, { ...(placed.content as ChartContent), title: 'Sales', type: 'line' });
    sync(one.doc, two.doc);
    for (const side of [one, two]) {
      const chart = listObjects(side.ctl.sheet)[0];
      expect(chart.row).toBe(10);
      expect(chart.content).toMatchObject({ title: 'Sales', type: 'line' });
    }
  });

  it('a move that crosses a delete leaves nothing behind', () => {
    const one = open();
    const two = open(new Y.Doc());
    const sheet = one.ctl.sheet;
    const id = addObject(sheet, { kind: 'picture', file: 'a.png', width: 10, height: 10 }, { row: sheet.rows.ids[0], col: sheet.cols.ids[0], dx: 0, dy: 0, width: 40, height: 40 });
    sync(one.doc, two.doc);
    removeObject(one.ctl.sheet, id);
    placeObject(two.ctl.sheet, id, { ...listObjects(two.ctl.sheet)[0].placement, dx: 30 });
    sync(one.doc, two.doc);
    expect(listObjects(one.ctl.sheet)).toEqual([]);
    expect(listObjects(two.ctl.sheet)).toEqual([]);
  });

  it('adding, moving and deleting are undone one step at a time', () => {
    const { ctl } = open();
    const sheet = ctl.sheet;
    const id = addObject(sheet, { kind: 'picture', file: 'a.png', width: 10, height: 10 }, { row: sheet.rows.ids[0], col: sheet.cols.ids[0], dx: 0, dy: 0, width: 40, height: 40 });
    placeObject(sheet, id, { ...listObjects(sheet)[0].placement, dx: 30 });
    removeObject(sheet, id);
    expect(listObjects(sheet)).toHaveLength(0);
    ctl.undo();
    expect(listObjects(sheet)[0].placement.dx).toBe(30);
    ctl.undo();
    expect(listObjects(sheet)[0].placement.dx).toBe(0);
    ctl.undo();
    expect(listObjects(sheet)).toHaveLength(0);
  });

  it('a chart reads names from the first row and labels from the first column, and follows the cells', () => {
    const { ctl, type, select } = open();
    salesTable(type);
    select('A1:C3');
    insertChart(ctl);
    const chart = listObjects(ctl.sheet)[0].content as ChartContent;
    expect(chartData(ctl.sheet, ctl.engine, chart)).toEqual({
      labels: ['Jan', 'Feb'],
      series: [{ name: 'North', values: [120, 150] }, { name: 'South', values: [80, 95] }],
      format: undefined,
    });
    type('B2', '200');
    expect(chartData(ctl.sheet, ctl.engine, chart)?.series[0].values).toEqual([200, 150]);
    expect(chartData(ctl.sheet, ctl.engine, { ...chart, byRow: true })?.series.map(s => s.name)).toEqual(['Jan', 'Feb']);
    const svg = chartSvg({ ...chart, title: 'Sales <2026>' }, chartData(ctl.sheet, ctl.engine, chart), { width: 400, height: 260, theme: LIGHT_CHART, locale: ctl.engine.locale });
    expect(svg).toContain('Sales &lt;2026&gt;');
    expect(svg).toContain('North');
    for (const type of ['bar', 'line', 'pie'] as const) {
      expect(chartSvg({ ...chart, type }, chartData(ctl.sheet, ctl.engine, chart), { width: 400, height: 260, theme: LIGHT_CHART, locale: ctl.engine.locale })).toContain('<title>');
    }
  });

  it('axis numbers are round', () => {
    expect(niceTicks(0, 150)).toEqual([0, 50, 100, 150]);
    expect(niceTicks(-20, 95)).toEqual([-25, 0, 25, 50, 75, 100]);
  });
});

describe('copying and pasting', () => {
  it('our own copy brings merged cells and the pictures over them along', () => {
    const { ctl, type, select, show } = open();
    type('A1', 'Title');
    select('A1:B1');
    ctl.sheet.merge(ctl.selection);
    const sheet = ctl.sheet;
    addObject(sheet, { kind: 'picture', file: 'logo.png', width: 10, height: 10 }, { row: sheet.rows.ids[1], col: sheet.cols.ids[1], dx: 4, dy: 2, width: 40, height: 40 });
    select('A1:C3');
    const text = copySelection(ctl);
    select('E10');
    pasteText(ctl, text);
    expect(show('E10')).toBe('Title');
    expect(sheet.mergeAt(9, 4)).toEqual(expect.objectContaining({ r1: 9, c1: 4, r2: 9, c2: 5 }));
    const pictures = listObjects(sheet);
    expect(pictures).toHaveLength(2);
    expect(pictures[1]).toMatchObject({ row: 10, col: 5, placement: { dx: 4, dy: 2 } });
  });

  it('HTML for other apps carries looks, exact values and merged cells', () => {
    const { ctl, type, select } = open();
    type('A1', 'Total');
    type('B1', '1234.5');
    select('A1');
    ctl.sheet.patchStyle(ctl.selection, { b: 1, bg: '#ffeeaa', bb: 'm#ff0000' });
    select('A2:B2');
    ctl.sheet.merge(ctl.selection);
    select('A1:B2');
    copySelection(ctl);
    const html = copiedHtml(ctl);
    expect(html).toContain('font-weight:bold');
    expect(html).toContain('border-bottom:2px solid #ff0000');
    expect(html).toContain('colspan="2"');
    const table = readHtmlTable(html);
    expect(table?.fromIris).toBe(true);
    expect(table?.cells[0][1]).toMatchObject({ raw: 1234.5 });
    expect(table?.cells[0][0]?.style).toMatchObject({ b: 1, bg: '#ffeeaa', bb: 'm#ff0000' });
    expect(table?.merges).toEqual([{ r1: 1, c1: 0, r2: 1, c2: 1 }]);

    // Into another spreadsheet.
    const other = open();
    other.ctl.book.setLocale('en-US');
    other.select('C3');
    pasteTable(other.ctl, table!);
    expect(other.show('D3')).toBe('1234.5');
    expect(other.ctl.sheet.styleAt(2, 2)).toMatchObject({ b: 1, bb: 'm#ff0000' });
    expect(other.ctl.sheet.mergeAt(3, 2)).toEqual(expect.objectContaining({ r1: 3, c1: 2, r2: 3, c2: 3 }));
  });

  it('reads tables from Google Sheets, Excel and web pages, without what does not map', () => {
    const google = '<google-sheets-html-origin><style type="text/css"><!--td {border: 1px solid #cccccc;}--></style><table><tbody>'
      + '<tr><td style="font-weight:bold;background-color:#d9ead3;text-align:center;">Item</td><td data-sheets-value=\'{"1":3,"3":42}\'>42</td></tr>'
      + '<tr><td colspan="2" style="color:#ff0000">=SUM(1)</td></tr></tbody></table>';
    const table = readHtmlTable(google)!;
    expect(table.cells[0][0]).toMatchObject({ text: 'Item', style: { b: 1, bg: '#d9ead3', a: 'c' } });
    expect(table.cells[0][0]?.style.bt).toBeUndefined();
    expect(table.cells[0][1]).toMatchObject({ raw: 42 });
    expect(table.merges).toEqual([{ r1: 1, c1: 0, r2: 1, c2: 1 }]);

    const excel = '<style>.xl65 {font-weight:700; color:#0000FF; border-bottom:.5pt solid windowtext;}</style><table><tr><td class="xl65">Head</td><td>  two\n words </td></tr></table>';
    const fromExcel = readHtmlTable(excel)!;
    expect(fromExcel.cells[0][0]?.style).toMatchObject({ b: 1, c: '#0000ff', bb: 's' });
    expect(fromExcel.cells[0][1]?.text).toBe('two words');

    const web = '<table><tr><th>Name</th><td><b>Bold</b><script>alert(1)</script></td><td>a<br>b</td></tr></table><img src="data:image/png;base64,AAAA">';
    const fromWeb = readHtmlTable(web)!;
    expect(fromWeb.cells[0].map(cell => cell?.text)).toEqual(['Name', 'Bold', 'a\nb']);
    expect(fromWeb.cells[0][0]?.style.b).toBe(1);
    expect(fromWeb.cells[0][1]?.style.b).toBe(1);

    expect(readHtmlTable('<img src="data:image/png;base64,AAAA" width="20">')?.pictures).toEqual([{ src: 'data:image/png;base64,AAAA', row: 0, col: 0, dx: 0, dy: 0, width: 20, height: undefined }]);
    expect(readHtmlTable('<p>just text</p>')).toBeNull();
  });

  it('keeps theme colours out: black text and white fill are the default', () => {
    expect(styleFromCss('color:#000000;background-color:rgb(255,255,255);font-size:11pt')).toEqual({});
    expect(styleFromCss('font-size:14pt;vertical-align:middle;text-decoration:underline line-through')).toEqual({ fs: 14, va: 'm', u: 1, s: 1 });
  });

  it('pasted text that starts with "=" stays text, and a reader cannot paste', () => {
    const { ctl, show, select } = open();
    select('A1');
    pasteTable(ctl, readHtmlTable('<table><tr><td>=1+1</td><td>007</td></tr></table>')!);
    expect(show('A1')).toBe('=1+1');
    const reader = open();
    reader.ctl.start(false);
    expect(pasteTable(reader.ctl, readHtmlTable('<table><tr><td>x</td></tr></table>')!)).toBeNull();
  });
});
