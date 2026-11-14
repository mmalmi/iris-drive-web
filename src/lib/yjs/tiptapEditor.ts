import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import Collaboration from '@tiptap/extension-collaboration';
import { TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import type * as Y from 'yjs';
import { CommentMark, createCommentsStore, type CommentsStore } from '../comments';
import { htmlIsOnlyPictures, imageFiles, importForeignImages, rewriteCopiedHtml } from './pastedImages';
import type { CommentsState } from '../comments/types';

interface CreateYjsTiptapEditorOptions {
  element: HTMLElement;
  ydoc: Y.Doc;
  canEdit: boolean;
  /** Adds a picture at a place in the document, or where the cursor is. */
  handleImageUpload: (file: File, at?: number) => void | Promise<void>;
  resolveImageSrc: (img: HTMLImageElement) => void;
  /** Where this browser loads an attachment from, for copying pictures out. */
  attachmentUrl: (filename: string) => string | undefined;
  /** Stores a pasted picture in the document and returns its attachment name. */
  storeImage: (file: File) => Promise<string>;
  /** Shows a short message to the person editing. */
  onNotice: (message: string) => void;
  onCommentsState: (state: CommentsState) => void;
  /** Ctrl+K or ⌘K: the person wants to add or change a link. */
  onLinkShortcut: () => void;
}

/**
 * Puts a picture in the document, at a place or where the cursor is, and the
 * cursor on the line below it, so that typing on does not replace it.
 */
export function insertPicture(editor: Editor, attrs: { src: string; alt: string }, at?: number): void {
  const chain = editor.chain().focus();
  if (at === undefined) chain.setImage(attrs).run();
  else chain.insertContentAt(Math.min(at, editor.state.doc.content.size), { type: 'image', attrs }).run();
  // Each picture is stored under a name of its own, so its address finds it.
  let end = -1;
  editor.state.doc.descendants((node, pos) => {
    if (end < 0 && node.type.name === 'image' && node.attrs.src === attrs.src) end = pos + node.nodeSize;
    return end < 0;
  });
  if (end < 0) return;
  const tr = editor.state.tr;
  if (!tr.doc.resolve(end).nodeAfter?.isTextblock) tr.insert(end, editor.schema.nodes.paragraph.create());
  editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, end + 1)).scrollIntoView());
}

interface YjsTiptapEditorSetup {
  editor: Editor;
  commentsStore: CommentsStore;
}

export function createYjsTiptapEditor(options: CreateYjsTiptapEditorOptions): YjsTiptapEditorSetup {
  const commentsStore = createCommentsStore(options.ydoc);
  const unsubComments = commentsStore.subscribe(options.onCommentsState);
  const editor = new Editor({
    element: options.element,
    extensions: [
      // A click on a link while writing puts the cursor in it; the link opens from the bubble that then shows.
      StarterKit.configure({ undoRedo: false, link: { openOnClick: false } }),
      Placeholder.configure({ placeholder: options.canEdit ? 'Start writing…' : '' }),
      Collaboration.configure({ document: options.ydoc }),
      // data: pictures are accepted on paste only to be stored as attachments at once.
      Image.configure({ inline: false, allowBase64: true }),
      TableKit.configure({ table: { resizable: options.canEdit } }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      CommentMark.configure({
        HTMLAttributes: {
          class: 'comment-highlight',
        },
      }),
    ],
    editable: options.canEdit,
    editorProps: {
      attributes: {
        class: 'document-body focus:outline-none',
      },
      handleKeyDown: (_view, event) => {
        if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'k') return false;
        event.preventDefault();
        options.onLinkShortcut();
        return true;
      },
      handlePaste: (_view, event) => {
        const files = imageFiles(event.clipboardData);
        if (files.length > 0 && htmlIsOnlyPictures(event.clipboardData?.getData('text/html'))) {
          event.preventDefault();
          void addFiles(files);
          return true;
        }
        // Text with pictures: let the editor paste it, then bring the pictures in.
        bringPicturesIn();
        return false;
      },
      handleDrop: (view, event, _slice, moved) => {
        if (moved) return false;
        const files = imageFiles(event.dataTransfer);
        if (files.length > 0) {
          event.preventDefault();
          void addFiles(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
          return true;
        }
        if (event.dataTransfer?.files.length) {
          event.preventDefault();
          options.onNotice('Only pictures can be dropped into a document.');
          return true;
        }
        bringPicturesIn();
        return false;
      },
    },
  });

  // The editor fills the clipboard as the copy event passes its own element;
  // this listener sits on the element around it and runs just after, to name
  // pictures by where they can be fetched from.
  const nameCopiedPictures = (event: ClipboardEvent): void => {
    const html = event.clipboardData?.getData('text/html');
    if (!html || !event.clipboardData) return;
    const rewritten = rewriteCopiedHtml(html, options.attachmentUrl, window.location.href);
    if (rewritten === html) return;
    event.clipboardData.setData('text/html', rewritten);
    writePictures(rewritten, event.clipboardData.getData('text/plain'));
  };

  /**
   * Other apps cannot load a picture from where this browser shows it, so a
   * copy with pictures is written again with the pictures themselves: inline
   * in the HTML, and as a PNG picture when there is one. The write is asked
   * for now, while the copy is the person's own act; what the copy event put
   * on the clipboard stays when the browser does not allow it.
   */
  function writePictures(html: string, text: string): void {
    if (typeof ClipboardItem === 'undefined' || typeof navigator.clipboard?.write !== 'function') return;
    const made = import('./copiedPictures');
    const pictures = (html.match(/data-iris-attachment="/g) ?? []).length;
    const items: Record<string, Blob | Promise<Blob>> = {
      'text/html': made.then(copied => copied.inlinePictures(html)).then(inline => new Blob([inline], { type: 'text/html' })),
    };
    if (text) items['text/plain'] = new Blob([text], { type: 'text/plain' });
    if (pictures === 1) items['image/png'] = made.then(copied => copied.firstPicturePng(html));
    navigator.clipboard.write([new ClipboardItem(items)]).catch((error: unknown) => {
      console.warn('[Document] Pictures were copied as links only:', error);
    });
  }
  options.element.addEventListener('copy', nameCopiedPictures);
  options.element.addEventListener('cut', nameCopiedPictures);

  /** The first picture goes where it was dropped, the others after it. */
  async function addFiles(files: File[], at?: number): Promise<void> {
    for (const [index, file] of files.entries()) await options.handleImageUpload(file, index === 0 ? at : undefined);
  }

  function bringPicturesIn(): void {
    // After the editor has put the pasted content in place.
    setTimeout(() => {
      void importForeignImages(editor, {
        store: options.storeImage,
        onMissing: (count) => options.onNotice(count === 1
          ? 'One picture could not be copied.'
          : `${count} pictures could not be copied.`),
      });
    }, 0);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLImageElement) {
          options.resolveImageSrc(node);
        } else if (node instanceof HTMLElement) {
          const images = node.querySelectorAll('img');
          for (const img of images) {
            options.resolveImageSrc(img as HTMLImageElement);
          }
        }
      }
    }
  });

  observer.observe(options.element, { childList: true, subtree: true });
  const existingImages = options.element.querySelectorAll('img');
  for (const img of existingImages) {
    options.resolveImageSrc(img as HTMLImageElement);
  }

  const editorOriginalDestroy = editor.destroy.bind(editor);
  editor.destroy = () => {
    observer.disconnect();
    options.element.removeEventListener('copy', nameCopiedPictures);
    options.element.removeEventListener('cut', nameCopiedPictures);
    unsubComments();
    editorOriginalDestroy();
  };

  return { editor, commentsStore };
}
