/**
 * PowerPoint files (.pptx) brought into a deck. Loaded only when someone
 * imports one.
 *
 * What comes across: every slide in order, with its background (a colour,
 * or a picture); text boxes and placeholders, their paragraphs, lists,
 * alignment, bold, italic, underline, strikethrough, colours and sizes,
 * looked up through the slide's layout and master where the slide itself
 * does not say; shapes with fill, line and text (rectangles, rounded
 * rectangles and ellipses as they are, other outlines as rectangles); lines
 * and arrows; pictures, cropped as on the slide, with their descriptions;
 * tables with their column widths, row heights, fills, lines and merged
 * cells; groups, taken apart into what they hold; the shapes and pictures
 * of layouts and masters that show on a slide; speaker notes; fade and
 * slide-in transitions. The deck gets the look of ours nearest to the
 * file's theme. Not carried over: charts, diagrams, video and sound, and
 * pictures in old Windows formats (EMF, WMF).
 */
import * as Y from 'yjs';
import { unzipSync } from 'fflate';
import { Deck, SLIDE_HEIGHT, SLIDE_WIDTH, type Crop, type ElementJson, type ShapeKind, type TextAlign, type TextRole, type VerticalAlign } from './model';
import type { RichTextJson } from './richTextData';
import { cellKey, newTable, type CellJson, type TableJson } from './table';
import { THEMES } from './themes';
import type { Transition } from './motion';
import {
  DEFAULT_COLOUR_MAP,
  all,
  flag,
  hueOf,
  isRounded,
  isSerif,
  kid,
  kids,
  lightness,
  num,
  readColour,
  readFill,
  readTheme,
  readXml,
  relOfType,
  relsOf,
  type ColourContext,
  type Files,
  type ThemeInfo,
} from './pptxRead';

export interface PptxImportTarget {
  ydoc: Y.Doc;
  /** Stores a picture beside the deck and returns the name to refer to it by. */
  addAttachment: (file: File) => Promise<string>;
}

export interface PptxImportOptions {
  /** Takes the place of what the deck has, and gives it the nearest look; otherwise the slides are added at the end. */
  replace?: boolean;
}

export interface PptxImportResult {
  slides: number;
  /** The id of the first slide brought in. */
  firstId: string | null;
  /** The look picked for the deck, when it was replaced. */
  theme: string;
  /** What could not be brought in, in words, for telling the person. */
  skipped: string[];
}

interface Part {
  path: string;
  root: Element;
  rels: ReturnType<typeof relsOf>;
}

interface Scale {
  k: number;
  ox: number;
  oy: number;
}

interface SlideContext {
  files: Files;
  scale: Scale;
  colour: ColourContext;
  slide: Part;
  layout: Part | null;
  master: Part | null;
  defaultStyle: Element | null;
  /** Pictures wanted, by their path in the file. */
  media: Set<string>;
  skipped: Map<string, number>;
}

/** An element as read, with pictures named by their path in the file until they are stored. */
type Planned = ElementJson & { content?: RichTextJson };

interface SlidePlan {
  background?: string;
  elements: Planned[];
  notes: string;
  transition?: Transition;
}

const EMU_PER_POINT = 12700;

function part(files: Files, path: string | null): Part | null {
  if (!path) return null;
  const root = readXml(files, path);
  return root ? { path, root, rels: relsOf(files, path) } : null;
}

function note(context: SlideContext, what: string): void {
  context.skipped.set(what, (context.skipped.get(what) ?? 0) + 1);
}

// Frames

type Transform = (x: number, y: number, w: number, h: number) => { x: number; y: number; w: number; h: number };

function readXfrm(xfrm: Element | null): { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean } | null {
  const off = kid(xfrm, 'off');
  const ext = kid(xfrm, 'ext');
  if (!off || !ext) return null;
  return {
    x: num(off, 'x') ?? 0,
    y: num(off, 'y') ?? 0,
    w: num(ext, 'cx') ?? 0,
    h: num(ext, 'cy') ?? 0,
    rot: (num(xfrm, 'rot') ?? 0) / 60000,
    flipH: flag(xfrm, 'flipH') === true,
    flipV: flag(xfrm, 'flipV') === true,
  };
}

function toSlide(scale: Scale): Transform {
  return (x, y, w, h) => ({ x: x * scale.k + scale.ox, y: y * scale.k + scale.oy, w: w * scale.k, h: h * scale.k });
}

