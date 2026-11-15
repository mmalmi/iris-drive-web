/**
 * Finding where an open document went after its folder was renamed or moved
 * on another device or tab.
 *
 * A rename moves the folder with every file in it, and files are named by
 * their content, so the folder now holding saved batches this copy has read
 * is the document. An unrelated document shares none of them. A copy made
 * earlier holds fewer, which is why the folder sharing the most is chosen.
 *
 * This copy may have read none of them: what it shows can have come live from
 * another device, before the save that stored it reached this one. The Drive
 * then still says which saved batches were taken out of the old folder, and
 * the folder holding those under the same names is the document.
 */
import { LinkType, type CID, type HashTree, type TreeEntry } from '@hashtree/core';
import { documentKind, type DocumentKind } from '../documentNames';
import { UPDATES_DIRECTORY } from './documentStore';

/** More folders than this are not looked through for a moved document. */
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
  /**
   * The saved batches the Drive records as deleted or renamed away from the
   * old place, as paths from it on. They tell where it went when this copy
   * has read none of what a folder holds.
   */
  taken?: ReadonlySet<string>;
}

/** How many of `taken` a document folder holds, in the same writer's folder under the same name. */
async function takenHeld(tree: MovedDocumentSearch['tree'], entries: TreeEntry[], taken: ReadonlySet<string>): Promise<number> {
  const updates = entries.find(entry => entry.name === UPDATES_DIRECTORY && entry.type === LinkType.Dir);
  if (!updates) return 0;
  let held = 0;
  for (const writer of await tree.listDirectory(updates.cid)) {
    if (writer.type !== LinkType.Dir) continue;
    for (const file of await tree.listDirectory(writer.cid)) {
      if (file.type !== LinkType.Dir && taken.has(`${UPDATES_DIRECTORY}/${writer.name}/${file.name}`)) held += 1;
    }
  }
  return held;
}

/**
 * The path of the document folder of the same kind, other than `from`, that
 * shares the most saved batches with this copy, or null when none shares
 * any. The folder the document was in is looked through first, so of two
 * that share as much, the one beside the old place wins. When none shares
 * any, the one holding the most of `taken` is it.
 */
export async function findMovedDocument(search: MovedDocumentSearch): Promise<string[] | null> {
  const from = search.from.join('/');
  const queue: Array<{ path: string[]; cid: CID }> = [];
  const parent = search.from.slice(0, -1);
  const parentFolder = parent.length > 0 ? await search.tree.resolvePath(search.root, parent) : null;
  if (parentFolder?.type === LinkType.Dir) queue.push({ path: parent, cid: parentFolder.cid });
  queue.push({ path: [], cid: search.root });

  const listed = new Set<string>();
  let found: { path: string[]; known: number } | null = null;
  let holder: { path: string[]; held: number } | null = null;
  while (queue.length > 0 && listed.size < MAX_FOLDERS) {
    const folder = queue.shift()!;
    const key = folder.path.join('/');
    if (listed.has(key)) continue;
    listed.add(key);
    for (const entry of await search.tree.listDirectory(folder.cid)) {
      if (entry.type !== LinkType.Dir || (folder.path.length === 0 && entry.name === METADATA_DIRECTORY)) continue;
      const path = [...folder.path, entry.name];
      const kind = documentKind(entry.name);
      if (kind === null) {
        queue.push({ path, cid: entry.cid });
        continue;
      }
      if (kind !== search.kind || path.join('/') === from) continue;
      const entries = await search.tree.listDirectory(entry.cid);
      const known = await search.known(entries);
      if (known > 0 && (!found || known > found.known)) found = { path, known };
      if (found || !search.taken?.size) continue;
      const held = await takenHeld(search.tree, entries, search.taken);
      if (held > 0 && (!holder || held > holder.held)) holder = { path, held };
    }
  }
  return found?.path ?? holder?.path ?? null;
}
