/**
 * The text of a text box or shape: paragraphs and lists with bold, italic,
 * underline, strikethrough, colour and size, each paragraph aligned as it
 * likes. While someone types in it the
 * text is a tiptap editor; everywhere else (other boxes, thumbnails,
 * presenting) the same stored text is drawn by `renderRichText`. Both produce
 * the same elements, so the one stylesheet makes them look the same.
 */
import { Editor, Extension, Mark, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { TextSelection } from '@tiptap/pm/state';
import * as Y from 'yjs';

const HEX = /^#[0-9a-fA-F]{6}$|^#[0-9a-fA-F]{3}$/;
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

export function validAlign(value: unknown): 'left' | 'center' | 'right' | null {
  return value === 'left' || value === 'center' || value === 'right' ? value : null;
}

// Colour and size wrap the other marks, here and in `renderRichText`, so an
// underline takes the colour of its text in both.
const ColourMark = Mark.create({
  name: 'color',
  priority: 1200,
  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: element => (element as HTMLElement).dataset.colour ?? null,
        renderHTML: (attributes) => {
          const colour = cssColour(attributes.color);
          return colour ? { 'data-colour': attributes.color as string, style: `color: ${colour}` } : {};
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-colour]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});

const FontSizeMark = Mark.create({
  name: 'fontSize',
  priority: 1100,
  addAttributes() {
    return {
      size: {
        default: null,
        parseHTML: element => validFontSize((element as HTMLElement).dataset.size),
        renderHTML: (attributes) => {
          const size = validFontSize(attributes.size);
          return size ? { 'data-size': String(size), style: `font-size: ${fontSizeCss(size)}` } : {};
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-size]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0];
  },
});

/** A paragraph may be aligned differently from the rest of its box. */
const ParagraphAlign = Extension.create({
  name: 'paragraphAlign',
  addGlobalAttributes() {
    return [{
      types: ['paragraph'],
      attributes: {
        textAlign: {
          default: null,
          parseHTML: element => validAlign((element as HTMLElement).dataset.align),
          renderHTML: (attributes) => {
            const align = validAlign(attributes.textAlign);
            return align ? { 'data-align': align, style: `text-align: ${align}` } : {};
          },
        },
      },
    }];
  },
});

/**
 * Selects all the text of a box, from its first letter to its last. Typing
 * over it then replaces the words and keeps what they were in: a list stays
 * a list.
 */
export function selectAllText(editor: Editor): boolean {
  return editor.commands.command(({ tr, dispatch }) => {
    if (dispatch) tr.setSelection(TextSelection.between(tr.doc.resolve(0), tr.doc.resolve(tr.doc.content.size)));
    return true;
  });
}

const SelectAllText = Extension.create({
  name: 'selectAllText',
  addKeyboardShortcuts() {
    return { 'Mod-a': ({ editor }) => selectAllText(editor) };
  },
});

export interface TextEditorOptions {
  element: HTMLElement;
  fragment: Y.XmlFragment;
  onImage?: (file: File) => void;
  /** Tab was pressed outside a list; `back` when with Shift. */
  onTab?: (back: boolean) => void;
}

/** An editor for one text box, writing straight into its stored text. */
export function createTextEditor(options: TextEditorOptions): Editor {
  return new Editor({
    element: options.element,
    extensions: [
      StarterKit.configure({
        // Undo belongs to the whole deck, not to one box.
        undoRedo: false,
        heading: false,
        blockquote: false,
        codeBlock: false,
        code: false,
        horizontalRule: false,
        link: false,
        // A list at the end of a box must not grow an empty line after it.
        trailingNode: false,
        dropcursor: false,
        gapcursor: false,
      }),
      ColourMark,
      FontSizeMark,
      ParagraphAlign,
      SelectAllText,
      Collaboration.configure({ fragment: options.fragment }),
    ],
    editorProps: {
      attributes: { class: 'slide-text', spellcheck: 'true' },
      handlePaste: (_view, event) => {
        for (const item of event.clipboardData?.items ?? []) {
          if (item.type.startsWith('image/')) {
            const file = item.getAsFile();
            if (file && options.onImage) {
              event.preventDefault();
              options.onImage(file);
              return true;
            }
          }
        }
        return false;
      },
      // Tab indents a list item; anywhere else it goes on to the next box rather than to the next button.
      handleKeyDown: (view, event) => {
        if (event.key !== 'Tab' || event.metaKey || event.ctrlKey || event.altKey) return false;
        event.preventDefault();
        const { $from } = view.state.selection;
        for (let depth = $from.depth; depth > 0; depth -= 1) {
          if ($from.node(depth).type.name === 'listItem') return false;
        }
        options.onTab?.(event.shiftKey);
        return true;
      },
    },
  });
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
