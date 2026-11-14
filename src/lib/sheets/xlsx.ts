/**
 * Excel files (.xlsx): reading them into a spreadsheet and writing one out.
 *
 * An .xlsx file is a zip of XML parts. Only what a spreadsheet here can hold
 * is read and written: values, formulas, number formats, bold, italic,
 * underline, strikethrough, font size, text and fill colours, alignment,
 * wrapping, borders, column widths, row heights, hidden rows and columns,
 * merged cells, frozen panes and several sheets. Charts, pictures,
 * comments and conditional formats are left out. Loaded only when used.
 */
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { escapeXml } from '../markup';
import { NS_R, XML_HEAD, relationshipsXml, resolvePath } from '../ooxml';
import { columnIndex, columnName, parseRectName, quoteSheetName } from './address';
import { defineName, findName, listNames, resolveName } from './names';
import { readBorder } from './borders';
import type { SheetController } from './controller.svelte';
import { inputToStored } from './edit';
import type { Engine } from './engine';
import { tokenize, type RefEnd } from './formula';
import { NUMBER_FORMATS } from './format';
import { cellKey, decodeRaw, encodeText, isFormula, MAX_COLS, MAX_ROWS, type Book, type CellRaw, type CellStyle, type Sheet } from './model';
import { toDisplay } from './refs';
import { DEFAULT_POINTS } from './cellText';
import { isError } from './values';

// --- Reading XML ---

export interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(point) ? String.fromCodePoint(point) : whole;
    }
    return { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }[code.toLowerCase()] ?? whole;
  });
}

