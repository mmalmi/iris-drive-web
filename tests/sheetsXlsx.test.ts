import { strToU8, unzipSync, strFromU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parseRectName } from '../src/lib/sheets/address';
import { applyBorders, applyStyle, mergeSelection, setFontSize } from '../src/lib/sheets/commands';
import { SheetController } from '../src/lib/sheets/controller.svelte';
import { NUMBER_FORMATS } from '../src/lib/sheets/format';
import { importXlsx, parseXml, readXlsx, shiftFormula, writeXlsx } from '../src/lib/sheets/xlsx';
import { isError } from '../src/lib/sheets/values';

function open() {
  const ctl = new SheetController(new Y.Doc());
  ctl.start(true);
  const at = (name: string) => {
    const rect = parseRectName(name);
    if (!rect) throw new Error(`Bad name ${name}`);
    return rect;
  };
  const select = (name: string) => {
    const rect = at(name);
    ctl.setSelection({ row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 });
  };
  return {
    ctl,
    select,
    type(name: string, text: string) {
      select(name);
      ctl.startEdit({ text });
      ctl.commitEdit('down');
    },
    get(name: string) {
      const rect = at(name);
      const value = ctl.engine.valueAt(ctl.sheet, rect.r1, rect.c1);
      return isError(value) ? value.code : value;
    },
    formula(name: string) {
      select(name);
      return ctl.barText;
    },
    style(name: string) {
      const rect = at(name);
      return ctl.sheet.styleAt(rect.r1, rect.c1);
    },
  };
}

