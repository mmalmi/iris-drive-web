import { LinkType, type CID, type HashTree, type TreeEntry } from '@hashtree/core';

import { freeName } from './driveClipboard';
import { isDocumentFolderName } from './documentNames';

export interface MoveResult {
  root: CID;
  items: { entry: TreeEntry; destinationName: string }[];
}

const startsWith = (path: string[], prefix: string[]) => prefix.every((part, index) => path[index] === part);

/** Validate the whole move, then rebuild each affected folder once. File contents stay unchanged. */
export async function moveEntriesInTree(
  tree: HashTree,
  root: CID,
  sourcePath: string[],
  names: string[],
  targetPath: string[],
): Promise<MoveResult> {
  const chosen = new Set(names);
  if (!chosen.size) return { root, items: [] };
  if (sourcePath.length === targetPath.length && startsWith(sourcePath, targetPath)) {
    throw new Error('The items are already in this folder');
  }
  for (const name of chosen) {
    if (startsWith(targetPath, [...sourcePath, name])) throw new Error('A folder cannot be moved inside itself');
  }

  const folders = new Map<string, { cid: CID; entries: TreeEntry[] }>();
  async function read(path: string[]): Promise<{ cid: CID; entries: TreeEntry[] }> {
    const key = JSON.stringify(path);
    const cached = folders.get(key);
    if (cached) return cached;
    let cid = root;
    if (path.length) {
      const parent = await read(path.slice(0, -1));
      const entry = parent.entries.find(entry => entry.name === path.at(-1));
      if (entry?.type !== LinkType.Dir) throw new Error('That folder is no longer there');
      cid = entry.cid;
    }
    const folder = { cid, entries: await tree.listDirectory(cid) };
    folders.set(key, folder);
    return folder;
  }

  const source = await read(sourcePath);
  const target = await read(targetPath);
  const available = new Map(source.entries.map(entry => [entry.name, entry]));
  const taken = new Set(target.entries.map(entry => entry.name));
  // Reserve incoming names too, so a collision cannot take a sibling’s original name.
  const reserved = new Set([...taken, ...chosen]);
  const items: MoveResult['items'] = [];
  for (const name of chosen) {
    const entry = available.get(name);
    if (!entry) throw new Error(`“${name}” is no longer there`);
    const destinationName = taken.has(name)
      ? freeName(name, reserved, entry.type !== LinkType.Dir || isDocumentFolderName(name))
      : name;
    reserved.add(destinationName);
    items.push({ entry, destinationName });
  }
  source.entries = source.entries.filter(entry => !chosen.has(entry.name));
  target.entries = [...target.entries, ...items.map(({ entry, destinationName }) => ({ ...entry, name: destinationName }))];

  async function rebuild(path: string[]): Promise<{ cid: CID; size: number }> {
    const folder = await read(path);
    const entries: TreeEntry[] = [];
    for (const entry of folder.entries) {
      const child = [...path, entry.name];
      if (startsWith(sourcePath, child) || startsWith(targetPath, child)) {
        entries.push({ ...entry, ...await rebuild(child) });
      } else {
        entries.push(entry);
      }
    }
    return tree.putDirectory(entries, { unencrypted: !folder.cid.key });
  }
  return { root: (await rebuild([])).cid, items };
}
