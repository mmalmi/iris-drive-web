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
