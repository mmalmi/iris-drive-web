/**
 * The editor's side of copy and paste: filling the clipboard when something
 * is copied, and handing what it holds to clipboardPaste.ts when pasting.
 * What a clipboard event holds is read at once, while the event lasts; the
 * code that makes sense of it is fetched the first time it is needed. See
 * clipboard.ts for what goes on the clipboard.
 */
import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
import { CLIPBOARD_TYPE, WEB_CLIPBOARD_TYPE, clipboardHtml, copyPayload, type Copied } from '../../lib/slides/clipboard';

export interface ClipboardOptions {
  state: () => SlidesEditorState | null;
  /** Where each attachment of the deck is shown from. */
  urls: Map<string, string>;
  addAttachment: (file: File) => Promise<string>;
  /** The editor's own element; events from elsewhere on the page are left alone. */
  root: () => HTMLElement | undefined;
}

/** What a paste event held, read before the event is over. */
export interface Held {
  own: string;
  html: string;
  text: string;
  files: File[];
}

type Place = 'text' | 'field' | 'editor' | 'elsewhere';

/** Where a key or clipboard event happened: in a text box, in some other field, in the editor, or elsewhere. */
export function eventPlace(root: HTMLElement | undefined, target: EventTarget | null): Place {
  const element = target instanceof Element ? target : null;
  if (!element || element === document.body || element === document.documentElement) return 'editor';
  if (!root?.contains(element)) return 'elsewhere';
  if (element.closest('.ProseMirror')) return 'text';
  // A control with keys of its own, such as the line above the notes, keeps them.
  if (element.closest('input, textarea, select, [contenteditable="true"], [role="separator"]')) return 'field';
  return 'editor';
}

const loadPaste = () => import('./clipboardPaste');

export function createClipboard(options: ClipboardOptions) {
  /** What was last copied here, for browsers that keep only plain text on the clipboard. */
  let copied: Copied | null = null;

  /**
   * Puts the full version on the clipboard where the browser allows it: the
   * pictures' bytes, a PNG for other apps, and our format between tabs. What
   * the copy event already put there stays when this is not allowed. The
   * write is asked for now, while the copy is still the person's own act;
   * what it holds is made by code fetched as it is needed.
   */
  function writeFull(data: Copied): void {
    if (typeof ClipboardItem === 'undefined' || !('write' in (navigator.clipboard ?? {}))) return;
    const made = import('./clipboardCopy').then(copy => copy.makeClipboard(data, options.root()));
    const items: Record<string, Blob | Promise<Blob>> = {
      'text/plain': new Blob([data.text || ' '], { type: 'text/plain' }),
      'text/html': made.then(parts => parts.html),
      'image/png': made.then(parts => parts.png),
    };
    if (ClipboardItem.supports?.(WEB_CLIPBOARD_TYPE)) items[WEB_CLIPBOARD_TYPE] = made.then(parts => parts.own);
    navigator.clipboard.write([new ClipboardItem(items)]).catch(() => {});
  }

  function copyTo(event: ClipboardEvent): boolean {
    const current = options.state();
    if (!current || current.presenting || eventPlace(options.root(), event.target) !== 'editor') return false;
    // Selected words elsewhere on the page are copied as usual.
    if (!window.getSelection()?.isCollapsed) return false;
    const data = copyPayload(current, options.urls);
    if (!data || !event.clipboardData) return false;
    event.preventDefault();
    event.clipboardData.setData(CLIPBOARD_TYPE, JSON.stringify(data.payload));
    event.clipboardData.setData('text/html', clipboardHtml(data.payload, data.text));
    event.clipboardData.setData('text/plain', data.text || ' ');
    copied = data;
    writeFull(data);
    return true;
  }

  function onPaste(event: ClipboardEvent): void {
    const current = options.state();
    const data = event.clipboardData;
    if (!current?.canEdit || current.presenting || eventPlace(options.root(), event.target) !== 'editor' || !data) return;
    const held: Held = {
      own: data.getData(CLIPBOARD_TYPE),
      html: data.getData('text/html'),
      text: data.getData('text/plain'),
      files: [...data.files].filter(file => file.type.startsWith('image/')),
    };
    if (!held.own && !held.html && !held.text && !held.files.length) return;
    event.preventDefault();
    void loadPaste().then(paste => paste.pasteHeld(current, held, copied, options));
  }

  /** Copy and cut from a menu, where there is no clipboard event to fill. */
  function menuCopy(cut: boolean): void {
    const current = options.state();
    const data = current ? copyPayload(current, options.urls) : null;
    if (!current || !data) return;
    copied = data;
    if (typeof ClipboardItem !== 'undefined' && 'write' in (navigator.clipboard ?? {})) writeFull(data);
    else void navigator.clipboard?.writeText(data.text || ' ').catch(() => {});
    if (cut && current.canEdit) current.cut();
  }

  /** Paste from a menu: what the clipboard holds if the browser lets it be read, otherwise what was last copied here. */
  async function menuPaste(): Promise<void> {
    const current = options.state();
    if (!current?.canEdit) return;
    await (await loadPaste()).pasteFromClipboard(current, copied, options);
  }

  return {
    onCopy: (event: ClipboardEvent) => void copyTo(event),
    onCut: (event: ClipboardEvent) => {
      const current = options.state();
      if (current?.canEdit && copyTo(event)) current.cut();
    },
    onPaste,
    menuCopy,
    menuPaste,
  };
}
