/**
 * Reads what other apps put on the clipboard as HTML: a table from a web
 * page, a document, Google Sheets, Excel or another Iris spreadsheet, and
 * the pictures in it. Values and the looks a cell here can have come along
 * (bold, italic, underline, strikethrough, colours, alignment, font size,
 * borders, merged cells); scripts, links and everything else are left out.
 */
import type { Rect } from './address';
import type { CellRaw, CellStyle } from './model';

export interface PastedCell {
  text: string;
  style: CellStyle;
  /** The exact stored value, when an Iris spreadsheet or Google Sheets says what it was. */
  raw?: CellRaw;
}

export interface PastedPicture {
  /** A data: or http(s): address. */
  src: string;
  /** The cell it sits in, counted from the table's first one, and where in it. */
  row: number;
  col: number;
  dx: number;
  dy: number;
  width?: number;
  height?: number;
}

export interface PastedTable {
  /** Rows of cells; null where a merged cell covers the place. */
  cells: Array<Array<PastedCell | null>>;
  merges: Rect[];
  pictures: PastedPicture[];
  /** True when the table came from an Iris spreadsheet, which wrote down every look. */
  fromIris: boolean;
}

const MAX_CELLS = 200_000;

function hex(value: string): string | null {
  const text = value.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(text);
  if (m) return `#${m[1]}`;
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(text);
  if (m) return `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`;
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(text);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return `#${[m[1], m[2], m[3]].map(part => Math.min(255, Number(part)).toString(16).padStart(2, '0')).join('')}`;
  }
  const named: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080', orange: '#ffa500' };
  return named[text] ?? null;
}

/** Points from a CSS length. */
function points(value: string): number | null {
  const m = /^([\d.]+)(pt|px)?$/.exec(value.trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  return m[2] === 'px' ? Math.round(n * 0.75) : Math.round(n);
}

function border(value: string): string | null {
  const text = value.trim().toLowerCase();
  if (!text || /\b(none|hidden)\b/.test(text) || /^0(px|pt)?\b/.test(text)) return null;
  const width = /([\d.]+)(px|pt)/.exec(text);
  const size = width ? parseFloat(width[1]) * (width[2] === 'pt' ? 4 / 3 : 1) : 1;
  if (size <= 0) return null;
  const kind = /dashed/.test(text) ? 'd' : /dotted/.test(text) ? 'o' : size >= 2.5 ? 'k' : size >= 1.5 ? 'm' : 's';
  const colorPart = /(#[0-9a-f]{3,6}|rgba?\([^)]*\))/i.exec(text)?.[1];
  const color = colorPart ? hex(colorPart) : null;
  return `${kind}${color && color !== '#000000' ? color : ''}`;
}

/** The looks a list of CSS declarations stands for. Black text and white fill are the defaults and are left out. */
export function styleFromCss(css: string, into: CellStyle = {}): CellStyle {
  const style: CellStyle = { ...into };
  for (const declaration of css.split(';')) {
    const at = declaration.indexOf(':');
    if (at < 0) continue;
    const name = declaration.slice(0, at).trim().toLowerCase();
    const value = declaration.slice(at + 1).replace(/!important/i, '').trim();
    const lower = value.toLowerCase();
    switch (name) {
      case 'font-weight':
        if (lower === 'bold' || lower === 'bolder' || Number(lower) >= 600) style.b = 1;
        else if (lower === 'normal' || Number(lower) < 600) delete style.b;
        break;
      case 'font-style':
        if (lower === 'italic' || lower === 'oblique') style.i = 1;
        break;
      case 'text-decoration':
      case 'text-decoration-line':
        if (lower.includes('line-through')) style.s = 1;
        if (lower.includes('underline')) style.u = 1;
        break;
      case 'color': {
        const color = hex(value);
        if (color && color !== '#000000') style.c = color;
        break;
      }
      case 'background':
      case 'background-color': {
        const color = hex(value.split(/\s+/).find(part => hex(part)) ?? value);
        if (color && color !== '#ffffff') style.bg = color;
        break;
      }
      case 'text-align':
        if (lower === 'left' || lower === 'start') style.a = 'l';
        else if (lower === 'center') style.a = 'c';
        else if (lower === 'right' || lower === 'end') style.a = 'r';
        break;
      case 'vertical-align':
        if (lower === 'top') style.va = 't';
        else if (lower === 'middle') style.va = 'm';
        break;
      case 'font-size': {
        const size = points(lower);
        // The usual sizes of other apps read as this one's usual size.
        if (size && size !== 10 && size !== 11 && size >= 6 && size <= 72) style.fs = size;
        break;
      }
      case 'white-space':
        if (lower === 'normal' || lower === 'pre-wrap') style.w = 1;
        break;
      case 'border': {
        const line = border(value);
        for (const side of ['bt', 'bb', 'bl', 'br'] as const) {
          if (line) style[side] = line;
          else delete style[side];
        }
        break;
      }
      case 'border-top':
      case 'border-bottom':
      case 'border-left':
      case 'border-right': {
        const side = ({ 'border-top': 'bt', 'border-bottom': 'bb', 'border-left': 'bl', 'border-right': 'br' } as const)[name];
        const line = border(value);
        if (line) style[side] = line;
        else delete style[side];
        break;
      }
      default:
        break;
    }
  }
  return style;
}

/** Rules of the form ".xl65 { … }" from a style sheet, as Excel writes them, by class name. */
function classRules(doc: Document): Map<string, string> {
  const rules = new Map<string, string>();
  for (const element of doc.querySelectorAll('style')) {
    const text = (element.textContent ?? '').replace(/<!--|-->/g, '');
    for (const match of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      for (const selector of match[1].split(',')) {
        const name = /^\s*(?:td|th)?\.([\w-]+)\s*$/.exec(selector)?.[1];
        if (name) rules.set(name, `${rules.get(name) ?? ''};${match[2]}`);
      }
    }
  }
  return rules;
}

/** The text of a cell as it shows: line breaks kept, other runs of white space made one. */
function cellText(cell: Element): string {
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out += (node.textContent ?? '').replace(/[ \t\r\n\f]+/g, ' ').replace(/\u00a0/g, ' ');
      return;
    }
    if (node.nodeType !== 1) return;
    const name = (node as Element).tagName;
    if (name === 'BR') {
      out += '\n';
      return;
    }
    if (name === 'SCRIPT' || name === 'STYLE') return;
    const block = name === 'P' || name === 'DIV' || name === 'LI';
    if (block && out && !out.endsWith('\n')) out += '\n';
    for (const child of node.childNodes) walk(child);
    if (block && out && !out.endsWith('\n')) out += '\n';
  };
  for (const child of cell.childNodes) walk(child);
  return out.replace(/ *\n */g, '\n').replace(/^\s+|\s+$/g, '');
}

