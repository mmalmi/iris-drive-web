import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import Collaboration from '@tiptap/extension-collaboration';
import type * as Y from 'yjs';
import { CommentMark, createCommentsStore, type CommentsStore } from '../comments';
import { htmlIsOnlyPictures, imageFiles, importForeignImages, rewriteCopiedHtml } from './pastedImages';
import type { CommentsState } from '../comments/types';

interface CreateYjsTiptapEditorOptions {
  element: HTMLElement;
  ydoc: Y.Doc;
  canEdit: boolean;
  handleImageUpload: (file: File) => void | Promise<void>;
  resolveImageSrc: (img: HTMLImageElement) => void;
  /** Where this browser loads an attachment from, for copying pictures out. */
  attachmentUrl: (filename: string) => string | undefined;
  /** Stores a pasted picture in the document and returns its attachment name. */
  storeImage: (file: File) => Promise<string>;
  /** Shows a short message to the person editing. */
  onNotice: (message: string) => void;
  onCommentsState: (state: CommentsState) => void;
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
      StarterKit.configure({ undoRedo: false }),
      Placeholder.configure({ placeholder: options.canEdit ? 'Start writing…' : '' }),
      Collaboration.configure({ document: options.ydoc }),
      // data: pictures are accepted on paste only to be stored as attachments at once.
      Image.configure({ inline: false, allowBase64: true }),
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
      handleDrop: (_view, event, _slice, moved) => {
        if (moved) return false;
        const files = imageFiles(event.dataTransfer);
        if (files.length > 0) {
          event.preventDefault();
          void addFiles(files);
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
    if (rewritten !== html) event.clipboardData.setData('text/html', rewritten);
  };
  options.element.addEventListener('copy', nameCopiedPictures);
  options.element.addEventListener('cut', nameCopiedPictures);

  async function addFiles(files: File[]): Promise<void> {
    for (const file of files) await options.handleImageUpload(file);
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