/** A small reader for the XML in Office files: elements, attributes and text. Prefixes are dropped from names. */
export function parseXml(source: string): XmlNode {
  const root: XmlNode = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<![A-Z][^>]*>/g;
  let last = 0;
  for (let match = tag.exec(source); match; match = tag.exec(source)) {
    const top = stack[stack.length - 1];
    if (match.index > last) top.text += decodeEntities(source.slice(last, match.index));
    last = tag.lastIndex;
    if (match[5] !== undefined) {
      top.text += match[5];
      continue;
    }
    if (!match[2]) continue;
    const name = match[2].replace(/^.*:/, '');
    if (match[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of match[3].matchAll(/([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = decodeEntities(attr[2] ?? attr[3] ?? '');
      attrs[attr[1]] = value;
      const local = attr[1].replace(/^.*:/, '');
      if (!(local in attrs)) attrs[local] = value;
    }
    const node: XmlNode = { name, attrs, children: [], text: '' };
    top.children.push(node);
    if (!match[4]) stack.push(node);
  }
  return root;
}

function child(node: XmlNode | undefined, name: string): XmlNode | undefined {
  return node?.children.find(entry => entry.name === name);
}

function children(node: XmlNode | undefined, name: string): XmlNode[] {
  return node ? node.children.filter(entry => entry.name === name) : [];
}

/** All the text inside a node, as in a rich text run. */
function textOf(node: XmlNode | undefined): string {
  if (!node) return '';
  if (node.name === 't') return node.text;
  return node.children.filter(entry => entry.name !== 'rPh').map(textOf).join('');
}

// --- Cell references and formulas ---

function readRef(ref: string): { row: number; col: number } | null {
  const match = /^\$?([A-Z]{1,3})\$?(\d+)$/i.exec(ref);
  return match ? { row: Number(match[2]) - 1, col: columnIndex(match[1]) } : null;
}

/** A formula as written for a cell `rows` down and `cols` right of the one it was written for (shared formulas). */
export function shiftFormula(formula: string, rows: number, cols: number): string {
  if (rows === 0 && cols === 0) return formula;
  let out = '';
  for (const token of tokenize(formula, 'a1')) {
    const ref = token.ref;
    if (token.type !== 'ref' || !ref) {
      out += token.text;
      continue;
    }
    const end = (part: RefEnd) => {
      const col = part.col === null ? '' : columnName(Math.max(0, columnIndex(part.col) + (part.absCol ? 0 : cols)));
      const row = part.row === null ? '' : String(Math.max(1, Number(part.row) + (part.absRow ? 0 : rows)));
      return `${part.absCol && part.col !== null ? '$' : ''}${col}${part.absRow && part.row !== null ? '$' : ''}${row}`;
    };
    const prefix = token.text.includes('!') ? token.text.slice(0, token.text.lastIndexOf('!') + 1) : '';
    out += `${prefix}${end(ref.a)}${ref.b ? `:${end(ref.b)}` : ''}`;
  }
  return out;
}

// --- Colours ---

/** The colours of Office's usual theme, in the order files number them. */
const THEME = ['ffffff', '000000', 'e7e6e6', '44546a', '4472c4', 'ed7d31', 'a5a5a5', 'ffc000', '5b9bd5', '70ad47'];
const INDEXED = ['000000', 'ffffff', 'ff0000', '00ff00', '0000ff', 'ffff00', 'ff00ff', '00ffff'];

function tinted(hex: string, tint: number): string {
  if (!tint) return hex;
  const channel = (index: number) => {
    const value = parseInt(hex.slice(index, index + 2), 16);
    const next = tint < 0 ? value * (1 + tint) : value + (255 - value) * tint;
    return Math.round(Math.max(0, Math.min(255, next))).toString(16).padStart(2, '0');
  };
  return `${channel(0)}${channel(2)}${channel(4)}`;
}

/** A colour from a file as #rrggbb, or '' when it is automatic or unknown. */
function readColor(node: XmlNode | undefined): string {
  if (!node || node.attrs.auto === '1') return '';
  let hex = '';
  if (node.attrs.rgb) hex = node.attrs.rgb.slice(-6).toLowerCase();
  else if (node.attrs.theme !== undefined) hex = THEME[Number(node.attrs.theme)] ?? '';
  else if (node.attrs.indexed !== undefined) hex = INDEXED[Number(node.attrs.indexed) % 8] ?? '';
  if (!/^[0-9a-f]{6}$/.test(hex)) return '';
  return `#${tinted(hex, Number(node.attrs.tint ?? 0))}`;
}

// --- Styles ---

const BUILT_IN_FORMATS: Record<number, string> = {
  1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00',
  14: NUMBER_FORMATS.date, 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
  20: 'hh:mm', 21: 'hh:mm:ss', 22: NUMBER_FORMATS.dateTime, 37: '#,##0;(#,##0)', 38: '#,##0;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
};

const BORDER_KINDS: Record<string, string> = {
  thin: 's', hair: 's', medium: 'm', thick: 'k', double: 'k', dashed: 'd', mediumDashed: 'd', dashDot: 'd',
  mediumDashDot: 'd', dashDotDot: 'd', mediumDashDotDot: 'd', slantDashDot: 'd', dotted: 'o',
};

function readStyles(xml: XmlNode | null): CellStyle[] {
  const sheet = child(xml ?? undefined, 'styleSheet');
  if (!sheet) return [];
  const formats = new Map<number, string>();
  for (const entry of children(child(sheet, 'numFmts'), 'numFmt')) formats.set(Number(entry.attrs.numFmtId), entry.attrs.formatCode ?? '');
  const fonts = children(child(sheet, 'fonts'), 'font').map((font): CellStyle => {
    const style: CellStyle = {};
    if (child(font, 'b') && child(font, 'b')?.attrs.val !== '0') style.b = 1;
    if (child(font, 'i') && child(font, 'i')?.attrs.val !== '0') style.i = 1;
    if (child(font, 'u') && child(font, 'u')?.attrs.val !== 'none') style.u = 1;
    if (child(font, 'strike') && child(font, 'strike')?.attrs.val !== '0') style.s = 1;
    const size = Number(child(font, 'sz')?.attrs.val);
    if (size && Math.abs(size - DEFAULT_POINTS) > 0.4 && Math.abs(size - 11) > 0.4) style.fs = Math.round(size * 2) / 2;
    const color = readColor(child(font, 'color'));
    if (color && color !== '#000000') style.c = color;
    return style;
  });
  const fills = children(child(sheet, 'fills'), 'fill').map((fill) => {
    const pattern = child(fill, 'patternFill');
    if (!pattern || pattern.attrs.patternType !== 'solid') return '';
    return readColor(child(pattern, 'fgColor')) || readColor(child(pattern, 'bgColor'));
  });
  const borders = children(child(sheet, 'borders'), 'border').map((border) => {
    const style: CellStyle = {};
    for (const [side, prop] of [['top', 'bt'], ['bottom', 'bb'], ['left', 'bl'], ['right', 'br']] as const) {
      const line = child(border, side);
      const kind = line?.attrs.style ? BORDER_KINDS[line.attrs.style] : undefined;
      if (kind) style[prop] = `${kind}${readColor(child(line, 'color'))}`;
    }
    return style;
  });
  return children(child(sheet, 'cellXfs'), 'xf').map((xf) => {
    const style: CellStyle = { ...fonts[Number(xf.attrs.fontId ?? 0)] };
    const fill = fills[Number(xf.attrs.fillId ?? 0)];
    if (fill) style.bg = fill;
    Object.assign(style, borders[Number(xf.attrs.borderId ?? 0)]);
    const id = Number(xf.attrs.numFmtId ?? 0);
    const format = formats.get(id) ?? BUILT_IN_FORMATS[id];
    if (format && format.toLowerCase() !== 'general') style.nf = format;
    const align = child(xf, 'alignment');
    const horizontal = align?.attrs.horizontal;
    if (horizontal === 'left' || horizontal === 'right') style.a = horizontal[0] as 'l' | 'r';
    else if (horizontal === 'center' || horizontal === 'centerContinuous') style.a = 'c';
    const vertical = align?.attrs.vertical;
    if (vertical === 'top') style.va = 't';
    else if (vertical === 'center') style.va = 'm';
    if (align?.attrs.wrapText === '1' || align?.attrs.wrapText === 'true') style.w = 1;
    return style;
  });
}

// --- Reading a file ---

export interface ImportedSheet {
  name: string;
  rows: number;
  cols: number;
  /** By "row:col" position: a value, or a formula without its "=". */
  cells: Map<string, { value?: number | string | boolean; formula?: string; style?: CellStyle }>;
  widths: Map<number, number>;
  heights: Map<number, number>;
  hiddenRows: number[];
  hiddenCols: number[];
  merges: Array<{ r1: number; c1: number; r2: number; c2: number }>;
  freezeRows: number;
  freezeCols: number;
  /** Workbook names that stand for cells of this sheet: name -> cells, as "B2:B9". */
  names?: Map<string, string>;
}

/** Reads the sheets of an .xlsx file. Throws when it is not one. */
export function readXlsx(data: Uint8Array): ImportedSheet[] {
  const files = unzipSync(data);
  const xml = (path: string) => (files[path] ? parseXml(strFromU8(files[path])) : null);
  const workbook = xml('xl/workbook.xml');
  if (!workbook) throw new Error('This is not an Excel workbook');
  const relations = new Map<string, string>();
  for (const rel of children(child(xml('xl/_rels/workbook.xml.rels') ?? undefined, 'Relationships'), 'Relationship')) {
    relations.set(rel.attrs.Id, resolvePath('xl/workbook.xml', rel.attrs.Target ?? ''));
  }
  const shared = children(child(xml('xl/sharedStrings.xml') ?? undefined, 'sst'), 'si').map(textOf);
  const styles = readStyles(xml('xl/styles.xml'));
  const sheets: ImportedSheet[] = [];
  for (const entry of children(child(child(workbook, 'workbook'), 'sheets'), 'sheet')) {
    const path = relations.get(entry.attrs['r:id'] ?? entry.attrs.id ?? '') ?? '';
    const sheetXml = child(xml(path) ?? undefined, 'worksheet');
    if (!sheetXml) continue;
    const sheet: ImportedSheet = {
      name: entry.attrs.name || `Sheet${sheets.length + 1}`,
      rows: 0,
      cols: 0,
      cells: new Map(),
      widths: new Map(),
      heights: new Map(),
      hiddenRows: [],
      hiddenCols: [],
      merges: [],
      freezeRows: 0,
      freezeCols: 0,
    };
    for (const col of children(child(sheetXml, 'cols'), 'col')) {
      const from = Number(col.attrs.min) - 1;
      const to = Math.min(Number(col.attrs.max) - 1, from + 500, MAX_COLS - 1);
      for (let index = from; index <= to; index += 1) {
        if (col.attrs.width && col.attrs.customWidth !== '0') sheet.widths.set(index, Math.round(Number(col.attrs.width) * 7 + 5));
        if (col.attrs.hidden === '1' || col.attrs.hidden === 'true') sheet.hiddenCols.push(index);
      }
    }
    const shares = new Map<string, { formula: string; row: number; col: number }>();
    // Cells that hold the result of an array formula, which fills them again here.
    const arrayResults: Array<{ row: number; col: number; r2: number; c2: number }> = [];
    let nextRow = 0;
    for (const row of children(child(sheetXml, 'sheetData'), 'row')) {
      const rowIndex = row.attrs.r ? Number(row.attrs.r) - 1 : nextRow;
      nextRow = rowIndex + 1;
      if (rowIndex >= MAX_ROWS) break;
      sheet.rows = Math.max(sheet.rows, rowIndex + 1);
      if (row.attrs.ht && (row.attrs.customHeight === '1' || row.attrs.customHeight === 'true')) sheet.heights.set(rowIndex, Math.round(Number(row.attrs.ht) / 0.75));
      if (row.attrs.hidden === '1' || row.attrs.hidden === 'true') sheet.hiddenRows.push(rowIndex);
      let nextCol = 0;
      for (const cell of children(row, 'c')) {
        const place = cell.attrs.r ? readRef(cell.attrs.r) : { row: rowIndex, col: nextCol };
        if (!place || place.col >= MAX_COLS) continue;
        nextCol = place.col + 1;
        const out: { value?: number | string | boolean; formula?: string; style?: CellStyle } = {};
        const style = styles[Number(cell.attrs.s ?? 0)];
        if (style && Object.keys(style).length > 0) out.style = style;
        const f = child(cell, 'f');
        if (f) {
          let formula = f.text.trim();
          if (f.attrs.t === 'shared' && f.attrs.si !== undefined) {
            const master = shares.get(f.attrs.si);
            if (formula) shares.set(f.attrs.si, { formula, row: place.row, col: place.col });
            else if (master) formula = shiftFormula(master.formula, place.row - master.row, place.col - master.col);
          }
          if (formula) out.formula = formula.replace(/_xlfn\.|_xlws\./g, '');
          if (formula && f.attrs.t === 'array') {
            // A dynamic array (marked by cell metadata) fills cells by itself; an older array formula needs ARRAYFORMULA.
            if (cell.attrs.cm === undefined) out.formula = `ARRAYFORMULA(${out.formula})`;
            const [, second] = (f.attrs.ref ?? '').split(':');
            const end = second ? readRef(second) : null;
            if (end) arrayResults.push({ row: place.row, col: place.col, r2: end.row, c2: end.col });
          }
        }
        const raw = child(cell, 'v')?.text;
        const type = cell.attrs.t ?? 'n';
        if (!out.formula) {
          if (type === 's') out.value = shared[Number(raw)] ?? '';
          else if (type === 'inlineStr') out.value = textOf(child(cell, 'is'));
          else if (type === 'b') out.value = raw === '1';
          else if (type === 'str' || type === 'e') out.value = raw ?? '';
          else if (type === 'd' && raw) out.value = raw;
          else if (raw !== undefined && raw !== '') out.value = Number(raw);
        }
        if (out.value === undefined && !out.formula && !out.style) continue;
        sheet.cells.set(`${place.row}:${place.col}`, out);
        sheet.cols = Math.max(sheet.cols, place.col + 1);
        sheet.rows = Math.max(sheet.rows, place.row + 1);
      }
    }
    for (const area of arrayResults) {
      for (const [key, cell] of sheet.cells) {
        const [row, col] = key.split(':').map(Number);
        if ((row === area.row && col === area.col) || row < area.row || col < area.col || row > area.r2 || col > area.c2 || cell.formula) continue;
        delete cell.value;
        if (!cell.style) sheet.cells.delete(key);
      }
    }
    for (const merge of children(child(sheetXml, 'mergeCells'), 'mergeCell')) {
      const [first, second] = (merge.attrs.ref ?? '').split(':');
      const a = readRef(first ?? '');
      const b = readRef(second ?? '');
      if (a && b) sheet.merges.push({ r1: a.row, c1: a.col, r2: b.row, c2: b.col });
    }
    const pane = child(child(child(sheetXml, 'sheetViews'), 'sheetView'), 'pane');
    if (pane && (pane.attrs.state === 'frozen' || pane.attrs.state === 'frozenSplit')) {
      sheet.freezeRows = Math.max(0, Math.floor(Number(pane.attrs.ySplit ?? 0)));
      sheet.freezeCols = Math.max(0, Math.floor(Number(pane.attrs.xSplit ?? 0)));
    }
    sheets.push(sheet);
  }
  // Named ranges, as "Sheet1!$B$2:$B$9"; other kinds of names are left out.
  for (const defined of children(child(child(workbook, 'workbook'), 'definedNames'), 'definedName')) {
    const name = defined.attrs.name ?? '';
    const match = /^(?:'((?:[^']|'')+)'|([^!'\s]+))!\$?([A-Z]{1,3})\$?(\d+)(?::\$?([A-Z]{1,3})\$?(\d+))?$/i.exec(defined.text.trim());
    if (!match || defined.attrs.localSheetId !== undefined || name.startsWith('_xlnm')) continue;
    const sheetName = (match[1] ?? match[2]).replace(/''/g, "'").toLowerCase();
    const target = sheets.find(sheet => sheet.name.toLowerCase() === sheetName);
    if (target) (target.names ??= new Map()).set(name, `${match[3]}${match[4]}${match[5] ? `:${match[5]}${match[6]}` : ''}`);
  }
  return sheets;
}

