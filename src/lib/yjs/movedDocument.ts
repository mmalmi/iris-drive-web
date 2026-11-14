/**
 * Finding where an open document went after its folder was renamed or moved
 * on another device or tab.
 *
 * A rename moves the folder with every file in it, and files are named by
 * their content, so the folder now holding saved batches this copy has read
 * is the document. An unrelated document shares none of them. A copy made
 * earlier holds fewer, which is why the folder sharing the most is chosen.
 */
import { LinkType, type CID, type HashTree, type TreeEntry } from '@hashtree/core';
import { documentKind, type DocumentKind } from '../documentNames';

/** More folders than this are not walked looking for a moved document. */
const MAX_FOLDERS = 2000;
const METADATA_DIRECTORY = '.hashtree';

export interface MovedDocumentSearch {
  tree: Pick<HashTree, 'listDirectory' | 'resolvePath'>;
  root: CID;
  /** Where the document was. */
  from: readonly string[];
  kind: DocumentKind;
  /** How many of a document folder's saved batches this copy has read. */
  known: (entries: TreeEntry[]) => Promise<number>;
}

/**
 * The path of the document folder of the same kind that shares the most saved
 * batches with this copy, other than `from`, or null when none shares any.
 * Folders beside the old place are looked at first, then the whole Drive.
 */
export async function findMovedDocument(search: MovedDocumentSearch): Promise<string[] | null> {
  const parent = search.from.slice(0, -1);
  const parentFolder = parent.length === 0
    ? { cid: search.root, type: LinkType.Dir }
    : await search.tree.resolvePath(search.root, parent.join('/'));
  if (parentFolder?.type === LinkType.Dir) {
    const nearby = await best(search, [{ path: parent, cid: parentFolder.cid }], false);
    if (nearby) return nearby;
  }
  return best(search, [{ path: [], cid: search.root }], true);
}

async function best(
  search: MovedDocumentSearch,
  start: Array<{ path: string[]; cid: CID }>,
  deep: boolean,
): Promise<string[] | null> {
  const from = search.from.join('/');
  let found: { path: string[]; known: number } | null = null;
  const queue = [...start];
  let walked = 0;
  while (queue.length > 0 && walked < MAX_FOLDERS) {
    const folder = queue.shift()!;
    walked += 1;
    for (const entry of await search.tree.listDirectory(folder.cid)) {
      if (entry.type !== LinkType.Dir || (folder.path.length === 0 && entry.name === METADATA_DIRECTORY)) continue;
      const path = [...folder.path, entry.name];
      if (documentKind(entry.name) === null) {
        if (deep) queue.push({ path, cid: entry.cid });
        continue;
      }
      if (documentKind(entry.name) !== search.kind || path.join('/') === from) continue;
      const known = await search.known(await search.tree.listDirectory(entry.cid));
      if (known > 0 && (!found || known > found.known)) found = { path, known };
    }
  }
  return found?.path ?? null;
}
