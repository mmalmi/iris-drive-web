/**
 * The editor's side of copy and paste: filling the clipboard when something
 * is copied, and handing what it holds to clipboardPaste.ts when pasting.
 * What a clipboard event holds is read at once, while the event lasts; the
 * code that makes sense of it is fetched the first time it is needed. See
 * clipboard.ts for what goes on the clipboard.
 */
import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
import { CLIPBOARD_TYPE, WEB_CLIPBOARD_TYPE, clipboardHtml, copyPayload, imagesOf, readPayload, type ClipboardPayload, type Copied } from '../../lib/slides/clipboard';

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
  /** The clipboard write this deck asked for last. Pasting from the menu reads the clipboard only once it is done. */
  let writing: Promise<unknown> = Promise.resolve();
  /**
   * True while what was last copied here is newer than what the clipboard
   * holds: copied from the menu, and its write not finished yet or turned
   * down. Copying anything else, here or (after leaving the page) in another
   * app, ends it.
   */
  let ahead = false;

  const canWriteFull = () => typeof ClipboardItem !== 'undefined' && 'write' in (navigator.clipboard ?? {});

  /**
   * Puts the full version on the clipboard where the browser allows it: the
   * pictures' bytes, a PNG for other apps, and our format between tabs. What
   * the copy event already put there stays when this is not allowed. The
   * write is asked for now, while the copy is still the person's own act;
   * what it holds is made by code fetched as it is needed.
   */
  function writeFull(data: Copied): Promise<void> {
    const made = import('./clipboardCopy').then(copy => copy.makeClipboard(data, options.root(), options.urls));
    const items: Record<string, Blob | Promise<Blob>> = {
      'text/plain': new Blob([data.text || ' '], { type: 'text/plain' }),
      'text/html': made.then(parts => parts.html),
      'image/png': made.then(parts => parts.png),
    };
    if (ClipboardItem.supports?.(WEB_CLIPBOARD_TYPE)) items[WEB_CLIPBOARD_TYPE] = made.then(parts => parts.own);
    return navigator.clipboard.write([new ClipboardItem(items)]);
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
    ahead = false;
    if (canWriteFull()) writing = writeFull(data).catch(() => {});
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
    // Copied here a moment ago, and not on the clipboard yet (or turned away by it): that copy is the newer.
    const newer = ahead ? copied : null;
    if (!newer && !held.own && !held.html && !held.text && !held.files.length) return;
    event.preventDefault();
    // Copied here, with no picture that this deck lacks: it goes in at once.
    const own = newer?.payload ?? readPayload(held.own) ?? (copied && !held.html.includes('data-iris-slides') && (copied.text || ' ') === held.text ? copied.payload : null);
    if (own && ownMedia(own)) {
      current.paste(own);
      return;
    }
    void loadPaste().then(paste => (newer ? paste.pastePayload(current, newer.payload, options) : paste.pasteHeld(current, held, copied, options)));
  }

  /** Whether every picture a payload names is already this deck's. */
  function ownMedia(payload: ClipboardPayload): boolean {
    const elements = [...(payload.elements ?? []), ...(payload.slides ?? []).flatMap(slide => slide.elements ?? [])];
    return imagesOf(elements).every(src => options.urls.has(src));
  }

  /** Copy and cut from a menu, where there is no clipboard event to fill. */
  function menuCopy(cut: boolean): void {
    const current = options.state();
    const data = current ? copyPayload(current, options.urls) : null;
    if (!current || !data) return;
    copied = data;
    ahead = true;
    const write = canWriteFull() ? writeFull(data) : navigator.clipboard?.writeText(data.text || ' ') ?? Promise.reject(new Error('No clipboard'));
    writing = write.then(() => {
      if (copied === data) ahead = false;
    }, () => {});
    if (cut && current.canEdit) current.cut();
  }

  /**
   * Paste from a menu: what the clipboard holds if the browser lets it be
   * read, otherwise what was last copied here. A copy or cut made a moment
   * ago may still be on its way to the clipboard, so that is waited for.
   */
  async function menuPaste(): Promise<void> {
    const current = options.state();
    if (!current?.canEdit) return;
    await writing;
    const paste = await loadPaste();
    if (ahead && copied) await paste.pastePayload(current, copied.payload, options);
    else await paste.pasteFromClipboard(current, copied, options);
  }

  return {
    onCopy: (event: ClipboardEvent) => {
      ahead = false;
      copyTo(event);
    },
    onCut: (event: ClipboardEvent) => {
      ahead = false;
      const current = options.state();
      if (current?.canEdit && copyTo(event)) current.cut();
    },
    onPaste,
    /** The page was left, perhaps to copy something in another app. */
    onBlur: () => {
      ahead = false;
    },
    menuCopy,
    menuPaste,
  };
}