const round = (value: number) => Math.round(value * 10) / 10;

// Placeholders

interface Placeholder {
  type: string;
  idx: string | null;
}

function placeholderOf(shape: Element): Placeholder | null {
  const nv = kids(shape).find(child => child.localName.startsWith('nv'));
  const ph = kid(nv, 'nvPr', 'ph');
  if (!ph) return null;
  return { type: ph.getAttribute('type') ?? 'obj', idx: ph.getAttribute('idx') };
}

function family(type: string): string {
  if (type === 'title' || type === 'ctrTitle') return 'title';
  if (type === 'body' || type === 'subTitle' || type === 'obj') return 'body';
  return type;
}

/** The shape standing for a placeholder in a layout or master: by its number first, then by its kind. */
function findPlaceholder(source: Part | null, wanted: Placeholder, byNumber: boolean): Element | null {
  if (!source) return null;
  const shapes = all(kid(source.root, 'cSld', 'spTree'), 'sp');
  const withPh = shapes.map(shape => ({ shape, ph: placeholderOf(shape) })).filter(entry => entry.ph);
  if (byNumber && wanted.idx !== null) {
    const same = withPh.find(entry => entry.ph!.idx === wanted.idx);
    if (same) return same.shape;
  }
  return withPh.find(entry => entry.ph!.type === wanted.type)?.shape
    ?? withPh.find(entry => family(entry.ph!.type) === family(wanted.type))?.shape ?? null;
}

/** The shape itself, then what it inherits from: the layout's placeholder, then the master's. */
function chainOf(shape: Element, context: SlideContext, ph: Placeholder | null): Element[] {
  if (!ph) return [shape];
  const layoutShape = findPlaceholder(context.layout, ph, true);
  const masterShape = findPlaceholder(context.master, layoutShape ? placeholderOf(layoutShape) ?? ph : ph, false);
  return [shape, layoutShape, masterShape].filter((entry): entry is Element => !!entry);
}

// Text

interface Run {
  text: string;
  hardBreak?: boolean;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  size: number;
  colour: string | null;
}

interface Paragraph {
  align: TextAlign;
  list: 'bullet' | 'number' | null;
  level: number;
  runs: Run[];
}

/** The style of each level from the most to the least particular: the shape's own list style, its placeholders', the master's. */
function levelStyles(chain: Element[], kindStyle: Element | null, defaultStyle: Element | null, level: number): Element[] {
  const name = `lvl${level + 1}pPr`;
  const styles: Element[] = [];
  for (const shape of chain) {
    const style = kid(kid(shape, 'txBody') ?? kid(shape, 'textBody'), 'lstStyle', name);
    if (style) styles.push(style);
  }
  for (const source of [kindStyle, defaultStyle]) {
    const style = kid(source, name);
    if (style) styles.push(style);
  }
  return styles;
}

function firstAttribute(elements: Array<Element | null>, attribute: string): string | null {
  for (const element of elements) {
    const value = element?.getAttribute(attribute);
    if (value !== null && value !== undefined) return value;
  }
  return null;
}

