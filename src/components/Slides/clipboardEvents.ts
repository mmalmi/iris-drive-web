/**
 * The editor's side of copy and paste: filling the clipboard when something
 * is copied, and reading whatever it holds when pasting, from here or from
 * other apps. See clipboard.ts for what goes on it.
 */
import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
import {
  CLIPBOARD_TYPE,
  WEB_CLIPBOARD_TYPE,
  adoptMedia,
  clipboardHtml,
  copyPayload,
  dataUrlOf,
  imageFromSource,
  payloadFromHtml,
  readForeignHtml,
  readPayload,
  withMediaBytes,
  type ClipboardPayload,
  type Copied,
} from '../../lib/slides/clipboard';
import { SLIDE_HEIGHT, SLIDE_WIDTH } from '../../lib/slides/model';
import { frameBox, unionBox } from '../../lib/slides/geometry';

interface Options {
  state: () => SlidesEditorState | null;
  /** Where each attachment of the deck is shown from. */
  urls: Map<string, string>;
  addAttachment: (file: File) => Promise<string>;
  /** The editor's own element; events from elsewhere on the page are left alone. */
  root: () => HTMLElement | undefined;
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

export function createClipboard(options: Options) {
  /** What was last copied here, for browsers that keep only plain text on the clipboard. */
  let copied: Copied | null = null;

  /** A picture of what was copied, drawn from the slide as it is on the page. */
  async function picture(data: Copied): Promise<Blob> {
    const { snapshotPng } = await import('../../lib/slides/snapshot');
    const root = options.root();
    const slide = data.slides[0];
    if (!root || !slide) throw new Error('Nothing to draw');
    if (data.elementIds) {
      const surface = root.querySelector<HTMLElement>('[data-testid="slide-sheet"] .slide-surface');
      const chosen = slide.elements.filter(element => data.elementIds!.includes(element.id));
      const box = unionBox(chosen.map(frameBox));
      if (!surface || !box) throw new Error('Nothing to draw');
      const pad = 4;
      const left = Math.max(0, box.left - pad);
      const top = Math.max(0, box.top - pad);
      return snapshotPng(surface, {
        keep: data.elementIds,
        box: { x: left, y: top, w: Math.min(SLIDE_WIDTH, box.right + pad) - left, h: Math.min(SLIDE_HEIGHT, box.bottom + pad) - top },
        scale: 2,
      });
    }
    const surface = root.querySelector<HTMLElement>(`[data-slide="${slide.id}"] .slide-surface`)
      ?? root.querySelector<HTMLElement>('[data-testid="slide-sheet"] .slide-surface');
    if (!surface) throw new Error('Nothing to draw');
    return snapshotPng(surface, { scale: 1.5 });
  }

  /**
   * Puts the full version on the clipboard where the browser allows it: the
   * pictures' bytes, a PNG for other apps, and our format between tabs. What
   * the copy event already put there stays when this is not allowed.
   */
  function writeFull(data: Copied): void {
    if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return;
    const full = withMediaBytes(data.payload);
    const png = picture(data);
    const pngData = png.then(async (blob) => {
      const url = URL.createObjectURL(blob);
      try {
        return await dataUrlOf(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    }).catch(() => null);
    const html = Promise.all([full, pngData])
      .then(([payload, image]) => new Blob([clipboardHtml(payload, data.text, image ?? undefined)], { type: 'text/html' }));
    const items: Record<string, Blob | Promise<Blob>> = {
      'text/plain': new Blob([data.text || ' '], { type: 'text/plain' }),
      'text/html': html,
      'image/png': png,
    };
    if (ClipboardItem.supports?.(WEB_CLIPBOARD_TYPE)) {
      items[WEB_CLIPBOARD_TYPE] = full.then(payload => new Blob([JSON.stringify(payload)], { type: WEB_CLIPBOARD_TYPE }));
    }
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

  /** Pastes something copied from a deck, with its pictures made this deck's own first. */
  async function pastePayload(current: SlidesEditorState, payload: ClipboardPayload): Promise<void> {
    const { payload: own, missing } = await adoptMedia(payload, options.urls, options.addAttachment);
    current.paste(own);
    if (missing) current.notice = missing === 1 ? 'One picture could not be copied.' : `${missing} pictures could not be copied.`;
  }

  /**
   * Pastes words and pictures from another app: the words as a text box on
   * the left, the pictures one under the other on the right; alone, either
   * takes the middle.
   */
  async function pasteForeign(current: SlidesEditorState, found: { text: string; images: string[] }, files: File[]): Promise<void> {
    const both = !!found.text && found.images.length > 0;
    if (found.text) current.pasteText(found.text, both ? { x: 80, y: 120, w: 520 } : undefined);
    const read = await Promise.all(found.images.map(async (src, index) => await imageFromSource(src) ?? files[index] ?? null));
    const pictures = read.filter((file): file is File => !!file);
    const failed = read.length - pictures.length;
    const room = { w: both ? 520 : 760, h: Math.max(120, Math.floor((both ? 560 : 520) / Math.max(1, pictures.length))) };
    for (const [index, file] of pictures.entries()) {
      const at = both || pictures.length > 1 ? { x: both ? 940 : 640, y: 80 + room.h * (index + 0.5) } : undefined;
      await current.addImage(file, at, room);
    }
    if (failed) current.notice = 'Some pictures could not be read from where they were copied.';
  }

  function onPaste(event: ClipboardEvent): void {
    const current = options.state();
    const data = event.clipboardData;
    if (!current?.canEdit || current.presenting || eventPlace(options.root(), event.target) !== 'editor' || !data) return;
    const html = data.getData('text/html');
    const payload = readPayload(data.getData(CLIPBOARD_TYPE)) ?? (html ? payloadFromHtml(html) : null);
    if (payload) {
      event.preventDefault();
      void pastePayload(current, payload);
      return;
    }
    const files = [...data.files].filter(file => file.type.startsWith('image/'));
    const foreign = html ? readForeignHtml(html) : null;
    if (foreign && foreign.images.length && (foreign.text || !files.length)) {
      event.preventDefault();
      void pasteForeign(current, foreign, files);
      return;
    }
    if (files.length) {
      event.preventDefault();
      for (const file of files) void current.addImage(file);
      return;
    }
    const text = data.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    if (copied && (copied.text || ' ') === text) void pastePayload(current, copied.payload);
    else current.pasteText(text);
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
    let text: string | null = null;
    try {
      for (const item of await navigator.clipboard.read()) {
        const own = item.types.includes(WEB_CLIPBOARD_TYPE) ? readPayload(await (await item.getType(WEB_CLIPBOARD_TYPE)).text()) : null;
        const html = item.types.includes('text/html') ? await (await item.getType('text/html')).text() : '';
        const payload = own ?? (html ? payloadFromHtml(html) : null);
        if (payload) return await pastePayload(current, payload);
        const image = item.types.find(type => type.startsWith('image/'));
        const foreign = html ? readForeignHtml(html) : null;
        if (foreign?.images.length && foreign.text) return await pasteForeign(current, foreign, []);
        if (image) {
          const blob = await item.getType(image);
          await current.addImage(new File([blob], `pasted.${image.split('/')[1] ?? 'png'}`, { type: image }));
          return;
        }
        if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      }
    } catch {
      text = await navigator.clipboard?.readText?.().catch(() => null) ?? null;
    }
    if (copied && (text === null || text === (copied.text || ' '))) await pastePayload(current, copied.payload);
    else if (text) current.pasteText(text);
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
