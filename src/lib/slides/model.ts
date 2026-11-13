/**
 * The presentation format, version 1. Everything a deck keeps lives in its
 * Yjs document, laid out so that edits from several devices merge well:
 *
 *   deck    Y.Map   version: 1
 *                   theme:   id of a theme in themes.ts
 *   slides  Y.Map   <slide id> → Y.Map
 *                     pos         position key (see order.ts): where the slide sits in the deck
 *                     layout      id of the layout it was made from (layouts.ts)
 *                     background  colour, when it differs from the theme's
 *                     seed        true on the slide a new deck was given by itself, so that two
 *                                 devices opening a new deck at once end up with one such slide
 *                     seedBy      the browser that made that slide, so it can still tidy it away
 *                                 after a reload
 *                     transition  how it comes on screen when presenting: 'fade' or 'slide' (none when absent)
 *                     build       true when its points are shown one at a time (see motion.ts)
 *                     notes       Y.Text, the speaker notes
 *                     elements    Y.Map  <element id> → Y.Map
 *                                   type     'text' | 'shape' | 'line' | 'image'
 *                                   z        position key: stacking order, lowest first
 *                                   x y w h  the frame, in slide units (a slide is 1280 × 720)
 *                                   rot      rotation in degrees, clockwise, about the centre
 *                                   …        one key per property, listed in SlideElement below
 *                                   content  Y.XmlFragment, the rich text of a text box or shape
 *                                            (paragraphs and lists, as tiptap stores them; a
 *                                            paragraph may carry `textAlign`, marks are bold,
 *                                            italic, underline, strike, color {color} and
 *                                            fontSize {size})
 *
 * Slides and elements are found by id and never copied to move them: order
 * is a key each one carries, so reordering is one value written to one thing
 * and cannot duplicate or lose it. Every property is its own key, so one
 * person moving a box while another recolours it both keep their change.
 * A line uses its frame as a vector: from (x, y) to (x + w, y + h).
 *
 * Colours are '#rrggbb', 'none', or the name of a theme colour ('text',
 * 'muted', 'accent', 'background', 'onAccent'), which follows the theme.
 * Images name a file in the deck's `attachments` folder.
 *
 * Readers ignore keys and values they do not understand and fall back to
 * defaults, so later versions can add properties. A change that older
 * readers would show wrongly must raise `version`; a deck with a higher
 * version than this code knows opens for viewing only.
 */
import * as Y from 'yjs';
import { comparePositions, keyBetween, keysBetween, readKey } from './order';
import {
  eachText,
  paragraphsFromText,
  richTextIsEmpty,
  richTextNodesFromJson,
  richTextToJson,
  richTextToPlain,
  type RichTextJson,
} from './richTextData';
import { readTransition, type Transition } from './motion';
import {
  clearCells,
  ensureCell,
  insertLine,
  mergeCells,
  readTable,
  removeLine,
  setCellBorders,
  setCellFill,
  setLineSize,
  tableFragments,
  tableNeedsV3,
  tableToJson,
  unmergeCells,
  writeTable,
  type BorderChoice,
  type CellBorder,
  type CellRect,
  type TableData,
  type TableJson,
} from './table';

export { richTextIsEmpty, richTextToJson, richTextToPlain, type RichTextJson };

/** The newest version of the format this code reads and writes. */
export const DECK_VERSION = 3;
/** What a new deck is written as: tables raise it to 2, since older code would drop them when copying. */
const FIRST_VERSION = 1;
const TABLE_VERSION = 2;
/**
 * Merged table cells, lines given to single cells and cropped pictures raise
 * it to 3: code of version 2 would draw them as if they were not there.
 */
const V3 = 3;
export const SLIDE_WIDTH = 1280;
export const SLIDE_HEIGHT = 720;

/** Transaction origin of edits made in this editor; the only ones undo reverts. */
export const LOCAL_ORIGIN = 'slides';

export type ElementType = 'text' | 'shape' | 'line' | 'image' | 'table';
export type ShapeKind = 'rect' | 'round' | 'ellipse';
export type TextRole = 'title' | 'subtitle' | 'body';
export type TextAlign = 'left' | 'center' | 'right';
export type VerticalAlign = 'top' | 'middle' | 'bottom';

