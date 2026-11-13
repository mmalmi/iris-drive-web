/**
 * A document, spreadsheet or presentation is a Drive folder whose name ends in
 * the extension of its kind. Kept apart from the editor code so file lists can
 * recognise them without loading it.
 */
export type DocumentKind = 'document' | 'sheet' | 'slides';

export interface DocumentKindInfo {
  kind: DocumentKind;
  extension: string;
  /** What a person calls one of these. */
  noun: string;
  newLabel: string;
  /** Icon and colour classes shown beside the title. */
  icon: string;
  /** Whether new ones are offered. A kind whose editor is not finished can still be opened. */
  ready: boolean;
}

export const DOCUMENT_KINDS: Record<DocumentKind, DocumentKindInfo> = {
  document: {
    kind: 'document',
    extension: '.irisdoc',
    noun: 'document',
    newLabel: 'New Document',
    icon: 'i-lucide-file-text text-accent',
    ready: true,
  },
  sheet: {
    kind: 'sheet',
    extension: '.irissheet',
    noun: 'spreadsheet',
    newLabel: 'New Spreadsheet',
    icon: 'i-lucide-table-2 text-success',
    ready: false,
  },
  slides: {
    kind: 'slides',
    extension: '.irisslides',
    noun: 'presentation',
    newLabel: 'New Presentation',
    icon: 'i-lucide-presentation text-orange-500',
    ready: true,
  },
};

export const DOCUMENT_EXTENSION = DOCUMENT_KINDS.document.extension;

/** The kind of document a folder name stands for, or null for an ordinary folder. */
export function documentKind(name: string | null | undefined): DocumentKind | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const info of Object.values(DOCUMENT_KINDS)) {
    if (name.length > info.extension.length && lower.endsWith(info.extension)) return info.kind;
  }
  return null;
}

export function documentKindInfo(name: string | null | undefined): DocumentKindInfo | null {
  const kind = documentKind(name);
  return kind ? DOCUMENT_KINDS[kind] : null;
}

export function isDocumentFolderName(name: string | null | undefined): boolean {
  return documentKind(name) !== null;
}

/** The title shown for a document folder. */
export function documentTitle(folderName: string): string {
  const info = documentKindInfo(folderName);
  return info ? folderName.slice(0, -info.extension.length) : folderName;
}

export function documentFolderName(title: string, kind: DocumentKind = 'document'): string {
  return `${title.trim()}${DOCUMENT_KINDS[kind].extension}`;
}

/** Query parameter that carries a document's title in a read-only snapshot link. */
export const DOCUMENT_TITLE_PARAM = 'doc';
/** Query parameter that says what kind a snapshot link shows; absent for a document. */
export const DOCUMENT_KIND_PARAM = 'kind';

/** The query string of a read-only snapshot link. */
export function snapshotLinkQuery(folderName: string): string {
  const kind = documentKind(folderName) ?? 'document';
  const title = `${DOCUMENT_TITLE_PARAM}=${encodeURIComponent(documentTitle(folderName))}`;
  return kind === 'document' ? title : `${title}&${DOCUMENT_KIND_PARAM}=${kind}`;
}

/** The document folder name a route shows, or null when the route is not a document. */
export function routeDocumentFolderName(route: { path: string[]; isPermalink: boolean; params: URLSearchParams }): string | null {
  const last = route.path[route.path.length - 1];
  if (isDocumentFolderName(last)) return last;
  const title = route.isPermalink && route.path.length === 0 ? route.params.get(DOCUMENT_TITLE_PARAM) : null;
  if (!title) return null;
  const kind = route.params.get(DOCUMENT_KIND_PARAM);
  return documentFolderName(title, kind && kind in DOCUMENT_KINDS ? kind as DocumentKind : 'document');
}
