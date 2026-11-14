/**
 * The system clipboard and drag and drop for a Drive folder: what a paste or
 * a drop brings in, and what copying a file puts out for other apps.
 *
 * What a clipboard or drag event holds can only be read while the event
 * lasts, so everything here that reads one is synchronous. The slower work
 * (reading a file, redrawing a picture as PNG, fetching a picture from the
 * web) is in driveClipboardData.ts, loaded the first time it is needed.
 */
import { LinkType, type TreeEntry } from '@hashtree/core';
import { entryCopyHref } from './shareUrls';

const loadData = () => import('./driveClipboardData');

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico']);
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'js', 'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'htm', 'xml',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'log', 'sh', 'bash', 'py', 'rb', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
  'java', 'php', 'sql', 'svelte', 'vue',
]);
/** Largest file whose content is copied; a bigger one is copied as a link. */
const MAX_COPY_BYTES = 50 * 1024 * 1024;

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** The local time as files made by pasting are named, like a screenshot: `2026-11-13 at 14.05.33`. */
export function pasteStamp(date = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} at ${two(date.getHours())}.${two(date.getMinutes())}.${two(date.getSeconds())}`;
}

/** `name`, or `name (2)`, `name (3)`… when that is taken. */
export function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const next = `${stem} (${n})${ext}`;
    if (!taken.has(next)) return next;
  }
}

/** Browsers call a screenshot or an image copied from a page `image.png`; those get a name of their own. */
function isUnnamedPicture(file: File): boolean {
  return file.type.startsWith('image/') && (!file.name || /^image\.[a-z0-9]+$/i.test(file.name));
}

function pictureExtension(type: string): string {
  const sub = type.split('/')[1]?.split('+')[0]?.toLowerCase() ?? 'png';
  return sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/g, '') || 'png';
}

export interface Pasted {
  files: File[];
  /** What was pasted, in plain words for a short message. */
  summary: string;
}

/**
 * The files a paste brings into a folder: files copied in Finder or
 * Explorer as they are, a screenshot or copied picture as `Pasted image
 * <time>.png`, and plain text as `Pasted text <time>.txt`. Null when the
 * clipboard holds nothing to keep.
 */
export function pastedIntoFolder(data: DataTransfer | null, taken: ReadonlySet<string>, now = new Date()): Pasted | null {
  if (!data) return null;
  const files: File[] = [];
  for (const item of data.items ?? []) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (files.length === 0) files.push(...(data.files ?? []));
  const used = new Set(taken);
  const named = files.map((file) => {
    const name = freeName(isUnnamedPicture(file) ? `Pasted image ${pasteStamp(now)}.${pictureExtension(file.type)}` : file.name, used);
    used.add(name);
    return name === file.name ? file : new File([file], name, { type: file.type, lastModified: file.lastModified });
  });
  if (named.length > 0) {
    return {
      files: named,
      summary: named.length === 1 ? named[0]!.name : `${named.length} files`,
    };
  }
  const text = data.getData('text/plain');
  if (!text.trim()) return null;
  const name = freeName(`Pasted text ${pasteStamp(now)}.txt`, used);
  return { files: [new File([text], name, { type: 'text/plain' })], summary: name };
}

/**
 * What a drop from the desktop holds, read at once: each dropped item as an
 * entry that can be walked later (folders with what is inside them), and
 * plain files for browsers that give no entries. The entries must be taken
 * during the drop; afterwards the browser no longer hands them out.
 */
export interface DroppedItems {
  entries: FileSystemEntry[];
  files: File[];
  hasFolder: boolean;
}

export function droppedItems(data: DataTransfer): DroppedItems {
  const entries: FileSystemEntry[] = [];
  const files: File[] = [];
  for (const item of data.items ?? []) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
    else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (entries.length === 0 && files.length === 0) files.push(...(data.files ?? []));
  return { entries, files, hasFolder: entries.some(entry => entry.isDirectory) };
}

/**
 * The address of a picture dragged from a web page, which carries the
 * picture's address rather than the picture itself. Null when the drag holds
 * no address.
 */
export function draggedPictureUrl(data: DataTransfer): string | null {
  const html = data.getData('text/html');
  const fromHtml = html ? /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i.exec(html)?.[1] : undefined;
  const fromList = data.getData('text/uri-list').split(/\r?\n/).find(line => line && !line.startsWith('#'));
  const url = (fromHtml ?? fromList ?? '').replace(/&amp;/g, '&').trim();
  return /^(https?:|data:image\/|blob:)/i.test(url) ? url : null;
}

/** Whether a drag over the folder comes from outside the page: files, or a picture from another page. */
export function isOutsideDrag(data: DataTransfer | null): boolean {
  if (!data) return false;
  return data.types.includes('Files') || data.types.includes('text/uri-list');
}

/** A link that opens the entry for anyone who has it, like the share button's Snapshot. */
export function entryLink(entry: Pick<TreeEntry, 'name' | 'cid' | 'type'>): string {
  return window.location.origin + window.location.pathname + entryCopyHref(entry);
}

export type CopiedKind = 'picture' | 'text' | 'link';

/** What copying an entry puts out: a picture for an image file, the text of a text file, a link for the rest. */
export function copyKind(entry: Pick<TreeEntry, 'name' | 'type' | 'size'>): CopiedKind {
  if (entry.type === LinkType.Dir || (entry.size ?? 0) > MAX_COPY_BYTES) return 'link';
  const ext = extensionOf(entry.name);
  if (IMAGE_EXTENSIONS.has(ext)) return 'picture';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'link';
}

/** The words for what was copied, for a short message. */
export function copiedMessage(kind: CopiedKind, name: string): string {
  if (kind === 'picture') return `Copied the picture ${name}`;
  if (kind === 'text') return `Copied the text of ${name}`;
  return `Copied a link to ${name}`;
}

export type CopiedEntry = Pick<TreeEntry, 'name' | 'cid' | 'type' | 'size'>;

/**
 * The entry this page last put on the clipboard, and what it put there.
 * Other apps get a picture, text or link; pasting it back into a folder here
 * adds the file itself, under its own name, without uploading it again.
 */
let lastCopy: { entry: CopiedEntry; text?: string; pictureBytes?: number } | null = null;

/** Remembers what copying an entry put on the clipboard, once it is known. */
export function noteCopied(entry: CopiedEntry, put: { text?: string; pictureBytes?: number } | Promise<{ text?: string; pictureBytes?: number }>): void {
  const copy: NonNullable<typeof lastCopy> = { entry };
  lastCopy = copy;
  void Promise.resolve(put).then((known) => Object.assign(copy, known), () => {
    if (lastCopy === copy) lastCopy = null;
  });
}

const sameText = (a: string, b: string) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

/** The entry a paste brings back, when the clipboard still holds what copying it put there. */
export function copiedEntryIn(data: DataTransfer | null): CopiedEntry | null {
  if (!data || !lastCopy) return null;
  const files = [...(data.files ?? [])];
  if (lastCopy.pictureBytes !== undefined) {
    return files.length === 1 && files[0]!.type.startsWith('image/') && files[0]!.size === lastCopy.pictureBytes ? lastCopy.entry : null;
  }
  if (lastCopy.text === undefined || files.length > 0) return null;
  return sameText(data.getData('text/plain'), lastCopy.text) ? lastCopy.entry : null;
}

/**
 * Puts an entry on the system clipboard for other apps. The write is asked
 * for at once, while the copy is still the person's own act (Safari allows
 * it no later); what it holds is read and made as it is needed. Resolves to
 * what was copied, or rejects when the browser would not take it.
 */
export async function copyEntry(entry: CopiedEntry): Promise<CopiedKind> {
  const kind = copyKind(entry);
  const clipboard = navigator.clipboard;
  const canWrite = typeof ClipboardItem !== 'undefined' && typeof clipboard?.write === 'function';
  if (kind === 'picture' && canWrite) {
    const png = loadData().then(data => data.entryPng(entry));
    noteCopied(entry, png.then(picture => ({ pictureBytes: picture.size })));
    await clipboard.write([new ClipboardItem({ 'image/png': png })]);
    return kind;
  }
  if (kind === 'text') {
    const text = loadData().then(data => data.entryText(entry));
    noteCopied(entry, text.then(words => ({ text: words })));
    if (canWrite) await clipboard.write([new ClipboardItem({ 'text/plain': text.then(words => new Blob([words], { type: 'text/plain' })) })]);
    else await clipboard.writeText(await text);
    return kind;
  }
  const link = entryLink(entry);
  noteCopied(entry, { text: link });
  await clipboard.writeText(link);
  return 'link';
}

/**
 * Drag data that lets the file be dropped onto the desktop (Chrome and Edge):
 * a download from this app's own address, through its file worker.
 */
export function downloadDragData(entry: Pick<TreeEntry, 'name' | 'cid'>, fileUrl: string): string {
  const separator = fileUrl.includes('?') ? '&' : '?';
  const url = new URL(`${fileUrl}${separator}download=1`, window.location.href).href;
  return `application/octet-stream:${entry.name.replace(/:/g, '_')}:${url}`;
}