/** Shares of a picture cut off: left, top, right, bottom; each from 0, and together leaving some of it. */
export type Crop = [number, number, number, number];

export interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
}

export interface SlideElement extends Frame {
  id: string;
  type: ElementType;
  z: string;
  /** Text boxes and shapes. */
  content?: Y.XmlFragment;
  /** What a text box is for; sets its default look and its hint while empty. */
  role?: TextRole;
  fontSize?: number;
  color?: string;
  align?: TextAlign;
  valign?: VerticalAlign;
  /** Shapes. */
  shape?: ShapeKind;
  fill?: string;
  /** Shapes and lines. */
  stroke?: string;
  strokeWidth?: number;
  /** Lines: whether the far end has an arrowhead. */
  arrow?: boolean;
  /** Images: the attachment's file name. */
  src?: string;
  /** Images: what a screen reader says for it, and what PowerPoint keeps as its description. */
  alt?: string;
  /** Images: the share of the picture cut off at its left, top, right and bottom (version 3). */
  crop?: Crop;
  /** Tables: the grid and its cells (see table.ts), and whether the first row is a heading. */
  table?: TableData;
  header?: boolean;
}

export interface Slide {
  id: string;
  pos: string;
  layout: string;
  background?: string;
  /** The slide a new deck started with by itself. */
  seed?: boolean;
  /** The browser that made it, when known. */
  seedBy?: string;
  transition?: Transition;
  build?: boolean;
  notes: Y.Text | null;
  /** Lowest first. */
  elements: SlideElement[];
}

/** What is drawn in place of an element's stored frame, grid or crop while it is being dragged. */
export type ElementOverride = Partial<Frame> & { table?: TableData; crop?: Crop };

/** The properties of an element that can be written, apart from its text. */
export type ElementProps = Partial<Omit<SlideElement, 'id' | 'content' | 'table'>>;

/** A new element: its properties and, optionally, the text it starts with, one paragraph per line. */
export interface ElementInit extends ElementProps {
  type: ElementType;
  text?: string;
  table?: TableJson;
}

export interface ElementJson extends ElementProps {
  type: ElementType;
  content?: RichTextJson;
  table?: TableJson;
}

const ELEMENT_TYPES: ReadonlySet<string> = new Set(['text', 'shape', 'line', 'image', 'table']);
const SHAPES: ReadonlySet<string> = new Set(['rect', 'round', 'ellipse']);
const ROLES: ReadonlySet<string> = new Set(['title', 'subtitle', 'body']);
const ALIGNS: ReadonlySet<string> = new Set(['left', 'center', 'right']);
const VALIGNS: ReadonlySet<string> = new Set(['top', 'middle', 'bottom']);
const WRITABLE_KEYS = [
  'type', 'z', 'x', 'y', 'w', 'h', 'rot', 'role', 'fontSize', 'color', 'align', 'valign',
  'shape', 'fill', 'stroke', 'strokeWidth', 'arrow', 'src', 'header', 'alt', 'crop',
] as const;

export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let id = '';
  for (const byte of bytes) id += (byte % 36).toString(36);
  return id;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length < 200 ? value : undefined;
}