describe('Excel files', () => {
  it('reads the XML in them, entities and prefixes included', () => {
    const root = parseXml('<?xml version="1.0"?><x:a k="1 &amp; 2"><b>x &lt; y</b><c/><!-- note --><d><![CDATA[<raw>]]></d></x:a>');
    const a = root.children[0];
    expect(a.name).toBe('a');
    expect(a.attrs.k).toBe('1 & 2');
    expect(a.children.map(node => node.name)).toEqual(['b', 'c', 'd']);
    expect(a.children[0].text).toBe('x < y');
    expect(a.children[2].text).toBe('<raw>');
  });

  it('moves shared formulas to the cells that share them', () => {
    expect(shiftFormula('SUM(A1:B2)*$C$1+Costs!D4', 2, 1)).toBe('SUM(B3:C4)*$C$1+Costs!E6');
    expect(shiftFormula("'My costs'!A$1", 3, 0)).toBe("'My costs'!A$1");
  });

  it('a spreadsheet goes out and comes back with its values, formulas and looks', () => {
    const first = open();
    const { ctl, type, select } = first;
    type('A1', 'Budget & plans <2026>');
    type('A2', 'Rent');
    type('B2', '€900');
    type('A3', 'Food');
    type('B3', '350.5');
    type('A4', 'Total');
    type('B4', '=SUM(B2:B3)');
    type('C2', '13.11.2026');
    type('C3', 'TRUE');
    type('C4', '=1/0');
    select('A1:C1');
    mergeSelection(ctl, 'all');
    setFontSize(ctl, 18);
    applyStyle(ctl, { b: 1, a: 'c', va: 'm', bg: '#d0bfff', c: '#4527a0' });
    select('A2:B4');
    applyBorders(ctl, 'all', 's');
    applyBorders(ctl, 'outer', 'k#e03131');
    select('A2');
    applyStyle(ctl, { w: 1, i: 1, u: 1, s: 1 });
    ctl.sheet.setColWidth(0, 0, 180);
    ctl.sheet.setRowHeight(5, 5, 40);
    ctl.sheet.setFreeze(1, 0);
    const notes = ctl.book.addSheet('My notes');
    ctl.book.transact(() => ctl.book.sheet(notes).setRaw(0, 0, `=${'Sheet1'}!B4*2`));
    // The formula above is stored as typed; give it the stored spelling.
    ctl.showSheet(notes);
    type('A1', '=Sheet1!B4*2');

    const data = writeXlsx(ctl.book, ctl.engine);
    const parts = unzipSync(data);
    expect(Object.keys(parts)).toEqual(expect.arrayContaining(['[Content_Types].xml', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']));
    const sheetXml = strFromU8(parts['xl/worksheets/sheet1.xml']);
    expect(sheetXml).toContain('<f>SUM(B2:B3)</f><v>1250.5</v>');
    expect(sheetXml).toContain('<mergeCell ref="A1:C1"/>');
    expect(sheetXml).toContain('Budget &amp; plans &lt;2026&gt;');

    const sheets = readXlsx(data);
    expect(sheets.map(sheet => sheet.name)).toEqual(['Sheet1', 'My notes']);
    expect(sheets[0].freezeRows).toBe(1);
    expect(sheets[0].widths.get(0)).toBe(180);
    expect(sheets[0].heights.get(5)).toBe(40);

    const second = open();
    importXlsx(second.ctl, 'Budget.xlsx', data);
    // The empty sheet a new spreadsheet starts with gives way.
    expect(second.ctl.sheets.map(sheet => sheet.name)).toEqual(['Sheet1', 'My notes']);
    second.ctl.showSheet(second.ctl.sheets[0].id);
    expect(second.get('A1')).toBe('Budget & plans <2026>');
    expect(second.formula('B4')).toBe('=SUM(B2:B3)');
    expect(second.get('B4')).toBe(1250.5);
    expect(second.ctl.engine.textAt(second.ctl.sheet, 1, 1)).toBe('€900.00');
    expect(second.get('C2')).toBe(46339);
    expect(second.style('C2').nf).toBe('d.m.yyyy');
    expect(second.get('C3')).toBe(true);
    expect(second.get('C4')).toBe('#DIV/0!');
    expect(second.style('A1')).toMatchObject({ b: 1, a: 'c', va: 'm', bg: '#d0bfff', c: '#4527a0', fs: 18 });
    expect(second.style('A2')).toMatchObject({ w: 1, i: 1, u: 1, s: 1, bl: 'k#e03131', bt: 'k#e03131', bb: 's' });
    expect(second.ctl.sheet.borderAt(3, 1, 'bb')).toBe('k#e03131');
    expect(second.ctl.sheet.merges()).toMatchObject([{ r1: 0, c1: 0, r2: 0, c2: 2 }]);
    expect(second.ctl.sheet.colWidth(0)).toBe(180);
    expect(second.ctl.sheet.freezeRows).toBe(1);
    second.ctl.showSheet(second.ctl.sheets[1].id);
    expect(second.get('A1')).toBe(2501);
    // Undo takes the whole import back in one step.
    second.ctl.undo();
    expect(second.ctl.sheets.map(sheet => sheet.name)).toEqual(['Sheet1']);
  });

  it('reads a file another program wrote: shared strings, shared formulas, themes and built-in formats', () => {
    const head = '<?xml version="1.0" encoding="UTF-8"?>';
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
    const files = {
      'xl/workbook.xml': strToU8(`${head}<workbook ${ns}><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`),
      'xl/_rels/workbook.xml.rels': strToU8(`${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="/xl/worksheets/data.xml"/></Relationships>`),
      'xl/sharedStrings.xml': strToU8(`${head}<sst ${ns}><si><t>Name</t></si><si><r><t>Am</t></r><r><rPr><b/></rPr><t>ount</t></r></si><si><t>Ann</t></si></sst>`),
      'xl/styles.xml': strToU8(`${head}<styleSheet ${ns}><fonts><font><sz val="11"/></font><font><b/><sz val="11"/><color theme="1"/></font></fonts>`
        + '<fills><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="0.5"/></patternFill></fill></fills>'
        + '<borders><border/></borders><cellXfs><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0"/><xf numFmtId="4" fontId="0" fillId="0" borderId="0"/></cellXfs></styleSheet>'),
      'xl/worksheets/data.xml': strToU8(`${head}<worksheet ${ns}><sheetData>`
        + '<row r="1"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1" t="s" s="1"><v>1</v></c></row>'
        + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2" s="2"><v>1200</v></c><c r="C2"><f t="shared" ref="C2:C3" si="0">B2*2</f><v>2400</v></c></row>'
        + '<row r="3"><c r="B3"><v>5</v></c><c r="C3"><f t="shared" si="0"/><v>10</v></c><c r="D3"><f>_xlfn.CONCAT(A2,"!")</f><v>Ann!</v></c></row>'
        + '</sheetData></worksheet>'),
    };
    const { ctl, get, formula, style } = open();
    importXlsx(ctl, 'Export.xlsx', zipSync(files));
    expect(ctl.sheets.map(sheet => sheet.name)).toEqual(['Data']);
    expect(get('B1')).toBe('Amount');
    expect(style('A1')).toMatchObject({ b: 1, bg: '#a2b9e2' });
    expect(style('A1').c).toBeUndefined();
    expect(ctl.engine.textAt(ctl.sheet, 1, 1)).toBe('1,200.00');
    expect(formula('C3')).toBe('=B3*2');
    expect(get('C3')).toBe(10);
    expect(formula('D3')).toBe('=CONCAT(A2,"!")');
  });

  it('says so when a file is not a workbook', () => {
    const { ctl } = open();
    importXlsx(ctl, 'Broken.xlsx', strToU8('not a zip'));
    expect(ctl.notice).toBe('That file could not be read as an Excel workbook.');
    expect(ctl.sheets).toHaveLength(1);
  });
});