/**
 * Puts the sheets of an Excel file into the spreadsheet, after the one in
 * view. A spreadsheet that holds nothing yet gives way to the file's sheets.
 */
export function importXlsx(ctl: SheetController, fileName: string, data: Uint8Array): void {
  if (!ctl.canEdit) return;
  let sheets: ImportedSheet[];
  try {
    sheets = readXlsx(data);
  } catch {
    ctl.say('That file could not be read as an Excel workbook.');
    return;
  }
  if (sheets.length === 0) {
    ctl.say('That workbook has no sheets to bring in.');
    return;
  }
  ctl.commitEdit();
  const book = ctl.book;
  const emptyBefore = book.sheets.length === 1 && book.sheet(book.sheets[0].id).cells.size === 0 && book.sheet(book.sheets[0].id).styles.size === 0
    ? book.sheets[0].id
    : null;
  const names = new Map<string, string>();
  const ids: string[] = [];
  const base = fileName.replace(/\.[^.]+$/, '').slice(0, 60);
  book.transact(() => {
    if (emptyBefore) {
      // Out of the way first, so the file's own first sheet can keep the name "Sheet1".
      book.renameSheet(emptyBefore, `~${emptyBefore}`);
    }
    let after = ctl.sheetId;
    // Names in use, without the empty sheet that is going away.
    const taken = new Set(book.sheets.filter(info => info.id !== emptyBefore).map(info => info.name.toLowerCase()));
    const free = (wanted: string) => {
      let name = wanted;
      for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${wanted} (${n})`;
      taken.add(name.toLowerCase());
      return name;
    };
    for (const imported of sheets) {
      const name = free(sheets.length === 1 && /^Sheet\d*$/i.test(imported.name) && base ? base : imported.name);
      names.set(imported.name.toLowerCase(), name);
      const id = book.addSheet(name, Math.max(imported.rows + 50, 100), Math.max(imported.cols + 5, 26), after);
      book.sheet(id).rebuildAxes();
      ids.push(id);
      after = id;
    }
    // Formulas name the new sheets, which the book must know by now.
    book.refreshSheets();
    sheets.forEach((imported, index) => fillSheet(book, book.sheet(ids[index]), imported, names));
    sheets.forEach((imported, index) => {
      for (const [name, cells] of imported.names ?? []) {
        const rect = parseRectName(cells);
        const sheet = book.sheet(ids[index]);
        if (rect && rect.r2 < sheet.rows.length && rect.c2 < sheet.cols.length && !findName(book, name)) defineName(book, name, sheet, rect);
      }
    });
    if (emptyBefore) book.removeSheet(emptyBefore);
  });
  ctl.showSheet(ids[0]);
}

/** A formula from a file, with the names of its sheets as they are called here. */
function renameSheetsIn(formula: string, names: Map<string, string>): string {
  if (!formula.includes('!')) return formula;
  let out = '';
  for (const token of tokenize(formula, 'a1')) {
    const sheet = token.type === 'ref' ? token.ref?.sheet : null;
    const renamed = sheet ? names.get(sheet.toLowerCase()) : undefined;
    out += renamed && renamed !== sheet ? `${quoteSheetName(renamed)}${token.text.slice(token.text.lastIndexOf('!'))}` : token.text;
  }
  return out;
}

function fillSheet(book: Book, sheet: Sheet, imported: ImportedSheet, names: Map<string, string>): void {
  const rowId = (row: number) => sheet.rows.ids[row];
  const colId = (col: number) => sheet.cols.ids[col];
  for (const [place, cell] of imported.cells) {
    const [row, col] = place.split(':').map(Number);
    if (rowId(row) === undefined || colId(col) === undefined) continue;
    const key = cellKey(rowId(row), colId(col));
    if (cell.style) sheet.styles.set(key, cell.style);
    let raw: CellRaw | null = null;
    if (cell.formula) raw = inputToStored(`=${renameSheetsIn(cell.formula, names)}`, book, sheet).raw;
    else if (typeof cell.value === 'string') raw = cell.value === '' ? null : encodeText(cell.value);
    else if (cell.value !== undefined && (typeof cell.value === 'boolean' || Number.isFinite(cell.value))) raw = cell.value;
    if (raw !== null) sheet.cells.set(key, raw);
  }
  for (const [col, width] of imported.widths) if (colId(col) !== undefined && width > 0) sheet.props.set(`w:${colId(col)}`, Math.max(24, width));
  for (const [row, height] of imported.heights) if (rowId(row) !== undefined && height > 0) sheet.props.set(`h:${rowId(row)}`, Math.max(16, height));
  for (const row of imported.hiddenRows) if (rowId(row) !== undefined) sheet.props.set(`hr:${rowId(row)}`, true);
  for (const col of imported.hiddenCols) if (colId(col) !== undefined) sheet.props.set(`hc:${colId(col)}`, true);
  for (const merge of imported.merges) {
    if (rowId(merge.r2) === undefined || colId(merge.c2) === undefined) continue;
    sheet.props.set(`m:${rowId(merge.r1)}:${colId(merge.c1)}`, `${rowId(merge.r2)}:${colId(merge.c2)}`);
  }
  if (imported.freezeRows > 0) sheet.props.set('freezeRows', imported.freezeRows);
  if (imported.freezeCols > 0) sheet.props.set('freezeCols', imported.freezeCols);
}

// --- Writing a file ---

const KIND_NAMES: Record<string, string> = { s: 'thin', m: 'medium', k: 'thick', d: 'dashed', o: 'dotted' };

function argb(hex: string): string {
  return `FF${hex.slice(1).toUpperCase()}`;
}

/** Collects the distinct looks of the cells written, as the parts styles.xml lists. */
class StyleTable {
  private readonly fonts = ['<font><sz val="10"/><name val="Arial"/></font>'];
  private readonly fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  private readonly borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  private readonly formats = new Map<string, number>();
  private readonly xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  private readonly byKey = new Map<string, number>([['{}', 0]]);

  private index(list: string[], entry: string): number {
    const found = list.indexOf(entry);
    if (found >= 0) return found;
    list.push(entry);
    return list.length - 1;
  }

  private formatId(pattern: string | undefined): number {
    if (!pattern) return 0;
    if (pattern === NUMBER_FORMATS.date) return 14;
    if (pattern === NUMBER_FORMATS.dateTime) return 22;
    if (pattern === '@') return 49;
    for (const [id, code] of Object.entries(BUILT_IN_FORMATS)) if (code === pattern && Number(id) < 14) return Number(id);
    let id = this.formats.get(pattern);
    if (id === undefined) {
      id = 164 + this.formats.size;
      this.formats.set(pattern, id);
    }
    return id;
  }

  /** The number of the style for a look, adding it the first time. */
  of(style: CellStyle): number {
    const key = JSON.stringify(style);
    const known = this.byKey.get(key);
    if (known !== undefined) return known;
    const font = `<font>${style.b ? '<b/>' : ''}${style.i ? '<i/>' : ''}${style.s ? '<strike/>' : ''}${style.u ? '<u/>' : ''}`
      + `<sz val="${style.fs ?? DEFAULT_POINTS}"/>${style.c ? `<color rgb="${argb(style.c)}"/>` : ''}<name val="Arial"/></font>`;
    const fill = style.bg ? `<fill><patternFill patternType="solid"><fgColor rgb="${argb(style.bg)}"/><bgColor indexed="64"/></patternFill></fill>` : this.fills[0];
    const side = (name: string, value: string | undefined) => {
      const line = readBorder(value);
      if (!line) return `<${name}/>`;
      return `<${name} style="${KIND_NAMES[line.kind]}">${line.color ? `<color rgb="${argb(line.color)}"/>` : '<color auto="1"/>'}</${name}>`;
    };
    const border = `<border>${side('left', style.bl)}${side('right', style.br)}${side('top', style.bt)}${side('bottom', style.bb)}<diagonal/></border>`;
    const horizontal = style.a === 'l' ? 'left' : style.a === 'c' ? 'center' : style.a === 'r' ? 'right' : '';
    const vertical = style.va === 't' ? 'top' : style.va === 'm' ? 'center' : '';
    const alignment = horizontal || vertical || style.w
      ? `<alignment${horizontal ? ` horizontal="${horizontal}"` : ''}${vertical ? ` vertical="${vertical}"` : ''}${style.w ? ' wrapText="1"' : ''}/>`
      : '';
    const numFmt = this.formatId(style.nf);
    const fontId = this.index(this.fonts, font);
    const fillId = this.index(this.fills, fill);
    const borderId = this.index(this.borders, border);
    this.xfs.push(`<xf numFmtId="${numFmt}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"`
      + `${numFmt ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}`
      + `${alignment ? ` applyAlignment="1">${alignment}</xf>` : '/>'}`);
    const id = this.xfs.length - 1;
    this.byKey.set(key, id);
    return id;
  }

  xml(): string {
    const numFmts = [...this.formats].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${escapeXml(code)}"/>`).join('');
    return XML_HEAD
      + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
      + (numFmts ? `<numFmts count="${this.formats.size}">${numFmts}</numFmts>` : '')
      + `<fonts count="${this.fonts.length}">${this.fonts.join('')}</fonts>`
      + `<fills count="${this.fills.length}">${this.fills.join('')}</fills>`
      + `<borders count="${this.borders.length}">${this.borders.join('')}</borders>`
      + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
      + `<cellXfs count="${this.xfs.length}">${this.xfs.join('')}</cellXfs>`
      + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
      + '</styleSheet>';
  }
}

/**
 * Functions newer than the .xlsx format, which Excel reads only with the
 * prefix it writes them with. Reading a file drops the prefixes again.
 */
const NEWER_FUNCTIONS: Record<string, string> = {
  FILTER: '_xlfn._xlws.', SORT: '_xlfn._xlws.',
  ...Object.fromEntries([
    'UNIQUE', 'SEQUENCE', 'XLOOKUP', 'XMATCH', 'IFS', 'SWITCH', 'IFNA', 'XOR', 'CONCAT', 'TEXTJOIN', 'UNICODE', 'DAYS',
    'ISOWEEKNUM', 'MAXIFS', 'MINIFS', 'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'PERCENTILE.INC', 'QUARTILE.INC', 'RANK.EQ',
    'CEILING.MATH', 'FLOOR.MATH',
  ].map(name => [name, '_xlfn.'])),
};

/**
 * A formula as Excel writes it: newer functions with their prefix, and
 * ARRAYFORMULA, which Excel does not have, left out. `array` then says the
 * formula is to be written as an array formula, which works cell by cell
 * in Excel and which Google Sheets opens as ARRAYFORMULA again.
 */
function excelFormula(text: string): { formula: string; array: boolean } {
  const tokens = tokenize(text, 'a1');
  const solid = tokens.map((token, index) => ({ token, index })).filter(({ token }) => token.type !== 'ws');
  // The whole formula one ARRAYFORMULA(...): its parentheses go too.
  const drop = new Set<number>();
  if (solid[0]?.token.type === 'func' && solid[0].token.text.toUpperCase() === 'ARRAYFORMULA' && solid[1]?.token.type === 'open') {
    let depth = 0;
    let close = -1;
    for (let at = 1; at < solid.length && close < 0; at += 1) {
      const { type } = solid[at].token;
      if (type === 'open') depth += 1;
      else if (type === 'close' && (depth -= 1) === 0) close = at;
    }
    if (close === solid.length - 1) [solid[1].index, solid[close].index].forEach(index => drop.add(index));
  }
  let array = false;
  let formula = '';
  tokens.forEach((token, index) => {
    if (drop.has(index)) return;
    const upper = token.text.toUpperCase();
    if (token.type === 'func' && upper === 'ARRAYFORMULA') array = true;
    else formula += token.type === 'func' && NEWER_FUNCTIONS[upper] ? `${NEWER_FUNCTIONS[upper]}${upper}` : token.text;
  });
  return { formula: formula.trim(), array };
}

function sheetXml(book: Book, engine: Engine, sheet: Sheet, styles: StyleTable, usage: { dynamicArrays: boolean }): string {
  const used = engine.usedRect(sheet);
  const merges = sheet.merges();
  let lastRow = used?.r2 ?? -1;
  let lastCol = used?.c2 ?? -1;
  for (const merge of merges) {
    lastRow = Math.max(lastRow, merge.r2);
    lastCol = Math.max(lastCol, merge.c2);
  }
  // Cells with a look of their own but no content still carry it, such as an empty bordered cell.
  for (const key of sheet.styles.keys()) {
    const at = key.indexOf(':');
    if (at <= 0 || at === key.length - 1) continue;
    const row = sheet.rows.indexOf(key.slice(0, at));
    const col = sheet.cols.indexOf(key.slice(at + 1));
    if (row >= 0 && col >= 0) {
      lastRow = Math.max(lastRow, row);
      lastCol = Math.max(lastCol, col);
    }
  }
  const hiddenRows = sheet.hidden('row');
  const hiddenCols = sheet.hidden('col');
  for (const row of hiddenRows) lastRow = Math.max(lastRow, row);
  for (const key of sheet.props.keys()) {
    if (key.startsWith('h:')) lastRow = Math.max(lastRow, sheet.rows.indexOf(key.slice(2)));
  }
  const rows: string[] = [];
  for (let row = 0; row <= lastRow; row += 1) {
    const cells: string[] = [];
    for (let col = 0; col <= lastCol; col += 1) {
      const raw = sheet.rawAt(row, col);
      // A cell another formula's result fills is written as its value, as Excel writes the cells a dynamic array fills.
      const spilled = raw === undefined && engine.isSpilled(sheet, row, col);
      let style = sheet.styleAt(row, col);
      // Formulas' results keep the number format they show with, such as a date.
      const implied = (spilled || isFormula(raw)) && !style.nf ? engine.formatAt(sheet, row, col) : undefined;
      if (implied) style = { ...style, nf: implied };
      const s = Object.keys(style).length > 0 ? styles.of(style) : 0;
      if (raw === undefined && !spilled && s === 0) continue;
      const ref = `${columnName(col)}${row + 1}`;
      const sAttr = s ? ` s="${s}"` : '';
      if (spilled) {
        const value = engine.valueAt(sheet, row, col);
        if (typeof value === 'number') cells.push(`<c r="${ref}"${sAttr}><v>${value}</v></c>`);
        else if (typeof value === 'boolean') cells.push(`<c r="${ref}"${sAttr} t="b"><v>${value ? 1 : 0}</v></c>`);
        else if (isError(value)) cells.push(`<c r="${ref}"${sAttr} t="e"><v>${escapeXml(value.code)}</v></c>`);
        else if (value === null || value === '') cells.push(`<c r="${ref}"${sAttr}/>`);
        else cells.push(`<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`);
      } else if (raw === undefined) {
        cells.push(`<c r="${ref}"${sAttr}/>`);
      } else if (isFormula(raw)) {
        const value = engine.valueAt(sheet, row, col);
        const written = excelFormula(toDisplay(raw, book, sheet).slice(1));
        // A result of several cells is a dynamic array, marked by the cell metadata that metadata.xml defines;
        // ARRAYFORMULA, which Excel does not have, becomes an array formula over the cells it fills.
        const area = engine.spillRectAt(sheet, row, col);
        const cm = area && !written.array ? ' cm="1"' : '';
        if (cm) usage.dynamicArrays = true;
        const arrayAttrs = area || written.array
          ? ` t="array" ref="${ref}${area ? `:${columnName(area.c2)}${area.r2 + 1}` : ''}"`
          : '';
        const formula = `<f${arrayAttrs}>${escapeXml(written.formula)}</f>`;
        if (typeof value === 'number' && Number.isFinite(value)) cells.push(`<c r="${ref}"${sAttr}${cm}>${formula}<v>${value}</v></c>`);
        else if (typeof value === 'boolean') cells.push(`<c r="${ref}"${sAttr} t="b"${cm}>${formula}<v>${value ? 1 : 0}</v></c>`);
        else if (isError(value)) cells.push(`<c r="${ref}"${sAttr} t="e"${cm}>${formula}<v>${escapeXml(value.code)}</v></c>`);
        else cells.push(`<c r="${ref}"${sAttr} t="str"${cm}>${formula}<v>${escapeXml(String(value ?? ''))}</v></c>`);
      } else {
        const value = decodeRaw(raw);
        if (typeof value === 'number') cells.push(`<c r="${ref}"${sAttr}><v>${value}</v></c>`);
        else if (typeof value === 'boolean') cells.push(`<c r="${ref}"${sAttr} t="b"><v>${value ? 1 : 0}</v></c>`);
        else cells.push(`<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${escapeXml(String(value ?? ''))}</t></is></c>`);
      }
    }
    const height = sheet.rowHeight(row);
    const attrs = `${height ? ` ht="${(height * 0.75).toFixed(2)}" customHeight="1"` : ''}${hiddenRows.has(row) ? ' hidden="1"' : ''}`;
    if (cells.length > 0 || attrs) rows.push(`<row r="${row + 1}"${attrs}>${cells.join('')}</row>`);
  }
  const cols: string[] = [];
  for (let col = 0; col < sheet.cols.length; col += 1) {
    const set = sheet.props.get(`w:${sheet.cols.ids[col]}`) !== undefined;
    if (!set && !hiddenCols.has(col)) continue;
    const width = ((sheet.colWidth(col) - 5) / 7).toFixed(2);
    cols.push(`<col min="${col + 1}" max="${col + 1}" width="${width}" customWidth="1"${hiddenCols.has(col) ? ' hidden="1"' : ''}/>`);
  }
  const { freezeRows, freezeCols } = sheet;
  const pane = freezeRows > 0 || freezeCols > 0
    ? `<pane${freezeCols ? ` xSplit="${freezeCols}"` : ''}${freezeRows ? ` ySplit="${freezeRows}"` : ''} topLeftCell="${columnName(freezeCols)}${freezeRows + 1}" activePane="${freezeRows && freezeCols ? 'bottomRight' : freezeRows ? 'bottomLeft' : 'topRight'}" state="frozen"/>`
    : '';
  const mergeXml = merges.length > 0
    ? `<mergeCells count="${merges.length}">${merges.map(m => `<mergeCell ref="${columnName(m.c1)}${m.r1 + 1}:${columnName(m.c2)}${m.r2 + 1}"/>`).join('')}</mergeCells>`
    : '';
  return XML_HEAD
    + `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_R}">`
    + `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>`
    + '<sheetFormatPr defaultRowHeight="18" defaultColWidth="13.57"/>'
    + (cols.length > 0 ? `<cols>${cols.join('')}</cols>` : '')
    + `<sheetData>${rows.join('')}</sheetData>${mergeXml}</worksheet>`;
}

/**
 * The cell metadata Excel writes for dynamic arrays: cells marked cm="1"
 * hold a formula whose result fills the cells its ref names by itself.
 */
const DYNAMIC_ARRAY_METADATA = `${XML_HEAD}<metadata xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray">`
  + '<metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes>'
  + '<futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}"><xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata>'
  + '<cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata>'
  + '</metadata>';

/** The whole spreadsheet as an .xlsx file. */
export function writeXlsx(book: Book, engine: Engine): Uint8Array {
  const styles = new StyleTable();
  const files: Record<string, Uint8Array> = {};
  const sheets = book.sheets;
  const usage = { dynamicArrays: false };
  sheets.forEach((info, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheetXml(book, engine, book.sheet(info.id), styles, usage));
  });
  files['[Content_Types].xml'] = strToU8(`${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + (usage.dynamicArrays ? '<Override PartName="/xl/metadata.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheetMetadata+xml"/>' : '')
    + sheets.map((_info, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')
    + '</Types>');
  files['_rels/.rels'] = strToU8(relationshipsXml([{ id: 'rId1', type: `${NS_R}/officeDocument`, target: 'xl/workbook.xml' }]));
  // Named ranges, as Excel writes them: "Sheet1!$B$2:$B$9".
  const definedNames = listNames(book).flatMap((named) => {
    const found = resolveName(book, named.name);
    if (!found || !('rect' in found)) return [];
    const { rect, sheet } = found;
    const end = (row: number, col: number) => `$${columnName(col)}$${row + 1}`;
    const cells = rect.r1 === rect.r2 && rect.c1 === rect.c2 ? end(rect.r1, rect.c1) : `${end(rect.r1, rect.c1)}:${end(rect.r2, rect.c2)}`;
    return [`<definedName name="${escapeXml(named.name)}">${escapeXml(`${quoteSheetName((book.nameOf(sheet.id) ?? '').slice(0, 31))}!${cells}`)}</definedName>`];
  });
  files['xl/workbook.xml'] = strToU8(`${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_R}"><sheets>`
    + sheets.map((info, index) => `<sheet name="${escapeXml(info.name.slice(0, 31))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')
    + `</sheets>${definedNames.length > 0 ? `<definedNames>${definedNames.join('')}</definedNames>` : ''}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`);
  files['xl/_rels/workbook.xml.rels'] = strToU8(relationshipsXml([
    ...sheets.map((_info, index) => ({ id: `rId${index + 1}`, type: `${NS_R}/worksheet`, target: `worksheets/sheet${index + 1}.xml` })),
    { id: `rId${sheets.length + 1}`, type: `${NS_R}/styles`, target: 'styles.xml' },
    ...(usage.dynamicArrays ? [{ id: `rId${sheets.length + 2}`, type: `${NS_R}/sheetMetadata`, target: 'metadata.xml' }] : []),
  ]));
  files['xl/styles.xml'] = strToU8(styles.xml());
  if (usage.dynamicArrays) files['xl/metadata.xml'] = strToU8(DYNAMIC_ARRAY_METADATA);
  return zipSync(files, { level: 6 });
}
