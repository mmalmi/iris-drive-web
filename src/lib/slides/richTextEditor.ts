/**
 * The editor for the text of one box while someone types in it. It brings
 * tiptap, so it is loaded when text is first edited, not with the
 * presentation; `richText` has what drawing text needs.
 */
import { Editor, Extension, Mark, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { PluginKey } from '@tiptap/pm/state';
import type * as Y from 'yjs';
import { cssColour, fontSizeCss, selectAllText, validAlign, validFontSize } from './richText';

/**
 * What the editor writes into the stored text carries one of its plugin keys
 * as the transaction's origin; the deck's undo tracks those by this class.
 */
export const TYPING_ORIGIN = PluginKey;

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
        // Addresses become links as they are typed or pasted; they open while presenting, not while typing.
        link: { openOnClick: false, defaultProtocol: 'https' },
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
