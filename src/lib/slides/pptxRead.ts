/**
 * Reading the parts of a PowerPoint file that its slides are built from:
 * the XML of each part, the theme's colours and fonts, and how a colour
 * written in DrawingML (a value, a theme colour, with its tints and shades)
 * comes out as an RGB colour. Used by pptxImport.ts.
 */
import { strFromU8 } from 'fflate';
import { resolvePath } from '../ooxml';

export type Files = Record<string, Uint8Array>;

/** The children of an element with the given local name (any namespace). */
export function kids(node: Element | null | undefined, name?: string): Element[] {
  if (!node) return [];
  const out: Element[] = [];
  for (const child of node.children) if (!name || child.localName === name) out.push(child);
  return out;
}

/** The first child with this local name, following a path of names. */
export function kid(node: Element | null | undefined, ...path: string[]): Element | null {
  let at: Element | null | undefined = node;
  for (const name of path) {
    if (!at) return null;
    let next: Element | null = null;
    for (const child of at.children) {
      if (child.localName === name) {
        next = child;
        break;
      }
    }
    at = next;
  }
  return at ?? null;
}

/** Every descendant with this local name, in document order. */
export function all(node: Element | null | undefined, name: string): Element[] {
  if (!node) return [];
  return [...node.getElementsByTagName('*')].filter(element => element.localName === name);
}

