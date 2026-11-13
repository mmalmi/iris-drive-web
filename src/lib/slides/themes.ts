/**
 * Themes: the colours and fonts a deck is drawn with. A deck stores only the
 * id of its theme, and elements that have not been given a colour of their
 * own follow it, so changing the theme restyles the whole deck.
 */
import type { SlideElement, TextRole } from './model';

export interface Palette {
  /** Any CSS background: a colour or a gradient. */
  background: string;
  text: string;
  muted: string;
  accent: string;
  /** Text on top of the accent colour. */
  onAccent: string;
}

export interface Theme {
  id: string;
  name: string;
  titleFont: string;
  bodyFont: string;
  titleWeight: number;
  /** Ordinary slides. */
  base: Palette;
  /** Title and section slides. */
  cover: Palette;
}

const SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif';
const ROUNDED = 'ui-rounded, "SF Pro Rounded", "Nunito", system-ui, -apple-system, "Segoe UI", sans-serif';

export const THEMES: Theme[] = [
  {
    id: 'light',
    name: 'Light',
    titleFont: SANS,
    bodyFont: SANS,
    titleWeight: 700,
    base: { background: '#ffffff', text: '#17181c', muted: '#62656f', accent: '#7647fe', onAccent: '#ffffff' },
    cover: { background: 'linear-gradient(135deg, #7d50ff 0%, #5a31d8 100%)', text: '#ffffff', muted: '#e3d9ff', accent: '#ffffff', onAccent: '#5a31d8' },
  },
  {
    id: 'dark',
    name: 'Dark',
    titleFont: SANS,
    bodyFont: SANS,
    titleWeight: 700,
    base: { background: '#131418', text: '#f4f4f6', muted: '#a3a6b1', accent: '#a78bfa', onAccent: '#131418' },
    cover: { background: 'linear-gradient(135deg, #1a1b21 0%, #2c2158 100%)', text: '#ffffff', muted: '#c5bdf0', accent: '#a78bfa', onAccent: '#131418' },
  },
  {
    id: 'paper',
    name: 'Paper',
    titleFont: SERIF,
    bodyFont: SERIF,
    titleWeight: 600,
    base: { background: '#faf6ee', text: '#2b2118', muted: '#76695b', accent: '#b4532a', onAccent: '#ffffff' },
    cover: { background: '#2b2118', text: '#faf6ee', muted: '#cdbfae', accent: '#e39a6f', onAccent: '#2b2118' },
  },
  {
    id: 'ocean',
    name: 'Ocean',
    titleFont: SANS,
    bodyFont: SANS,
    titleWeight: 700,
    base: { background: '#f4f9fc', text: '#0f2a3a', muted: '#557082', accent: '#0b84c6', onAccent: '#ffffff' },
    cover: { background: 'linear-gradient(135deg, #0c6a94 0%, #0a2540 100%)', text: '#ffffff', muted: '#bfe1f2', accent: '#5ecbf7', onAccent: '#0a2540' },
  },
  {
    id: 'forest',
    name: 'Forest',
    titleFont: SERIF,
    bodyFont: SANS,
    titleWeight: 600,
    base: { background: '#f5f8f3', text: '#1c2b22', muted: '#5d7065', accent: '#2c8a5c', onAccent: '#ffffff' },
    cover: { background: '#1f4636', text: '#f5f8f3', muted: '#b9d3c4', accent: '#8fd6ae', onAccent: '#1f4636' },
  },
  {
    id: 'sunset',
    name: 'Sunset',
    titleFont: ROUNDED,
    bodyFont: ROUNDED,
    titleWeight: 700,
    base: { background: '#fffaf5', text: '#2a1a14', muted: '#7d6459', accent: '#e4572e', onAccent: '#ffffff' },
    cover: { background: 'linear-gradient(135deg, #ff8a5c 0%, #c8327c 100%)', text: '#ffffff', muted: '#ffe1d6', accent: '#ffffff', onAccent: '#c8327c' },
  },
];

export const DEFAULT_THEME = 'light';

export function themeById(id: string | undefined): Theme {
  return THEMES.find(theme => theme.id === id) ?? THEMES[0]!;
}

/** The colours a slide of this layout is drawn with. */
export function paletteFor(theme: Theme, layout: string): Palette {
  return layout === 'title' || layout === 'section' ? theme.cover : theme.base;
}

/** Colours offered beside the theme's own. */
export const SWATCHES = [
  '#17181c', '#62656f', '#a3a6b1', '#ffffff',
  '#e03131', '#f08c00', '#f2c94c', '#2f9e44',
  '#0ca678', '#1c7ed6', '#4263eb', '#7647fe',
  '#c2255c', '#ffd8a8', '#b2f2bb', '#a5d8ff',
];

export const THEME_COLOURS: Array<{ value: keyof Palette; label: string }> = [
  { value: 'text', label: 'Text' },
  { value: 'muted', label: 'Soft text' },
  { value: 'accent', label: 'Accent' },
  { value: 'onAccent', label: 'On accent' },
];

const HEX = /^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{8}$/;

/** The CSS colour for a stored colour, or null for none. Nothing but hex colours and theme names gets through. */
export function resolveColour(value: string | undefined, palette: Palette, fallback: string | null = null): string | null {
  if (!value) return fallback;
  if (value === 'none') return null;
  if (HEX.test(value)) return value;
  if (value === 'background') return palette.background.startsWith('#') ? palette.background : palette.onAccent;
  if (value === 'text' || value === 'muted' || value === 'accent' || value === 'onAccent') return palette[value];
  return fallback;
}

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number;
  color: string;
  align: 'left' | 'center' | 'right';
  valign: 'top' | 'middle' | 'bottom';
}

// Sized so that a plain slide of a title and a handful of points looks finished as it is.
const ROLE_SIZE: Record<TextRole, number> = { title: 52, subtitle: 30, body: 32 };
const COVER_TITLE_SIZE = 72;

/** How the text of an element is set when it has no formatting of its own. */
export function textStyle(element: SlideElement, theme: Theme, layout: string): TextStyle {
  const palette = paletteFor(theme, layout);
  const cover = palette === theme.cover;
  const role = element.role;
  const shape = element.type === 'shape';
  const filled = shape && resolveColour(element.fill, palette, palette.accent) !== null;
  const defaultColour = shape
    ? (filled ? (element.fill ? readableOn(resolveColour(element.fill, palette, palette.accent)!, palette) : palette.onAccent) : palette.text)
    : role === 'subtitle' ? palette.muted : palette.text;
  return {
    fontFamily: role === 'title' ? theme.titleFont : theme.bodyFont,
    fontSize: element.fontSize ?? (role ? (role === 'title' && cover ? COVER_TITLE_SIZE : ROLE_SIZE[role]) : shape ? 24 : 28),
    fontWeight: role === 'title' ? theme.titleWeight : 400,
    lineHeight: role === 'title' ? 1.12 : 1.3,
    color: resolveColour(element.color, palette, defaultColour) ?? defaultColour,
    align: element.align ?? (shape ? 'center' : 'left'),
    valign: element.valign ?? (shape ? 'middle' : 'top'),
  };
}

function luminance(hex: string): number {
  const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex;
  const channel = (offset: number) => {
    const value = parseInt(full.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Dark or light text, whichever reads better on a fill. */
export function readableOn(fill: string, palette: Palette): string {
  if (!HEX.test(fill)) return palette.text;
  return luminance(fill) > 0.45 ? '#17181c' : '#ffffff';
}