function readParagraphs(body: Element | null, chain: Element[], kindStyle: Element | null, context: SlideContext, defaultColour: string | null, fontScale: number): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  for (const p of kids(body, 'p')) {
    const pPr = kid(p, 'pPr');
    const level = Math.min(8, num(pPr, 'lvl') ?? 0);
    const styles = levelStyles(chain, kindStyle, context.defaultStyle, level);
    const algn = firstAttribute([pPr, ...styles], 'algn');
    const bulletSource = [pPr, ...styles].find(style => style && (kid(style, 'buNone') || kid(style, 'buChar') || kid(style, 'buAutoNum') || kid(style, 'buBlip')));
    const list = !bulletSource || kid(bulletSource, 'buNone') ? null : kid(bulletSource, 'buAutoNum') ? 'number' : 'bullet';
    const defaults = [kid(pPr, 'defRPr'), ...styles.map(style => kid(style, 'defRPr'))];
    const runs: Run[] = [];
    for (const child of kids(p)) {
      if (child.localName === 'br') {
        runs.push({ text: '', hardBreak: true, bold: false, italic: false, underline: false, strike: false, size: 0, colour: null });
        continue;
      }
      if (child.localName !== 'r' && child.localName !== 'fld') continue;
      const text = kid(child, 't')?.textContent ?? '';
      if (!text) continue;
      const rPr = kid(child, 'rPr');
      const props = [rPr, ...defaults];
      const size = Number(firstAttribute(props, 'sz') ?? 1800) / 100 * fontScale;
      const fillSource = props.find(style => style && (kid(style, 'solidFill') || kid(style, 'gradFill')));
      const fill = fillSource ? readFill(fillSource, context.colour) : undefined;
      const underline = firstAttribute(props, 'u');
      const strike = firstAttribute(props, 'strike');
      runs.push({
        text,
        bold: ['1', 'true'].includes(firstAttribute(props, 'b') ?? ''),
        italic: ['1', 'true'].includes(firstAttribute(props, 'i') ?? ''),
        underline: !!underline && underline !== 'none',
        strike: !!strike && strike !== 'noStrike',
        size: size * EMU_PER_POINT * context.scale.k,
        colour: fill && fill !== 'none' ? fill : defaultColour,
      });
    }
    paragraphs.push({ align: algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : 'left', list, level, runs });
  }
  return paragraphs;
}

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  let best: T | undefined;
  let bestCount = 0;
  for (const value of values) {
    const count = (counts.get(value) ?? 0) + 1;
    counts.set(value, count);
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/** Paragraphs as rich text, with what most of the text has as the box's own size, colour and alignment. */
function richText(paragraphs: Paragraph[]): { content: RichTextJson; fontSize?: number; color?: string; align?: TextAlign; empty: boolean } {
  const runs = paragraphs.flatMap(paragraph => paragraph.runs.filter(run => !run.hardBreak));
  const fontSize = mostCommon(runs.map(run => Math.round(run.size)));
  const color = mostCommon(runs.map(run => run.colour).filter((colour): colour is string => !!colour));
  const align = mostCommon(paragraphs.filter(paragraph => paragraph.runs.length).map(paragraph => paragraph.align)) ?? paragraphs[0]?.align;
  const top: RichTextJson = [];
  const stack: Array<{ list: { name: string; attrs: Record<string, unknown>; children: RichTextJson }; kind: 'bullet' | 'number' }> = [];
  for (const paragraph of paragraphs) {
    const children: RichTextJson = [];
    let text: Array<{ insert: string; attributes?: Record<string, unknown> }> = [];
    for (const run of paragraph.runs) {
      if (run.hardBreak) {
        if (text.length) children.push({ text });
        text = [];
        children.push({ name: 'hardBreak', attrs: {}, children: [] });
        continue;
      }
      const attributes: Record<string, unknown> = {};
      if (run.bold) attributes.bold = {};
      if (run.italic) attributes.italic = {};
      if (run.underline) attributes.underline = {};
      if (run.strike) attributes.strike = {};
      if (Math.round(run.size) !== fontSize) attributes.fontSize = { size: Math.round(run.size) };
      if (run.colour && run.colour !== color) attributes.color = { color: run.colour };
      text.push(Object.keys(attributes).length ? { insert: run.text, attributes } : { insert: run.text });
    }
    if (text.length) children.push({ text });
    const node = { name: 'paragraph', attrs: paragraph.align !== align ? { textAlign: paragraph.align } : {}, children };
    if (!paragraph.list) {
      stack.length = 0;
      top.push(node);
      continue;
    }
    const depth = Math.min(paragraph.level, stack.length);
    stack.length = Math.min(stack.length, depth + 1);
    if (stack.length === depth + 1 && stack[depth]!.kind !== paragraph.list) stack.length = depth;
    if (stack.length === depth) {
      const list = { name: paragraph.list === 'number' ? 'orderedList' : 'bulletList', attrs: {}, children: [] as RichTextJson };
      if (depth === 0) top.push(list);
      else (stack[depth - 1]!.list.children.at(-1) as { children: RichTextJson }).children.push(list);
      stack.push({ list, kind: paragraph.list });
    }
    stack[depth]!.list.children.push({ name: 'listItem', attrs: {}, children: [node] });
  }
  return { content: top, fontSize, color, align, empty: runs.every(run => !run.text.trim()) };
}

function anchorOf(chain: Element[]): VerticalAlign | undefined {
  const anchor = firstAttribute(chain.map(shape => kid(kid(shape, 'txBody'), 'bodyPr')), 'anchor');
  return anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : anchor === 't' ? 'top' : undefined;
}

function styleColour(shape: Element, which: string, context: SlideContext): string | null {
  const ref = kid(shape, 'style', which);
  if (!ref || (which !== 'fontRef' && (num(ref, 'idx') ?? 0) === 0)) return null;
  return readColour(ref, context.colour);
}

// Elements

function frameFor(chain: Element[], spPrName: string, transform: Transform): { x: number; y: number; w: number; h: number; rot: number; flipH: boolean; flipV: boolean } | null {
  for (const shape of chain) {
    const raw = readXfrm(kid(kid(shape, spPrName), 'xfrm'));
    if (!raw) continue;
    const frame = transform(raw.x, raw.y, raw.w, raw.h);
    return { ...frame, rot: raw.rot, flipH: raw.flipH, flipV: raw.flipV };
  }
  return null;
}

function pictureElement(blipFill: Element, owner: Part, frame: { x: number; y: number; w: number; h: number; rot: number }, alt: string | null, context: SlideContext): Planned | null {
  const id = kid(blipFill, 'blip')?.getAttribute('r_embed');
  const rel = id ? owner.rels.get(id) : undefined;
  if (!rel || rel.external || !context.files[rel.path]) {
    note(context, 'pictures that are linked rather than in the file');
    return null;
  }
  if (!/\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(rel.path)) {
    note(context, 'pictures in formats browsers cannot show (such as EMF)');
    return null;
  }
  context.media.add(rel.path);
  const rect = kid(blipFill, 'srcRect');
  const share = (name: string) => Math.max(0, (num(rect, name) ?? 0) / 100000);
  const crop: Crop = [share('l'), share('t'), share('r'), share('b')];
  const element: Planned = { type: 'image', src: rel.path, x: round(frame.x), y: round(frame.y), w: round(frame.w), h: round(frame.h), rot: round(frame.rot) };
  if (crop.some(Boolean) && crop[0] + crop[2] < 0.98 && crop[1] + crop[3] < 0.98) element.crop = crop;
  if (alt?.trim()) element.alt = alt.trim();
  return element;
}

function lineElement(shape: Element, chain: Element[], transform: Transform, context: SlideContext): Planned | null {
  const frame = frameFor(chain, 'spPr', transform);
  if (!frame) return null;
  const ln = kid(kid(shape, 'spPr'), 'ln');
  const fill = readFill(ln, context.colour) ?? styleColour(shape, 'lnRef', context) ?? undefined;
  if (fill === 'none') return null;
  let x = frame.x;
  let y = frame.y;
  let w = frame.w;
  let h = frame.h;
  if (frame.flipH) {
    x += w;
    w = -w;
  }
  if (frame.flipV) {
    y += h;
    h = -h;
  }
  const head = kid(ln, 'headEnd')?.getAttribute('type');
  const tail = kid(ln, 'tailEnd')?.getAttribute('type');
  // Only the far end of our lines carries an arrowhead: a line with one at its start is drawn the other way round.
  if (head && head !== 'none' && (!tail || tail === 'none')) {
    x += w;
    y += h;
    w = -w;
    h = -h;
  }
  const element: Planned = { type: 'line', x: round(x), y: round(y), w: round(w), h: round(h), rot: 0 };
  if (fill) element.stroke = fill;
  const width = num(ln, 'w');
  element.strokeWidth = round(Math.max(0.5, (width ?? 12700) * context.scale.k));
  if ((head && head !== 'none') || (tail && tail !== 'none')) element.arrow = true;
  return element;
}

function shapeKindOf(shape: Element): ShapeKind | 'line' | null {
  const preset = kid(kid(shape, 'spPr'), 'prstGeom')?.getAttribute('prst');
  if (!preset) return kid(kid(shape, 'spPr'), 'custGeom') ? 'rect' : null;
  if (preset === 'line' || preset.includes('Connector')) return 'line';
  if (preset === 'ellipse' || preset === 'circle') return 'ellipse';
  if (preset.startsWith('round') || preset === 'flowChartAlternateProcess') return 'round';
  return 'rect';
}

function textShape(shape: Element, owner: Part, transform: Transform, context: SlideContext, fromSlide: boolean): Planned[] {
  const ph = placeholderOf(shape);
  if (ph && !fromSlide) return [];
  if (ph && ['dt', 'ftr', 'sldNum', 'hdr'].includes(ph.type)) return [];
  const chain = chainOf(shape, context, ph);
  const kind = shapeKindOf(shape);
  if (kind === 'line') {
    const line = lineElement(shape, chain, transform, context);
    return line ? [line] : [];
  }
  const frame = frameFor(chain, 'spPr', transform);
  if (!frame) return [];
  const spPr = kid(shape, 'spPr');
  const blip = kid(spPr, 'blipFill');
  if (blip) {
    const picture = pictureElement(blip, owner, frame, kid(kid(shape, 'nvSpPr'), 'cNvPr')?.getAttribute('descr') ?? null, context);
    return picture ? [picture] : [];
  }
  const fill = readFill(spPr, context.colour) ?? (kid(spPr, 'noFill') ? 'none' : styleColour(shape, 'fillRef', context) ?? undefined);
  const ln = kid(spPr, 'ln');
  const stroke = readFill(ln, context.colour) ?? (kid(ln, 'noFill') ? 'none' : styleColour(shape, 'lnRef', context) ?? undefined);
  const visible = (fill && fill !== 'none') || (stroke && stroke !== 'none');
  const role: TextRole | undefined = ph ? (family(ph.type) === 'title' ? 'title' : ph.type === 'subTitle' ? 'subtitle' : family(ph.type) === 'body' ? 'body' : undefined) : undefined;
  const masterStyles = kid(context.master?.root, 'txStyles');
  const kindStyle = role === 'title' ? kid(masterStyles, 'titleStyle') : ph ? kid(masterStyles, 'bodyStyle') : kid(masterStyles, 'otherStyle');
  const body = kid(shape, 'txBody');
  const fontScale = (num(kid(kid(body, 'bodyPr'), 'normAutofit'), 'fontScale') ?? 100000) / 100000;
  const defaultColour = styleColour(shape, 'fontRef', context);
  const text = richText(readParagraphs(body, chain, kindStyle, context, defaultColour, fontScale));
  if (!visible && text.empty && !role) return [];
  if (!visible && text.empty && role && role !== 'title' && role !== 'subtitle' && role !== 'body') return [];
  const isShape = !!visible && !ph && kind !== null && !(kid(kid(shape, 'nvSpPr'), 'cNvSpPr')?.getAttribute('txBox') === '1' && !fill);
  const element: Planned = {
    type: isShape ? 'shape' : 'text',
    x: round(frame.x),
    y: round(frame.y),
    w: round(frame.w),
    h: round(frame.h),
    rot: round(frame.rot),
    content: text.content,
  };
  if (isShape) {
    element.shape = (kind ?? 'rect') as ShapeKind;
    element.fill = fill ?? 'none';
    if (stroke && stroke !== 'none') {
      element.stroke = stroke;
      element.strokeWidth = round(Math.max(0.5, (num(ln, 'w') ?? 12700) * context.scale.k));
    }
    if (shapeKindOf(shape) === 'rect' && !['rect', undefined].includes(kid(spPr, 'prstGeom')?.getAttribute('prst') ?? undefined)) note(context, 'outlines other than rectangles and ellipses, drawn as rectangles');
  } else if (role) {
    element.role = role;
  }
  if (text.fontSize) element.fontSize = text.fontSize;
  if (text.color) element.color = text.color;
  if (text.align) element.align = text.align;
  const valign = anchorOf(chain);
  if (valign) element.valign = valign;
  return [element];
}

function tableElement(frame: Element, transform: Transform, context: SlideContext): Planned | null {
  const tbl = kid(frame, 'graphic', 'graphicData', 'tbl');
  const xfrm = readXfrm(kid(frame, 'xfrm'));
  if (!tbl || !xfrm) return null;
  const box = transform(xfrm.x, xfrm.y, xfrm.w, xfrm.h);
  const widths = kids(kid(tbl, 'tblGrid'), 'gridCol').map(col => Math.max(1, num(col, 'w') ?? 1));
  const rows = kids(tbl, 'tr');
  if (!widths.length || !rows.length) return null;
  const table: TableJson = newTable(rows.length, widths.length);
  if (table.rows.length !== rows.length || table.cols.length !== widths.length) return null;
  const heights = rows.map(row => Math.max(1, num(row, 'h') ?? 370840));
  table.cols.forEach((col, index) => (col.size = Math.round(widths[index]! / 10000) / 100));
  table.rows.forEach((row, index) => (row.size = Math.round(heights[index]! / 10000) / 100));
  const header = flag(kid(tbl, 'tblPr'), 'firstRow') === true;
  const sizes: number[] = [];
  const colours: string[] = [];
  let anyFill = false;
  const otherStyle = kid(kid(context.master?.root, 'txStyles'), 'otherStyle');
  rows.forEach((tr, r) => {
    kids(tr, 'tc').forEach((tc, c) => {
      const row = table.rows[r];
      const col = table.cols[c];
      if (!row || !col) return;
      const key = cellKey(row.id, col.id);
      const text = richText(readParagraphs(kid(tc, 'txBody'), [tc], otherStyle, context, null, 1));
      if (text.fontSize) sizes.push(text.fontSize);
      if (text.color) colours.push(text.color);
      const cell: CellJson = { content: text.content };
      const tcPr = kid(tc, 'tcPr');
      const fill = readFill(tcPr, context.colour);
      if (fill) {
        cell.fill = fill;
        anyFill = true;
      }
      for (const [tag, side] of [['lnL', 'bl'], ['lnR', 'br'], ['lnT', 'bt'], ['lnB', 'bb']] as const) {
        const ln = kid(tcPr, tag);
        if (!ln) continue;
        const colour = readFill(ln, context.colour);
        if (colour === 'none' || (num(ln, 'w') ?? 1) === 0) cell[side] = 'none';
        else if (colour) cell[side] = `${round(Math.max(0.5, (num(ln, 'w') ?? 12700) * context.scale.k))} ${colour}`;
      }
      const spanCols = num(tc, 'gridSpan') ?? 1;
      const spanRows = num(tc, 'rowSpan') ?? 1;
      if (spanCols > 1 || spanRows > 1) {
        const endRow = table.rows[Math.min(table.rows.length - 1, r + spanRows - 1)]!;
        const endCol = table.cols[Math.min(table.cols.length - 1, c + spanCols - 1)]!;
        cell.merge = cellKey(endRow.id, endCol.id);
      }
      table.cells[key] = cell;
    });
  });
  // A heading row drawn by the file's table style comes out as ours, unless the cells say otherwise.
  const element: Planned = { type: 'table', x: round(box.x), y: round(box.y), w: round(box.w), h: round(box.h), rot: round(xfrm.rot), table };
  if (header && !anyFill) element.header = true;
  const size = mostCommon(sizes);
  if (size) element.fontSize = size;
  const colour = mostCommon(colours);
  if (colour) element.color = colour;
  return element;
}

/** The elements of a shape tree, in stacking order, groups taken apart. */
function readTree(tree: Element | null, owner: Part, transform: Transform, context: SlideContext, fromSlide: boolean): Planned[] {
  const out: Planned[] = [];
  for (const child of kids(tree)) {
    const nv = kids(child).find(node => node.localName.startsWith('nv'));
    if (kid(nv, 'cNvPr')?.getAttribute('hidden') === '1') continue;
    if (child.localName === 'sp') {
      out.push(...textShape(child, owner, transform, context, fromSlide));
    } else if (child.localName === 'cxnSp') {
      const line = lineElement(child, [child], transform, context);
      if (line) out.push(line);
    } else if (child.localName === 'pic') {
      const ph = placeholderOf(child);
      const chain = ph ? chainOf(child, context, ph) : [child];
      const frame = frameFor(chain, 'spPr', transform);
      const blip = kid(child, 'blipFill');
      const picture = frame && blip ? pictureElement(blip, owner, frame, kid(nv, 'cNvPr')?.getAttribute('descr') ?? null, context) : null;
      if (picture) out.push(picture);
    } else if (child.localName === 'graphicFrame') {
      const uri = kid(child, 'graphic', 'graphicData')?.getAttribute('uri') ?? '';
      if (uri.endsWith('/table')) {
        const table = tableElement(child, transform, context);
        if (table) out.push(table);
      } else {
        note(context, uri.includes('chart') ? 'charts' : 'diagrams and other embedded objects');
      }
    } else if (child.localName === 'grpSp') {
      const xfrm = kid(kid(child, 'grpSpPr'), 'xfrm');
      const own = readXfrm(xfrm);
      const chOff = kid(xfrm, 'chOff');
      const chExt = kid(xfrm, 'chExt');
      if (!own || !chOff || !chExt) {
        out.push(...readTree(child, owner, transform, context, fromSlide));
        continue;
      }
      const sx = own.w / Math.max(1, num(chExt, 'cx') ?? own.w);
      const sy = own.h / Math.max(1, num(chExt, 'cy') ?? own.h);
      const cx = num(chOff, 'x') ?? 0;
      const cy = num(chOff, 'y') ?? 0;
      const inner: Transform = (x, y, w, h) => transform(own.x + (x - cx) * sx, own.y + (y - cy) * sy, w * sx, h * sy);
      out.push(...readTree(child, owner, inner, context, fromSlide));
    }
  }
  return out;
}

/** A slide's background: its colour, or a picture to lay under everything. */
function backgroundOf(parts: Array<Part | null>, context: SlideContext): { colour?: string; picture?: Planned } {
  for (const source of parts) {
    const bg = kid(source?.root, 'cSld', 'bg');
    if (!bg || !source) continue;
    const bgPr = kid(bg, 'bgPr');
    if (bgPr) {
      const blip = kid(bgPr, 'blipFill');
      if (blip) {
        const picture = pictureElement(blip, source, { x: 0, y: 0, w: SLIDE_WIDTH, h: SLIDE_HEIGHT, rot: 0 }, null, context);
        if (picture) return { picture };
      }
      const fill = readFill(bgPr, context.colour);
      if (fill && fill !== 'none') return { colour: fill };
    }
    const colour = readColour(kid(bg, 'bgRef'), context.colour);
    if (colour) return { colour };
  }
  return {};
}

function notesOf(files: Files, slide: Part): string {
  const notes = part(files, relOfType(slide.rels, 'notesSlide'));
  if (!notes) return '';
  const body = all(notes.root, 'sp').find(shape => placeholderOf(shape)?.type === 'body');
  return kids(kid(body, 'txBody'), 'p').map(p => all(p, 't').map(t => t.textContent ?? '').join('')).join('\n').trim();
}

function transitionOf(slide: Part): Transition | undefined {
  const transition = all(slide.root, 'transition')[0];
  const kind = kids(transition)[0]?.localName;
  if (!kind) return undefined;
  return kind === 'fade' || kind === 'dissolve' ? 'fade' : 'slide';
}

/** Of our looks, the one nearest to a file's theme: light or dark, the hue of its accent, and its fonts. */
export function nearestTheme(theme: ThemeInfo, background: string | null): string {
  const page = background ?? `#${theme.colours.lt1 ?? 'FFFFFF'}`;
  const accent = `#${theme.colours.accent1 ?? '4472C4'}`;
  const serif = isSerif(theme.majorFont) || isSerif(theme.minorFont);
  const rounded = isRounded(theme.majorFont) || isRounded(theme.minorFont);
  const want = hueOf(accent);
  let best = THEMES[0]!.id;
  let bestScore = Infinity;
  for (const candidate of THEMES) {
    const ours = hueOf(candidate.base.accent);
    const hue = Math.min(Math.abs(ours.hue - want.hue), 360 - Math.abs(ours.hue - want.hue)) / 180;
    const dark = Math.abs(lightness(candidate.base.background) - lightness(page)) * 3;
    const fonts = (serif !== candidate.titleFont.includes('Georgia') ? 0.8 : 0) + (rounded !== candidate.titleFont.includes('rounded') ? 0.5 : 0);
    const score = dark + hue * (want.saturation > 0.2 ? 1 : 0.2) + fonts;
    if (score < bestScore) {
      bestScore = score;
      best = candidate.id;
    }
  }
  return best;
}

function fileType(path: string): string {
  const ext = path.split('.').pop()!.toLowerCase();
  return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp' } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

/**
 * Reads a PowerPoint file and puts its slides into a deck's Yjs document,
 * as one step that undo takes back. Pictures are stored first, then
 * everything is written at once.
 */
export async function importPptx(source: Uint8Array | Blob, target: PptxImportTarget, options: PptxImportOptions = {}): Promise<PptxImportResult> {
  const bytes = source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer());
  let files: Files;
  try {
    files = unzipSync(bytes, { filter: file => !file.name.startsWith('ppt/embeddings/') });
  } catch {
    throw new Error('This file is not a PowerPoint presentation.');
  }
  const presentation = part(files, 'ppt/presentation.xml');
  if (!presentation) throw new Error('This file is not a PowerPoint presentation.');
  const size = kid(presentation.root, 'sldSz');
  const cx = num(size, 'cx') ?? 12192000;
  const cy = num(size, 'cy') ?? 6858000;
  const k = Math.min(SLIDE_WIDTH / cx, SLIDE_HEIGHT / cy);
  const scale: Scale = { k, ox: (SLIDE_WIDTH - cx * k) / 2, oy: (SLIDE_HEIGHT - cy * k) / 2 };
  const defaultStyle = kid(presentation.root, 'defaultTextStyle');
  const slidePaths = kids(kid(presentation.root, 'sldIdLst'), 'sldId')
    .map(entry => presentation.rels.get(entry.getAttribute('r_id') ?? '')?.path)
    .filter((path): path is string => !!path && !!files[path]);

  const media = new Set<string>();
  const skipped = new Map<string, number>();
  const plans: SlidePlan[] = [];
  let firstTheme: ThemeInfo | null = null;
  let firstBackground: string | null = null;
  for (const path of slidePaths) {
    const slide = part(files, path)!;
    const layout = part(files, relOfType(slide.rels, 'slideLayout'));
    const master = layout ? part(files, relOfType(layout.rels, 'slideMaster')) : null;
    const theme = readTheme(master ? readXml(files, relOfType(master.rels, 'theme') ?? '') : null);
    firstTheme ??= theme;
    const map: Record<string, string> = { ...DEFAULT_COLOUR_MAP };
    for (const attribute of kid(master?.root, 'clrMap')?.attributes ?? []) map[attribute.localName] = attribute.value;
    for (const source of [layout, slide]) {
      for (const attribute of kid(kid(source?.root, 'clrMapOvr'), 'overrideClrMapping')?.attributes ?? []) map[attribute.localName] = attribute.value;
    }
    const context: SlideContext = { files, scale, colour: { theme, map }, slide, layout, master, defaultStyle, media, skipped };
    const transform = toSlide(scale);
    const elements: Planned[] = [];
    const background = backgroundOf([slide, layout, master], context);
    if (background.picture) elements.push(background.picture);
    // What the master and the layout show on every slide comes first, at the back.
    const slideShows = flag(slide.root, 'showMasterSp') !== false;
    const layoutShows = flag(layout?.root, 'showMasterSp') !== false;
    if (master && slideShows && layoutShows) elements.push(...readTree(kid(master.root, 'cSld', 'spTree'), master, transform, context, false));
    if (layout && slideShows) elements.push(...readTree(kid(layout.root, 'cSld', 'spTree'), layout, transform, context, false));
    elements.push(...readTree(kid(slide.root, 'cSld', 'spTree'), slide, transform, context, true));
    firstBackground ??= background.colour ?? null;
    plans.push({ background: background.colour, elements, notes: notesOf(files, slide), transition: transitionOf(slide) });
  }
  if (plans.length === 0) throw new Error('This presentation has no slides.');

  // Pictures are stored before anything is written, so the slides arrive whole.
  const stored = new Map<string, string>();
  for (const path of media) {
    try {
      const name = path.split('/').pop() ?? 'picture.png';
      stored.set(path, await target.addAttachment(new File([files[path]! as BlobPart], name, { type: fileType(path) })));
    } catch (error) {
      console.error('[Slides] Could not store a picture of the PowerPoint file:', error);
      skipped.set('pictures that could not be stored', (skipped.get('pictures that could not be stored') ?? 0) + 1);
    }
  }

  const deck = new Deck(target.ydoc);
  const theme = options.replace && firstTheme ? nearestTheme(firstTheme, firstBackground) : deck.theme;
  let firstId: string | null = null;
  deck.transact(() => {
    if (options.replace) {
      deck.start(theme);
      deck.meta.set('theme', theme);
      deck.deleteSlides(deck.slideIds());
    }
    let after = deck.slideIds().at(-1) ?? null;
    for (const plan of plans) {
      const id = deck.addSlide('blank', [], after, plan.background);
      firstId ??= id;
      after = id;
      const elements = plan.elements.flatMap((element) => {
        if (element.type !== 'image') return [element];
        const src = element.src ? stored.get(element.src) : undefined;
        return src ? [{ ...element, src }] : [];
      });
      deck.addElements(id, elements);
      if (plan.notes) deck.setNotes(id, plan.notes);
      if (plan.transition) deck.setSlideMotion([id], { transition: plan.transition });
    }
  });
  return {
    slides: plans.length,
    firstId,
    theme,
    skipped: [...skipped].map(([what, count]) => `${count} ${what}`),
  };
}
