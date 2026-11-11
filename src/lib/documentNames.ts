/**
 * A document is a Drive folder whose name ends in `.irisdoc`. Kept apart from
 * the editor code so file lists can recognise documents without loading it.
 */
export const DOCUMENT_EXTENSION = '.irisdoc';

export function isDocumentFolderName(name: string | null | undefined): boolean {
  return !!name && name.length > DOCUMENT_EXTENSION.length && name.toLowerCase().endsWith(DOCUMENT_EXTENSION);
}

/** The title shown for a document folder. */
export function documentTitle(folderName: string): string {
  return isDocumentFolderName(folderName) ? folderName.slice(0, -DOCUMENT_EXTENSION.length) : folderName;
}

export function documentFolderName(title: string): string {
  return `${title.trim()}${DOCUMENT_EXTENSION}`;
}

/** Query parameter that carries a document's title in a read-only snapshot link. */
export const DOCUMENT_TITLE_PARAM = 'doc';

/** The document folder name a route shows, or null when the route is not a document. */
export function routeDocumentFolderName(route: { path: string[]; isPermalink: boolean; params: URLSearchParams }): string | null {
  const last = route.path[route.path.length - 1];
  if (isDocumentFolderName(last)) return last;
  const title = route.isPermalink && route.path.length === 0 ? route.params.get(DOCUMENT_TITLE_PARAM) : null;
  return title ? documentFolderName(title) : null;
}