export function num(node: Element | null | undefined, attribute: string): number | undefined {
  const value = node?.getAttribute(attribute);
  if (value === null || value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** An attribute that says yes or no ("1", "true", "0", "false"); undefined when it says neither. */
export function flag(node: Element | null | undefined, attribute: string): boolean | undefined {
  const value = node?.getAttribute(attribute);
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

export function readXml(files: Files, path: string): Element | null {
  const bytes = files[path];
  if (!bytes) return null;
  // Relationship ids are read under a plain name: not every XML reader keeps attributes with a prefix.
  const text = strFromU8(bytes).replace(/\sr:(id|embed|link|pict)=/g, ' r_$1=');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const root = doc.documentElement;
  return root && root.localName !== 'parsererror' && !doc.getElementsByTagName('parsererror').length ? root : null;
}

/** The relationships of a part, by id: their target paths and kinds. */
export function relsOf(files: Files, part: string): Map<string, { path: string; type: string; external: boolean }> {
  const slash = part.lastIndexOf('/');
  const relsPath = `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
  const root = readXml(files, relsPath);
  const rels = new Map<string, { path: string; type: string; external: boolean }>();
  for (const rel of kids(root, 'Relationship')) {
    const id = rel.getAttribute('Id');
    const target = rel.getAttribute('Target');
    if (!id || !target) continue;
    const external = rel.getAttribute('TargetMode') === 'External';
    rels.set(id, { path: external ? target : resolvePath(part, target), type: rel.getAttribute('Type')?.split('/').pop() ?? '', external });
  }
  return rels;
}

export function relOfType(rels: Map<string, { path: string; type: string }>, type: string): string | null {
  for (const rel of rels.values()) if (rel.type === type) return rel.path;
  return null;
}

// Colours

export interface ThemeInfo {
  colours: Record<string, string>;
  majorFont: string;
  minorFont: string;
}

const PRESET: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00',
  gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500', purple: '800080',
};

const SYSTEM: Record<string, string> = { windowText: '000000', window: 'FFFFFF', btnFace: 'F0F0F0', highlight: '0078D7', highlightText: 'FFFFFF' };

export function readTheme(root: Element | null): ThemeInfo {
  const colours: Record<string, string> = {};
  const scheme = kid(root, 'themeElements', 'clrScheme');
  for (const entry of kids(scheme)) {
    const value = kid(entry, 'srgbClr')?.getAttribute('val') ?? kid(entry, 'sysClr')?.getAttribute('lastClr')
      ?? SYSTEM[kid(entry, 'sysClr')?.getAttribute('val') ?? ''];
    if (value) colours[entry.localName] = value.toUpperCase();
  }
  const fonts = kid(root, 'themeElements', 'fontScheme');
  return {
    colours,
    majorFont: kid(fonts, 'majorFont', 'latin')?.getAttribute('typeface') ?? 'Calibri Light',
    minorFont: kid(fonts, 'minorFont', 'latin')?.getAttribute('typeface') ?? 'Calibri',
  };
}

function toRgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.slice(0, 6), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map(channel => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, '0')).join('')}`;
}

function toHsl([r, g, b]: [number, number, number]): [number, number, number] {
  const [rr, gg, bb] = [r / 255, g / 255, b / 255];
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rr ? (gg - bb) / d + (gg < bb ? 6 : 0) : max === gg ? (bb - rr) / d + 2 : (rr - gg) / d + 4;
  return [h / 6, s, l];
}

function fromHsl([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number) => {
    const u = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    if (u < 1 / 6) return p + (q - p) * 6 * u;
    if (u < 1 / 2) return q;
    if (u < 2 / 3) return p + (q - p) * (2 / 3 - u) * 6;
    return p;
  };
  return [channel(h + 1 / 3) * 255, channel(h) * 255, channel(h - 1 / 3) * 255];
}

/** The usual mapping of a master's names for colours to the theme's. */
export const DEFAULT_COLOUR_MAP: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };

export interface ColourContext {
  theme: ThemeInfo;
  /** bg1, tx1, bg2, tx2 → the theme colour they stand for. */
  map: Record<string, string>;
  /** What "phClr" stands for in a style that refers to it. */
  placeholder?: string;
}

/**
 * The colour an element such as <a:solidFill> holds, as '#rrggbb', with its
 * tints, shades and luminance changes applied; null when it holds none.
 */
export function readColour(fill: Element | null | undefined, context: ColourContext): string | null {
  const colour = fill && ['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr', 'hslClr'].includes(fill.localName) ? fill : kids(fill)[0];
  if (!colour) return null;
  let hex: string | undefined;
  if (colour.localName === 'srgbClr') hex = colour.getAttribute('val') ?? undefined;
  else if (colour.localName === 'sysClr') hex = colour.getAttribute('lastClr') ?? SYSTEM[colour.getAttribute('val') ?? ''];
  else if (colour.localName === 'prstClr') hex = PRESET[colour.getAttribute('val') ?? ''];
  else if (colour.localName === 'scrgbClr') {
    const part = (name: string) => Math.round((num(colour, name) ?? 0) / 100000 * 255).toString(16).padStart(2, '0');
    hex = `${part('r')}${part('g')}${part('b')}`;
  } else if (colour.localName === 'schemeClr') {
    const name = colour.getAttribute('val') ?? '';
    if (name === 'phClr') hex = context.placeholder?.slice(1);
    else hex = context.theme.colours[context.map[name] ?? DEFAULT_COLOUR_MAP[name] ?? name];
  }
  if (!hex || !/^[0-9a-f]{6}/i.test(hex)) return null;
  let rgb = toRgb(hex);
  for (const change of kids(colour)) {
    const value = (num(change, 'val') ?? 100000) / 100000;
    if (change.localName === 'lumMod' || change.localName === 'lumOff') {
      const hsl = toHsl(rgb);
      hsl[2] = Math.min(1, Math.max(0, change.localName === 'lumMod' ? hsl[2] * value : hsl[2] + value));
      rgb = fromHsl(hsl);
    } else if (change.localName === 'tint') {
      rgb = rgb.map(channel => channel + (255 - channel) * (1 - value)) as [number, number, number];
    } else if (change.localName === 'shade') {
      rgb = rgb.map(channel => channel * value) as [number, number, number];
    }
  }
  return toHex(rgb);
}

/** The colour of a fill (solid, or the first stop of a gradient); 'none' for no fill; undefined when it does not say. */
export function readFill(parent: Element | null | undefined, context: ColourContext): string | 'none' | undefined {
  if (!parent) return undefined;
  if (kid(parent, 'noFill')) return 'none';
  const solid = kid(parent, 'solidFill');
  if (solid) return readColour(solid, context) ?? undefined;
  const gradient = kid(parent, 'gradFill');
  if (gradient) {
    const stops = kids(kid(gradient, 'gsLst'), 'gs');
    // The middle of a gradient is closest to how it looks overall.
    const stop = stops[Math.floor((stops.length - 1) / 2)];
    return readColour(stop, context) ?? undefined;
  }
  return undefined;
}

/** How light a colour is, from 0 to 1. */
export function lightness(hex: string): number {
  return toHsl(toRgb(hex.replace('#', '')))[2];
}

export function hueOf(hex: string): { hue: number; saturation: number } {
  const [h, s] = toHsl(toRgb(hex.replace('#', '')));
  return { hue: h * 360, saturation: s };
}

/** Whether a font is one with serifs, to pick the look nearest to it. */
export function isSerif(font: string): boolean {
  return /georgia|times|garamond|cambria|palatino|book antiqua|baskerville|bodoni|didot|caslon|minion|merriweather|playfair|serif(?!.*sans)|constantia|rockwell|century schoolbook/i.test(font);
}

export function isRounded(font: string): boolean {
  return /nunito|varela round|quicksand|comfortaa|rounded/i.test(font);
}
