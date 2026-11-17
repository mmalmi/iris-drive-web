/**
 * The text of a text box or shape: paragraphs and lists with bold, italic,
 * underline, strikethrough, colour, size and links, each paragraph aligned as it
 * likes. While someone types in it the
 * text is a tiptap editor (`richTextEditor`, loaded when it is first needed);
 * everywhere else (other boxes, thumbnails, presenting) the same stored text
 * is drawn by `renderRichText`. Both produce the same elements, so the one
 * stylesheet makes them look the same.
 */
import * as Y from 'yjs';
import type { Editor } from '@tiptap/core';

const HEX = /^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{3}$|^#[0-9a-fA-F]{8}$/;
const THEME_NAMES: Record<string, string> = {
  text: 'var(--slide-text)',
  muted: 'var(--slide-muted)',
  accent: 'var(--slide-accent)',
  onAccent: 'var(--slide-on-accent)',
};

export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 240;
export const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 56, 64, 72, 96, 120];

/** The CSS for a stored text colour; null for anything that is not one. */
export function cssColour(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (HEX.test(value)) return value;
  return THEME_NAMES[value] ?? null;
}

export function validFontSize(value: unknown): number | null {
  const size = typeof value === 'string' ? Number.parseFloat(value) : value;
  if (typeof size !== 'number' || !Number.isFinite(size)) return null;
  return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
}

/**
 * The CSS for a text size. Sizes are multiplied by `--fit`, which a box sets
 * below 1 to shrink all its text by the same share when it would not fit.
 */
export function fontSizeCss(size: number): string {
  return `calc(${size}px * var(--fit, 1))`;
}

/** The address of a stored link, when it is one that may be opened: a web or mail address. */
export function linkHref(value: unknown): string | null {
  return typeof value === 'string' && value.length < 2048 && /^(https?:\/\/|mailto:)\S+$/i.test(value) ? value : null;
}

export function validAlign(value: unknown): 'left' | 'center' | 'right' | null {
  return value === 'left' || value === 'center' || value === 'right' ? value : null;
}

/**
 * Selects all the text of a box, from its first letter to its last. Typing
 * over it then replaces the words and keeps what they were in: a list stays
 * a list. The editor keeps a text selection inside the text, so the ends of
 * the document stand for its first and last letters.
 */
export function selectAllText(editor: Editor): boolean {
  return editor.commands.setTextSelection({ from: 0, to: editor.state.doc.content.size });
}

type TextPart = { insert: unknown; attributes?: Record<string, unknown> };

const BLOCKS: Record<string, string> = {
  paragraph: 'p',
  bulletList: 'ul',
  orderedList: 'ol',
  listItem: 'li',
};

const SIMPLE_MARKS: Array<[string, string]> = [
  ['bold', 'strong'],
  ['italic', 'em'],
  ['strike', 's'],
  ['underline', 'u'],
];

function renderText(node: Y.XmlText, parent: HTMLElement, doc: Document): boolean {
  let any = false;
  for (const part of node.toDelta() as TextPart[]) {
    if (typeof part.insert !== 'string' || part.insert === '') continue;
    any = true;
    const attributes = part.attributes ?? {};
    let target: HTMLElement = parent;
    const wrap = (tag: string): HTMLElement => {
      const element = doc.createElement(tag);
      target.appendChild(element);
      target = element;
      return element;
    };
    const colour = cssColour((attributes.color as { color?: unknown } | undefined)?.color);
    if (colour) wrap('span').setAttribute('style', `color: ${colour}`);
    const size = validFontSize((attributes.fontSize as { size?: unknown } | undefined)?.size);
    if (size) wrap('span').setAttribute('style', `font-size: ${fontSizeCss(size)}`);
    const href = linkHref((attributes.link as { href?: unknown } | undefined)?.href);
    if (href) {
      const link = wrap('a');
      link.setAttribute('href', href);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    for (const [mark, tag] of SIMPLE_MARKS) {
      if (mark in attributes && attributes[mark] !== null && attributes[mark] !== false) wrap(tag);
    }
    target.appendChild(doc.createTextNode(part.insert));
  }
  return any;
}

function renderChildren(node: Y.XmlFragment | Y.XmlElement, parent: HTMLElement, doc: Document, depth: number): boolean {
  let any = false;
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) {
      any = renderText(child, parent, doc) || any;
    } else if (child instanceof Y.XmlElement && depth < 16) {
      if (child.nodeName === 'hardBreak') {
        parent.appendChild(doc.createElement('br'));
        any = true;
        continue;
      }
      const element = doc.createElement(BLOCKS[child.nodeName] ?? 'div');
      if (child.nodeName === 'orderedList') {
        const start = Number(child.getAttribute('start'));
        if (Number.isInteger(start) && start > 1) element.setAttribute('start', String(start));
      }
      if (child.nodeName === 'paragraph') {
        const align = validAlign(child.getAttribute('textAlign'));
        if (align) element.setAttribute('style', `text-align: ${align}`);
      }
      const filled = renderChildren(child, element, doc, depth + 1);
      // An empty paragraph still takes a line, as it does while typing.
      if (!filled && child.nodeName === 'paragraph') element.appendChild(doc.createElement('br'));
      // A point with nothing written in it, such as the one Enter leaves at the end of a list, shows no bullet.
      if (child.nodeName === 'listItem' && !element.textContent) element.className = 'slide-empty-point';
      parent.appendChild(element);
      any = any || filled || child.nodeName !== 'paragraph';
    }
  }
  return any;
}

/**
 * Draws stored text into `container`, replacing what was there. Only known
 * elements and validated styles are created, never markup from the document.
 */
export function renderRichText(fragment: Y.XmlFragment, container: HTMLElement): void {
  const doc = container.ownerDocument;
  const holder = doc.createDocumentFragment() as unknown as HTMLElement;
  renderChildren(fragment, holder, doc, 0);
  container.replaceChildren(holder);
}
