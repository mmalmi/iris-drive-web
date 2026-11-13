/**
 * Opening plain files from the Drive as Iris documents: an .xlsx or .csv as a
 * spreadsheet, and later a .pptx as a presentation.
 *
 * How it fits together, for anyone adding a kind:
 *
 * 1. Register the file extensions here with the document kind they become,
 *    the button label, and `preview`: a lazily loaded component that shows
 *    the file read-only from its bytes (props `fileName`, `data`), saving
 *    nothing. It is what someone who may not edit sees.
 * 2. The file view (ViewerFileView.svelte) shows the preview in place of the
 *    raw file, and for editors a button with `label`. The button calls
 *    `openAsDocument`, which creates `<file name without extension><kind
 *    extension>` beside the file (or reuses a folder of that name) and opens
 *    it with `?import=<file name>` in the address.
 * 3. The editor of that kind, once its stored content is loaded, calls
 *    `takeImportRequest()`. That returns the file name once and takes the
 *    parameter out of the address. If the editor may write and its document
 *    is still empty, it reads the file with `readSiblingFile(name)`, brings
 *    it in, and clears its undo history so the import cannot be undone into
 *    an empty document. A document that already has content is left as it
 *    is, so opening the file again just opens what was made from it before.
 *
 * Nothing here waits on a relay: the Drive is read from what this device has.
 */
import type { Component } from 'svelte';
import { get } from 'svelte/store';
import { LinkType } from '@hashtree/core';
import { getTree } from '../store';
import { currentHash, routeStore, treeRootStore } from '../stores';
import { createDocument } from '../actions/tree';
import { DOCUMENT_KINDS, documentFolderName, type DocumentKind } from './documentNames';

/** The query parameter that asks an editor to bring a file in. */
const IMPORT_PARAM = 'import';

export interface FilePreviewProps {
  fileName: string;
  data: Uint8Array;
}

export interface FileImport {
  /** Lower-case extensions without the dot. */
  extensions: string[];
  kind: DocumentKind;
  /** The button's text, such as "Open as spreadsheet". */
  label: string;
  /** Shows the file read-only, without saving anything. Without it the file shows as any other file. */
  preview?: () => Promise<{ default: Component<FilePreviewProps> }>;
}

const FILE_IMPORTS: FileImport[] = [
  {
    extensions: ['xlsx', 'csv', 'tsv'],
    kind: 'sheet',
    label: 'Open as spreadsheet',
    preview: () => import('../components/Sheets/SheetPreview.svelte'),
  },
  {
    // The presentation editor brings the file in itself (SlidesEditor, pptxFiles.ts).
    extensions: ['pptx'],
    kind: 'slides',
    label: 'Open as presentation',
  },
];

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
}

/** What a file can be opened as, or null. */
export function fileImportFor(fileName: string | null | undefined): FileImport | null {
  if (!fileName) return null;
  const extension = extensionOf(fileName);
  return FILE_IMPORTS.find(entry => entry.extensions.includes(extension)) ?? null;
}

/** The folder name of the document made from a file: "Budget.xlsx" gives "Budget.irissheet". */
function importedDocumentName(fileName: string, kind: DocumentKind): string {
  const dot = fileName.lastIndexOf('.');
  const base = (dot > 0 ? fileName.slice(0, dot) : fileName).trim() || 'Imported';
  return documentFolderName(base, kind);
}

/**
 * Creates the document beside the file the route shows (or reuses one with
 * that name) and opens it, asking its editor to bring the file in.
 */
export async function openAsDocument(fileName: string, kind: DocumentKind): Promise<void> {
  const route = get(routeStore);
  if (!route.npub || !route.treeName) return;
  const folder = route.path.slice(0, -1);
  const name = importedDocumentName(fileName, kind);
  const root = get(treeRootStore);
  const existing = root ? await getTree().resolvePath(root, [...folder, name]).catch(() => null) : null;
  if (!existing || existing.type !== LinkType.Dir) {
    const created = await createDocument(name.slice(0, -DOCUMENT_KINDS[kind].extension.length), kind);
    if (!created) return;
  }
  const params = new URLSearchParams();
  const key = route.params.get('k');
  if (key) params.set('k', key);
  params.set(IMPORT_PARAM, fileName);
  const path = [...folder, name].map(encodeURIComponent).join('/');
  window.location.hash = `/${route.npub}/${encodeURIComponent(route.treeName)}/${path}?${params.toString()}`;
}

/** The file an editor was asked to bring in, once; the request is taken out of the address. */
export function takeImportRequest(): string | null {
  const hash = window.location.hash;
  const at = hash.indexOf('?');
  if (at < 0) return null;
  const params = new URLSearchParams(hash.slice(at + 1));
  const fileName = params.get(IMPORT_PARAM);
  if (fileName === null) return null;
  params.delete(IMPORT_PARAM);
  const query = params.toString();
  const next = `${hash.slice(0, at)}${query ? `?${query}` : ''}`;
  history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${next}`);
  currentHash.set(window.location.hash);
  return fileName || null;
}

/** Reads a file that sits in the same folder as the open document; null when it is not there. */
export async function readSiblingFile(fileName: string): Promise<Uint8Array | null> {
  const route = get(routeStore);
  const root = get(treeRootStore);
  if (!root || fileName.includes('/')) return null;
  try {
    const entry = await getTree().resolvePath(root, [...route.path.slice(0, -1), fileName]);
    if (!entry || entry.type === LinkType.Dir) return null;
    return await getTree().readFile(entry.cid);
  } catch {
    return null;
  }
}