/** Bold, italic and the like that a cell's content is wrapped in, as with <b>Total</b>. */
function inlineStyle(cell: Element, rules: Map<string, string>): CellStyle {
  let style: CellStyle = cell.tagName === 'TH' ? { b: 1 } : {};
  for (const name of cell.classList) {
    const css = rules.get(name);
    if (css) style = styleFromCss(css, style);
  }
  style = styleFromCss(cell.getAttribute('style') ?? '', style);
  // Content that is all one bold or italic piece makes the cell so.
  const kids = [...cell.children].filter(child => child.tagName !== 'SCRIPT' && child.tagName !== 'STYLE');
  const only = kids.length === 1 && cellText(cell) === cellText(kids[0]) ? kids[0] : null;
  if (only) {
    const tag = only.tagName;
    if (tag === 'B' || tag === 'STRONG') style.b = 1;
    if (tag === 'I' || tag === 'EM') style.i = 1;
    if (tag === 'U') style.u = 1;
    if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') style.s = 1;
    if (tag === 'SPAN' || tag === 'FONT' || tag === 'P' || tag === 'DIV') {
      style = styleFromCss(only.getAttribute('style') ?? '', style);
      const inner = only.children.length === 1 ? only.children[0].tagName : '';
      if (inner === 'B' || inner === 'STRONG') style.b = 1;
      if (inner === 'I' || inner === 'EM') style.i = 1;
    }
    const color = only.getAttribute('color');
    if (color && hex(color) && hex(color) !== '#000000') style.c = hex(color) as string;
  }
  return style;
}

/** A Google Sheets value note: {"1":3,"3":120} is the number 120, {"1":4,"4":1} TRUE. */
function googleValue(attribute: string | null): CellRaw | undefined {
  if (!attribute) return undefined;
  try {
    const note = JSON.parse(attribute) as Record<string, unknown>;
    if (note['1'] === 3 && typeof note['3'] === 'number') return note['3'];
    if (note['1'] === 4 && note['4'] !== undefined) return Boolean(note['4']);
  } catch {
    // Not a note this knows.
  }
  return undefined;
}