function altText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.slice(0, 2000) : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: ReadonlySet<string>): T | undefined {
  return typeof value === 'string' && allowed.has(value) ? value as T : undefined;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** A crop as stored, or undefined when it is not one or cuts nothing. */
export function readCrop(value: unknown): Crop | undefined {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const parts = value.map(part => (typeof part === 'number' && Number.isFinite(part) ? Math.min(0.98, Math.max(0, part)) : NaN));
  if (parts.some(Number.isNaN)) return undefined;
  const [l, t, r, b] = parts as Crop;
  if (l + r > 0.98 || t + b > 0.98) return undefined;
  return l || t || r || b ? [l, t, r, b] : undefined;
}

function hasContent(type: ElementType): boolean {
  return type === 'text' || type === 'shape';
}

/** Reads an element, or null when what is stored is not one. */
export function readElement(id: string, map: unknown): SlideElement | null {
  if (!(map instanceof Y.Map)) return null;
  const type = oneOf<ElementType>(map.get('type'), ELEMENT_TYPES);
  if (!type) return null;
  const content = map.get('content');
  const element: SlideElement = {
    id,
    type,
    z: readKey(map.get('z')),
    x: finite(map.get('x'), 0),
    y: finite(map.get('y'), 0),
    w: finite(map.get('w'), 100),
    h: finite(map.get('h'), 100),
    rot: finite(map.get('rot'), 0),
  };
  if (hasContent(type) && content instanceof Y.XmlFragment) element.content = content;
  if (type === 'table') {
    const table = readTable(map);
    if (!table) return null;
    element.table = table;
  }
  const optional: ElementProps = {
    role: oneOf<TextRole>(map.get('role'), ROLES),
    fontSize: positive(map.get('fontSize')),
    color: text(map.get('color')),
    align: oneOf<TextAlign>(map.get('align'), ALIGNS),
    valign: oneOf<VerticalAlign>(map.get('valign'), VALIGNS),
    shape: type === 'shape' ? oneOf<ShapeKind>(map.get('shape'), SHAPES) ?? 'rect' : undefined,
    fill: text(map.get('fill')),
    stroke: text(map.get('stroke')),
    strokeWidth: positive(map.get('strokeWidth')),
    arrow: map.get('arrow') === true ? true : undefined,
    header: type === 'table' && map.get('header') === true ? true : undefined,
    src: text(map.get('src')),
    alt: type === 'image' ? altText(map.get('alt')) : undefined,
    crop: type === 'image' ? readCrop(map.get('crop')) : undefined,
  };
  for (const [key, value] of Object.entries(optional)) {
    if (value !== undefined) (element as unknown as Record<string, unknown>)[key] = value;
  }
  return element;
}

export function readSlide(id: string, map: unknown): Slide | null {
  if (!(map instanceof Y.Map)) return null;
  const elements: SlideElement[] = [];
  const stored = map.get('elements');
  if (stored instanceof Y.Map) {
    for (const [elementId, value] of stored) {
      const element = readElement(elementId, value);
      if (element) elements.push(element);
    }
  }
  elements.sort((left, right) => comparePositions({ pos: left.z, id: left.id }, { pos: right.z, id: right.id }));
  const notes = map.get('notes');
  const slide: Slide = {
    id,
    pos: readKey(map.get('pos')),
    layout: text(map.get('layout')) ?? 'blank',
    background: text(map.get('background')),
    notes: notes instanceof Y.Text ? notes : null,
    elements,
  };
  const transition = readTransition(map.get('transition'));
  if (transition) slide.transition = transition;
  if (map.get('build') === true) slide.build = true;
  if (map.get('seed') === true) {
    slide.seed = true;
    const by = text(map.get('seedBy'));
    if (by) slide.seedBy = by;
  }
  return slide;
}

export function elementToJson(element: SlideElement): ElementJson {
  const { content, table, ...rest } = element;
  const props: ElementJson & { id?: string } = { ...rest };
  delete props.id;
  if (table) props.table = tableToJson(table);
  return content ? { ...props, content: richTextToJson(content) } : props;
}

/** One deck: reads of what it holds and every change that can be made to it. */
export class Deck {
  readonly ydoc: Y.Doc;
  readonly meta: Y.Map<unknown>;
  readonly slides: Y.Map<Y.Map<unknown>>;

  constructor(ydoc: Y.Doc) {
    this.ydoc = ydoc;
    this.meta = ydoc.getMap('deck');
    this.slides = ydoc.getMap('slides');
  }

  /** Runs a change as one step of this user's own editing. */
  transact<T>(change: () => T): T {
    return this.ydoc.transact(change, LOCAL_ORIGIN);
  }

  get version(): number {
    return finite(this.meta.get('version'), DECK_VERSION);
  }

  /** True when the deck was written by a later version of the format than this code reads. */
  get isNewer(): boolean {
    return this.version > DECK_VERSION;
  }

  get theme(): string {
    return text(this.meta.get('theme')) ?? '';
  }

  setTheme(theme: string): void {
    this.transact(() => {
      this.meta.set('theme', theme);
    });
  }

  /** Slides in deck order. */
  readSlides(): Slide[] {
    const slides: Slide[] = [];
    for (const [id, map] of this.slides) {
      const slide = readSlide(id, map);
      if (slide) slides.push(slide);
    }
    return slides.sort(comparePositions);
  }

  slideIds(): string[] {
    return this.readSlides().map(slide => slide.id);
  }

  readSlide(id: string): Slide | null {
    return readSlide(id, this.slides.get(id));
  }

  /** Marks the deck as needing at least this version of the format to be edited. */
  #raise(version: number): void {
    if (this.version < version) this.meta.set('version', version);
  }

  /** Gives a deck that has nothing yet its version and theme. */
  start(theme: string): void {
    this.transact(() => {
      if (this.meta.get('version') === undefined) this.meta.set('version', FIRST_VERSION);
      if (this.meta.get('theme') === undefined) this.meta.set('theme', theme);
    });
  }

  /**
   * Adds a slide after `afterId` (at the end when null) and returns its id.
   * `seedBy` marks it as the slide a new deck gave itself, made by that browser.
   */
  addSlide(layout: string, elements: ElementInit[], afterId: string | null = null, background?: string, seedBy: string | null = null): string {
    const id = newId();
    this.transact(() => {
      const order = this.readSlides();
      const index = afterId ? order.findIndex(slide => slide.id === afterId) : order.length - 1;
      const before = index >= 0 ? order[index] : order[order.length - 1];
      const after = index >= 0 ? order[index + 1] : undefined;
      const map = new Y.Map<unknown>();
      this.slides.set(id, map);
      map.set('pos', keyBetween(before?.pos, after?.pos));
      map.set('layout', layout);
      if (background) map.set('background', background);
      if (seedBy) {
        map.set('seed', true);
        map.set('seedBy', seedBy);
      }
      map.set('notes', new Y.Text());
      map.set('elements', new Y.Map());
      const keys = keysBetween(null, null, elements.length);
      elements.forEach((init, position) => this.#insertElement(id, { ...init, z: keys[position]! }));
    });
    return id;
  }

  /** Copies slides; each copy lands right after the one it was made from. Returns the copies' ids. */
  duplicateSlides(ids: string[]): string[] {
    const copies: string[] = [];
    this.transact(() => {
      for (const sourceId of this.slideIds().filter(id => ids.includes(id))) {
        const order = this.readSlides();
        const index = order.findIndex(slide => slide.id === sourceId);
        const source = order[index];
        if (!source) continue;
        const id = newId();
        const map = new Y.Map<unknown>();
        this.slides.set(id, map);
        map.set('pos', keyBetween(source.pos, order[index + 1]?.pos));
        map.set('layout', source.layout);
        if (source.background) map.set('background', source.background);
        if (source.transition) map.set('transition', source.transition);
        if (source.build) map.set('build', true);
        const notes = new Y.Text();
        map.set('notes', notes);
        if (source.notes) notes.insert(0, source.notes.toString());
        map.set('elements', new Y.Map());
        for (const element of source.elements) this.#insertElement(id, elementToJson(element));
        copies.push(id);
      }
    });
    return copies;
  }

  deleteSlides(ids: string[]): void {
    this.transact(() => {
      for (const id of ids) this.slides.delete(id);
    });
  }

  /**
   * Moves slides, keeping their order among themselves, to just before
   * `beforeId` (to the end when null).
   */
  moveSlides(ids: string[], beforeId: string | null): void {
    this.transact(() => {
      const order = this.readSlides();
      const moving = order.filter(slide => ids.includes(slide.id));
      if (moving.length === 0) return;
      const staying = order.filter(slide => !ids.includes(slide.id));
      // A target that is itself moving stands for the next slide that stays.
      let targetIndex = order.findIndex(slide => slide.id === beforeId);
      while (targetIndex >= 0 && targetIndex < order.length && ids.includes(order[targetIndex]!.id)) targetIndex += 1;
      const target = targetIndex >= 0 ? order[targetIndex] : undefined;
      const stayIndex = target ? staying.indexOf(target) : staying.length;
      const before = staying[stayIndex - 1];
      const after = staying[stayIndex];
      // Nothing to do when they already sit there, in order.
      const from = order.indexOf(moving[0]!);
      const contiguous = moving.every((slide, offset) => order[from + offset] === slide);
      if (contiguous && order[from - 1] === before && order[from + moving.length] === after) return;
      const keys = keysBetween(before?.pos, after?.pos, moving.length);
      moving.forEach((slide, position) => this.slides.get(slide.id)?.set('pos', keys[position]!));
    });
  }

  /** Sets how slides come on screen and whether their points come one at a time; null takes either away. */
  setSlideMotion(ids: string[], motion: { transition?: Transition | null; build?: boolean | null }): void {
    this.transact(() => {
      for (const id of ids) {
        const map = this.slides.get(id);
        if (!map) continue;
        if (motion.transition !== undefined) {
          if (motion.transition && motion.transition !== 'none') map.set('transition', motion.transition);
          else if (map.has('transition')) map.delete('transition');
        }
        if (motion.build !== undefined) {
          if (motion.build) map.set('build', true);
          else if (map.has('build')) map.delete('build');
        }
      }
    });
  }

  setSlideBackground(id: string, background: string | null): void {
    this.transact(() => {
      const map = this.slides.get(id);
      if (!map) return;
      if (background) map.set('background', background);
      else map.delete('background');
    });
  }

  /**
   * Gives a slide another layout. Its title, subtitle and body boxes move
   * into the new layout's boxes with their text; boxes the new layout has
   * and the slide lacks are added, and empty ones it no longer has go.
   * A box with text that has no place in the new layout stays as it is.
   */
  applyLayout(slideId: string, layout: string, boxes: ElementInit[]): void {
    const map = this.slides.get(slideId);
    const elements = this.#elements(slideId);
    const slide = this.readSlide(slideId);
    if (!map || !elements || !slide) return;
    this.transact(() => {
      map.set('layout', layout);
      const existing = slide.elements.filter(element => element.type === 'text' && element.role);
      const slots = boxes.filter(box => box.type === 'text' && box.role);
      const placed = new Map<number, SlideElement>();
      const used = new Set<string>();
      // Like goes to like first: a title stays a title.
      slots.forEach((slot, index) => {
        const match = existing.find(element => element.role === slot.role && !used.has(element.id));
        if (match) {
          placed.set(index, match);
          used.add(match.id);
        }
      });
      // Then text that is left takes the boxes that are left, becoming what they are.
      const left = existing.filter(element => !used.has(element.id) && !richTextIsEmpty(element.content));
      slots.forEach((_slot, index) => {
        const next = placed.has(index) ? undefined : left.shift();
        if (next) {
          placed.set(index, next);
          used.add(next.id);
        }
      });
      const top = slide.elements.at(-1)?.z;
      const keys = keysBetween(top, null, slots.length);
      slots.forEach((slot, index) => {
        const element = placed.get(index);
        if (!element) {
          this.#insertElement(slideId, { ...slot, z: keys[index]! });
          return;
        }
        const target = elements.get(element.id);
        if (!target) return;
        for (const key of ['x', 'y', 'w', 'h', 'role', 'valign'] as const) {
          const value = slot[key];
          if (value === undefined) {
            if (target.has(key)) target.delete(key);
          } else if (target.get(key) !== value) {
            target.set(key, value);
          }
        }
        if (target.get('rot') !== 0) target.set('rot', 0);
      });
      for (const element of existing) {
        if (!used.has(element.id) && richTextIsEmpty(element.content)) elements.delete(element.id);
      }
    });
  }

  /** The speaker notes of a slide, created when an older slide has none. */
  notes(id: string): Y.Text | null {
    const map = this.slides.get(id);
    if (!map) return null;
    const notes = map.get('notes');
    return notes instanceof Y.Text ? notes : null;
  }

  setNotes(id: string, value: string): void {
    const map = this.slides.get(id);
    if (!map) return;
    this.transact(() => {
      let notes = map.get('notes');
      if (!(notes instanceof Y.Text)) {
        notes = new Y.Text();
        map.set('notes', notes);
      }
      const target = notes as Y.Text;
      const current = target.toString();
      if (current === value) return;
      // Change only the part that differs, so two people's notes merge.
      let start = 0;
      while (start < current.length && start < value.length && current[start] === value[start]) start += 1;
      let end = 0;
      while (end < current.length - start && end < value.length - start
        && current[current.length - 1 - end] === value[value.length - 1 - end]) end += 1;
      if (current.length - start - end > 0) target.delete(start, current.length - start - end);
      if (value.length - start - end > 0) target.insert(start, value.slice(start, value.length - end));
    });
  }

  #elements(slideId: string): Y.Map<Y.Map<unknown>> | null {
    const elements = this.slides.get(slideId)?.get('elements');
    return elements instanceof Y.Map ? elements as Y.Map<Y.Map<unknown>> : null;
  }

  #insertElement(slideId: string, init: ElementJson & { text?: string }): string | null {
    const elements = this.#elements(slideId);
    if (!elements || !ELEMENT_TYPES.has(init.type)) return null;
    const id = newId();
    const map = new Y.Map<unknown>();
    elements.set(id, map);
    for (const key of WRITABLE_KEYS) {
      const value = init[key];
      if (value !== undefined && value !== null) map.set(key, value);
    }
    if (hasContent(init.type)) {
      const content = new Y.XmlFragment();
      map.set('content', content);
      const nodes = init.content ? richTextNodesFromJson(init.content) : init.text ? paragraphsFromText(init.text) : [];
      if (nodes.length) content.insert(0, nodes);
    }
    if (init.type === 'table') {
      writeTable(map, init.table);
      this.#raise(tableNeedsV3(init.table) ? V3 : TABLE_VERSION);
    }
    if (init.type === 'image' && readCrop(init.crop)) this.#raise(V3);
    return id;
  }

  /** Adds elements on top of what the slide has, in the order given. Returns their ids. */
  addElements(slideId: string, inits: Array<ElementJson & { text?: string }>): string[] {
    const ids: string[] = [];
    this.transact(() => {
      const top = this.readSlide(slideId)?.elements.at(-1)?.z;
      const keys = keysBetween(top, null, inits.length);
      inits.forEach((init, position) => {
        const id = this.#insertElement(slideId, { ...init, z: keys[position]! });
        if (id) ids.push(id);
      });
    });
    return ids;
  }

  addElement(slideId: string, init: ElementInit): string | null {
    return this.addElements(slideId, [init])[0] ?? null;
  }

  /** Writes the given properties of each element; `undefined` or `null` removes one. */
  updateElements(slideId: string, changes: Record<string, ElementProps>): void {
    const elements = this.#elements(slideId);
    if (!elements) return;
    this.transact(() => {
      for (const [id, props] of Object.entries(changes)) {
        const map = elements.get(id);
        if (!map) continue;
        for (const [key, value] of Object.entries(props)) {
          if (!(WRITABLE_KEYS as readonly string[]).includes(key) || key === 'type') continue;
          if (value === undefined || value === null) {
            if (map.has(key)) map.delete(key);
          } else if (key === 'crop') {
            const crop = readCrop(value);
            if (!crop) map.delete(key);
            else if (JSON.stringify(map.get(key)) !== JSON.stringify(crop)) {
              map.set(key, crop);
              this.#raise(V3);
            }
          } else if (map.get(key) !== value) {
            map.set(key, value);
          }
        }
      }
    });
  }

  deleteElements(slideId: string, ids: string[]): void {
    const elements = this.#elements(slideId);
    if (!elements) return;
    this.transact(() => {
      for (const id of ids) elements.delete(id);
    });
  }

  /** Copies elements onto the same slide, shifted by `offset`. Returns the copies' ids. */
  duplicateElements(slideId: string, ids: string[], offset = 24): string[] {
    const slide = this.readSlide(slideId);
    if (!slide) return [];
    const sources = slide.elements.filter(element => ids.includes(element.id));
    return this.addElements(slideId, sources.map(element => ({
      ...elementToJson(element),
      x: element.x + offset,
      y: element.y + offset,
    })));
  }

  /** Changes where elements sit in the stack. */
  arrange(slideId: string, ids: string[], where: 'front' | 'back' | 'forward' | 'backward'): void {
    const elements = this.#elements(slideId);
    const slide = this.readSlide(slideId);
    if (!elements || !slide) return;
    const moving = slide.elements.filter(element => ids.includes(element.id));
    const staying = slide.elements.filter(element => !ids.includes(element.id));
    if (moving.length === 0 || staying.length === 0) return;
    let below: SlideElement | undefined;
    let above: SlideElement | undefined;
    if (where === 'front') {
      below = staying.at(-1);
    } else if (where === 'back') {
      above = staying[0];
    } else if (where === 'forward') {
      const top = slide.elements.indexOf(moving.at(-1)!);
      const next = slide.elements.slice(top + 1).find(element => !ids.includes(element.id));
      if (!next) return;
      below = next;
      above = staying[staying.indexOf(next) + 1];
    } else {
      const bottom = slide.elements.indexOf(moving[0]!);
      const previous = slide.elements.slice(0, bottom).reverse().find(element => !ids.includes(element.id));
      if (!previous) return;
      above = previous;
      below = staying[staying.indexOf(previous) - 1];
    }
    const keys = keysBetween(below?.z, above?.z, moving.length);
    this.transact(() => {
      moving.forEach((element, position) => elements.get(element.id)?.set('z', keys[position]!));
    });
  }

  /** Every text an element holds: that of a text box or shape, or of each cell of a table (those in `cells`, when given). */
  #fragments(slideId: string, elementId: string, cells?: ReadonlySet<string>): Y.XmlFragment[] {
    const map = this.#elements(slideId)?.get(elementId);
    if (!map) return [];
    if (map.get('type') === 'table') return tableFragments(map, cells);
    const content = map.get('content');
    return content instanceof Y.XmlFragment ? [content] : [];
  }

  /** Applies a mark to, or removes it from, all the text of an element. */
  formatAllText(slideId: string, elementId: string, mark: string, value: Record<string, unknown> | null, cells?: ReadonlySet<string>): void {
    const fragments = this.#fragments(slideId, elementId, cells);
    if (fragments.length === 0) return;
    this.transact(() => {
      for (const fragment of fragments) {
        eachText(fragment, (text) => {
          if (text.length > 0) text.format(0, text.length, { [mark]: value });
        });
      }
    });
  }

  /** Takes an attribute, such as its own alignment, off every paragraph of an element. */
  clearParagraphAttribute(slideId: string, elementId: string, attribute: string, cells?: ReadonlySet<string>, value?: string): void {
    const fragments = this.#fragments(slideId, elementId, cells);
    if (fragments.length === 0) return;
    this.transact(() => {
      const visit = (node: Y.XmlFragment | Y.XmlElement): void => {
        for (const child of node.toArray()) {
          if (!(child instanceof Y.XmlElement)) continue;
          if (child.nodeName === 'paragraph') {
            if (value !== undefined) {
              if (child.getAttribute(attribute) !== value) child.setAttribute(attribute, value);
            } else if (child.getAttribute(attribute) !== undefined) {
              child.removeAttribute(attribute);
            }
          }
          visit(child);
        }
      };
      for (const fragment of fragments) visit(fragment);
    });
  }

  /** Whether all the text of an element carries a mark; false when it has no text. */
  allTextHasMark(slideId: string, elementId: string, mark: string, cells?: ReadonlySet<string>): boolean {
    let any = false;
    let all = true;
    for (const fragment of this.#fragments(slideId, elementId, cells)) {
      eachText(fragment, (text) => {
        for (const part of text.toDelta() as Array<{ insert: unknown; attributes?: Record<string, unknown> }>) {
          if (typeof part.insert !== 'string' || part.insert.length === 0) continue;
          any = true;
          if (!part.attributes || !(mark in part.attributes)) all = false;
        }
      });
    }
    return any && all;
  }

  // Tables

  #table(slideId: string, elementId: string): Y.Map<unknown> | null {
    const map = this.#elements(slideId)?.get(elementId);
    return map?.get('type') === 'table' ? map : null;
  }

  /** Adds a row or column to a table at `index` (at the end when it is past the last). Returns its id. */
  insertTableLine(slideId: string, elementId: string, kind: 'rows' | 'cols', index: number): string | null {
    const map = this.#table(slideId, elementId);
    return map ? this.transact(() => insertLine(map, kind, index)) : null;
  }

  /** Takes a row or column out of a table; the table goes when it was the last one. */
  removeTableLine(slideId: string, elementId: string, kind: 'rows' | 'cols', id: string): void {
    const map = this.#table(slideId, elementId);
    if (!map) return;
    const table = readTable(map);
    this.transact(() => {
      if (table && (kind === 'rows' ? table.rows : table.cols).every(line => line.id === id)) this.#elements(slideId)?.delete(elementId);
      else removeLine(map, kind, id);
    });
  }

  setCellFill(slideId: string, elementId: string, cells: string[], fill: string | null): void {
    const map = this.#table(slideId, elementId);
    if (map) this.transact(() => setCellFill(map, cells, fill));
  }

  /**
   * Gives a row or column of a table a new size, in slide units. Moving the
   * line between two of them trades size between the two (`next`), keeping
   * the table as wide; the line at the right or bottom edge makes the table
   * itself bigger or smaller, the other rows or columns keeping theirs.
   */
  resizeTableLine(slideId: string, elementId: string, kind: 'rows' | 'cols', id: string, length: number, next?: { id: string; length: number }): void {
    const map = this.#table(slideId, elementId);
    const table = map ? readTable(map) : null;
    if (!map || !table) return;
    const list = kind === 'rows' ? table.rows : table.cols;
    const line = list.find(candidate => candidate.id === id);
    if (!line) return;
    const total = list.reduce((sum, candidate) => sum + candidate.size, 0);
    const extent = finite(map.get(kind === 'rows' ? 'h' : 'w'), 100);
    const unit = total / extent;
    this.transact(() => {
      if (next) {
        setLineSize(map, kind, id, length * unit);
        setLineSize(map, kind, next.id, next.length * unit);
        return;
      }
      // The others keep their size in slide units while the table grows by the difference.
      const old = extent * line.size / total;
      const grown = Math.max(1, extent + length - old);
      setLineSize(map, kind, id, line.size + (total * grown / extent - total));
      map.set(kind === 'rows' ? 'h' : 'w', Math.round(grown * 10) / 10);
    });
  }

  mergeTableCells(slideId: string, elementId: string, rect: CellRect): string | null {
    const map = this.#table(slideId, elementId);
    if (!map) return null;
    return this.transact(() => {
      const anchor = mergeCells(map, rect);
      if (anchor) this.#raise(V3);
      return anchor;
    });
  }

  unmergeTableCells(slideId: string, elementId: string, rect: CellRect): void {
    const map = this.#table(slideId, elementId);
    if (map) this.transact(() => unmergeCells(map, rect));
  }

  setTableBorders(slideId: string, elementId: string, rect: CellRect, which: BorderChoice, border: CellBorder | 'none' | null): void {
    const map = this.#table(slideId, elementId);
    if (!map) return;
    this.transact(() => {
      setCellBorders(map, rect, which, border);
      if (border) this.#raise(V3);
    });
  }

  clearTableCells(slideId: string, elementId: string, cells: string[]): void {
    const map = this.#table(slideId, elementId);
    if (map) this.transact(() => clearCells(map, cells));
  }

  /**
   * The text of a table cell, made when a row and a column added on two
   * devices at once left none where they cross. Made as `origin`, so that
   * it is not a step of anyone's undo.
   */
  tableCell(slideId: string, elementId: string, cell: string, origin: unknown): Y.XmlFragment | null {
    const map = this.#table(slideId, elementId);
    if (!map) return null;
    const existing = readTable(map)?.cells.get(cell)?.content;
    return existing ?? this.ydoc.transact(() => ensureCell(map, cell), origin);
  }
}
