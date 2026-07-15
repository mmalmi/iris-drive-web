import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Image from '@tiptap/extension-image';
import Collaboration from '@tiptap/extension-collaboration';
import type * as Y from 'yjs';
import { CommentMark, createCommentsStore, type CommentsStore } from '../comments';
import type { CommentsState } from '../comments/types';

interface CreateYjsTiptapEditorOptions {
  element: HTMLElement;
  ydoc: Y.Doc;
  canEdit: boolean;
  handleImageUpload: (file: File) => void | Promise<void>;
  resolveImageSrc: (img: HTMLImageElement) => void;
  scheduleSave: () => void;
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
      StarterKit.configure({ history: false }),
      Placeholder.configure({ placeholder: 'Start typing...' }),
      Collaboration.configure({ document: options.ydoc }),
      Image.configure({ inline: false, allowBase64: false }),
      CommentMark.configure({
        HTMLAttributes: {
          class: 'comment-highlight',
        },
      }),
    ],
    editable: options.canEdit,
    editorProps: {
      attributes: {
        class: 'prose prose-invert max-w-none focus:outline-none min-h-[200px] p-4',
      },
      handlePaste: (_view, event) => {
        const items = event.clipboardData?.items;
        if (!items) return false;
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            event.preventDefault();
            const file = item.getAsFile();
            if (file) void options.handleImageUpload(file);
            return true;
          }
        }
        return false;
      },
      handleDrop: (_view, event, _slice, moved) => {
        if (moved) return false;
        const files = event.dataTransfer?.files;
        if (!files) return false;
        for (const file of files) {
          if (file.type.startsWith('image/')) {
            event.preventDefault();
            void options.handleImageUpload(file);
            return true;
          }
        }
        return false;
      },
    },
  });

  options.ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
    if (origin !== 'remote') {
      options.scheduleSave();
    }
  });

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
    unsubComments();
    editorOriginalDestroy();
  };

  return { editor, commentsStore };
}