function pictureOf(image: Element, row: number, col: number): PastedPicture | null {
  let src = image.getAttribute('src') ?? '';
  // A picture of this app, such as one copied from a document, by its address here.
  if (src.startsWith('/') && !src.startsWith('//') && typeof location !== 'undefined') src = new URL(src, location.href).href;
  if (!/^(data:image\/|https?:|blob:)/i.test(src)) return null;
  const note = image.getAttribute('data-iris-object');
  let place: Partial<PastedPicture> = {};
  if (note) {
    try {
      place = JSON.parse(note) as Partial<PastedPicture>;
    } catch {
      place = {};
    }
  }
  const size = (name: 'width' | 'height') => {
    const value = Number(image.getAttribute(name));
    return place[name] ?? (Number.isFinite(value) && value > 0 ? value : undefined);
  };
  return { src, row, col, dx: Number(place.dx) || 0, dy: Number(place.dy) || 0, width: size('width'), height: size('height') };
}

/** The first table in clipboard HTML, or its pictures alone when there is no table. Null when there is neither. */
export function readHtmlTable(html: string): PastedTable | null {
  if (!html || typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const table = doc.querySelector('table');
  const fromIris = doc.querySelector('[data-iris-sheet]') !== null;
  if (!table) {
    const pictures = [...doc.querySelectorAll('img')].map(image => pictureOf(image, 0, 0)).filter((p): p is PastedPicture => p !== null);
    return pictures.length > 0 ? { cells: [], merges: [], pictures, fromIris } : null;
  }
  const rules = classRules(doc);
  const cells: Array<Array<PastedCell | null>> = [];
  const taken: boolean[][] = [];
  const merges: Rect[] = [];
  const pictures: PastedPicture[] = [];
  let count = 0;
  const rows = [...table.querySelectorAll('tr')].filter(tr => tr.closest('table') === table);
  rows.forEach((tr, row) => {
    let col = 0;
    for (const cell of tr.children) {
      if (cell.tagName !== 'TD' && cell.tagName !== 'TH') continue;
      while (taken[row]?.[col]) col += 1;
      const rowSpan = Math.max(1, Math.min(1000, Number(cell.getAttribute('rowspan')) || 1));
      const colSpan = Math.max(1, Math.min(100, Number(cell.getAttribute('colspan')) || 1));
      count += rowSpan * colSpan;
      if (count > MAX_CELLS) break;
      for (let r = row; r < row + rowSpan; r += 1) {
        for (let c = col; c < col + colSpan; c += 1) {
          (taken[r] ??= [])[c] = true;
          (cells[r] ??= [])[c] = null;
        }
      }
      if (rowSpan > 1 || colSpan > 1) merges.push({ r1: row, c1: col, r2: row + rowSpan - 1, c2: col + colSpan - 1 });
      let style = inlineStyle(cell, rules);
      let raw: CellRaw | undefined = googleValue(cell.getAttribute('data-sheets-value'));
      const irisStyle = cell.getAttribute('data-iris-style');
      if (irisStyle) {
        try {
          style = JSON.parse(irisStyle) as CellStyle;
        } catch {
          // Keep what the CSS said.
        }
      }
      const irisValue = cell.getAttribute('data-iris-value');
      if (irisValue) {
        try {
          const value = JSON.parse(irisValue) as unknown;
          if (typeof value === 'number' || typeof value === 'boolean') raw = value;
        } catch {
          // Read the text instead.
        }
      }
      cells[row][col] = { text: cellText(cell), style, ...(raw !== undefined ? { raw } : {}) };
      for (const image of cell.querySelectorAll('img')) {
        const picture = pictureOf(image, row, col);
        if (picture) pictures.push(picture);
      }
      col += colSpan;
    }
  });
  const width = Math.max(0, ...cells.map(line => line?.length ?? 0));
  const filled = Array.from({ length: cells.length }, (_unused, row) => Array.from({ length: width }, (_unused2, col) => cells[row]?.[col] ?? null));
  // Places no cell reached are empty cells, not merged ones.
  const out = filled.map((line, row) => line.map((cell, col) => cell ?? (taken[row]?.[col] ? null : { text: '', style: {} })));
  return { cells: out, merges, pictures, fromIris };
}
