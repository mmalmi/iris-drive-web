import { LinkType, type CID, type HashTree, type TreeEntry } from '@hashtree/core';

export const PROFILE_DRIVE_METADATA_DIRECTORY = '.hashtree';
export const PATH_KIND_REPLACEMENTS_FILE = 'path-kind-replacements';
export const PATH_KIND_REPLACEMENT_DELTA_FILE = 'path-kind-replacement-delta.json';

export type PathKindReplacementOperation =
  | { op: 'set'; path: string; generation: number }
  | { op: 'clear'; path: string };

export type PathKindReplacementDelta = {
  inheritPrevious: boolean;
  operations: PathKindReplacementOperation[];
};

export function encodePathKindReplacements(roles: ReadonlyMap<string, number>): Uint8Array {
  const replacements = [...roles]
    .map(([path, generation]) => {
      assertLogicalPath(path);
      assertGeneration(generation);
      return { path, generation };
    })
    .sort((left, right) => compareUtf8(left.path, right.path));
  return new TextEncoder().encode(JSON.stringify({ schema: 1, replacements }));
}

export function decodePathKindReplacements(raw: Uint8Array): Map<string, number> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new Error('invalid path-kind replacement metadata');
  }
  if (!isRecord(value)
    || !hasExactKeys(value, ['schema', 'replacements'])
    || value.schema !== 1
    || !Array.isArray(value.replacements)) {
    throw new Error('invalid path-kind replacement metadata');
  }

  const roles = new Map<string, number>();
  let previousPath: string | undefined;
  for (const item of value.replacements) {
    if (!isRecord(item)
      || !hasExactKeys(item, ['path', 'generation'])
      || typeof item.path !== 'string'
      || typeof item.generation !== 'number') {
      throw new Error('invalid path-kind replacement record');
    }
    assertLogicalPath(item.path);
    assertGeneration(item.generation);
    if (roles.has(item.path) || (previousPath !== undefined && compareUtf8(previousPath, item.path) >= 0)) {
      throw new Error('path-kind replacement records must be uniquely sorted');
    }
    roles.set(item.path, item.generation);
    previousPath = item.path;
  }
  return roles;
}

export async function readPathKindReplacements(
  tree: HashTree,
  root: CID,
): Promise<{ present: boolean; roles: Map<string, number> }> {
  const entry = await resolveEntry(tree, root, [
    PROFILE_DRIVE_METADATA_DIRECTORY,
    PATH_KIND_REPLACEMENTS_FILE,
  ]);
  if (!entry) return { present: false, roles: new Map() };
  if (entry.type === LinkType.Dir) throw new Error('path-kind replacement metadata must be a file');
  const raw = await tree.readFile(entry.cid);
  if (!raw) throw new Error('path-kind replacement metadata is unavailable');
  return { present: true, roles: decodePathKindReplacements(raw) };
}

export async function replacePathKindReplacements(
  tree: HashTree,
  root: CID,
  roles: ReadonlyMap<string, number>,
): Promise<CID> {
  return replaceMetadataFile(
    tree,
    root,
    PATH_KIND_REPLACEMENTS_FILE,
    encodePathKindReplacements(roles),
  );
}

export async function readPathKindReplacementDelta(
  tree: HashTree,
  root: CID,
): Promise<PathKindReplacementDelta | null> {
  const entry = await resolveEntry(tree, root, [
    PROFILE_DRIVE_METADATA_DIRECTORY,
    PATH_KIND_REPLACEMENT_DELTA_FILE,
  ]);
  if (!entry) return null;
  if (entry.type === LinkType.Dir) throw new Error('path-kind replacement delta must be a file');
  const raw = await tree.readFile(entry.cid);
  if (!raw) throw new Error('path-kind replacement delta is unavailable');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
  } catch {
    throw new Error('invalid path-kind replacement delta');
  }
  if (!isRecord(value)
    || !hasExactKeys(value, ['schema', 'inherit_previous', 'operations'])
    || value.schema !== 1
    || typeof value.inherit_previous !== 'boolean'
    || !Array.isArray(value.operations)) {
    throw new Error('invalid path-kind replacement delta');
  }
  return {
    inheritPrevious: value.inherit_previous,
    operations: value.operations.map(parseDeltaOperation),
  };
}

export async function replacePathKindReplacementDelta(
  tree: HashTree,
  root: CID,
  delta: PathKindReplacementDelta | null,
): Promise<CID> {
  if (!delta) return removeMetadataFile(tree, root, PATH_KIND_REPLACEMENT_DELTA_FILE);
  const operations = delta.operations.map((operation) => {
    if (operation.op === 'set') {
      assertLogicalPath(operation.path);
      assertGeneration(operation.generation);
      return { op: operation.op, path: operation.path, generation: operation.generation };
    }
    assertLogicalPath(operation.path);
    return { op: operation.op, path: operation.path };
  });
  const raw = new TextEncoder().encode(JSON.stringify({
    schema: 1,
    inherit_previous: delta.inheritPrevious,
    operations,
  }));
  return replaceMetadataFile(tree, root, PATH_KIND_REPLACEMENT_DELTA_FILE, raw);
}

export function applyPathKindReplacementOperations(
  roles: ReadonlyMap<string, number>,
  operations: readonly PathKindReplacementOperation[],
): Map<string, number> {
  const next = new Map(roles);
  for (const operation of operations) {
    if (operation.op === 'set') {
      next.set(operation.path, operation.generation);
      continue;
    }
    if (operation.op === 'clear') {
      for (const path of next.keys()) {
        if (pathIsAtOrBelow(path, operation.path)) next.delete(path);
      }
      continue;
    }
  }
  return next;
}

export function compareUtf8(left: string, right: string): number {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < length; index += 1) {
    if (leftBytes[index] !== rightBytes[index]) return leftBytes[index] - rightBytes[index];
  }
  return leftBytes.length - rightBytes.length;
}

function parseDeltaOperation(value: unknown): PathKindReplacementOperation {
  if (!isRecord(value) || typeof value.op !== 'string') {
    throw new Error('invalid path-kind replacement delta operation');
  }
  if (value.op === 'set'
    && hasExactKeys(value, ['op', 'path', 'generation'])
    && typeof value.path === 'string'
    && typeof value.generation === 'number') {
    assertLogicalPath(value.path);
    assertGeneration(value.generation);
    return { op: 'set', path: value.path, generation: value.generation };
  }
  if (value.op === 'clear'
    && hasExactKeys(value, ['op', 'path'])
    && typeof value.path === 'string') {
    assertLogicalPath(value.path);
    return { op: 'clear', path: value.path };
  }
  throw new Error('invalid path-kind replacement delta operation');
}

function assertGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('path-kind replacement generation must be a positive safe integer');
  }
}

function assertLogicalPath(path: string): void {
  const parts = path.split('/');
  if (!path
    || path.startsWith('/')
    || path.endsWith('/')
    || path.includes('//')
    || path.includes('\\')
    || path.includes('\0')
    || parts.some((part) => !part || part === '.' || part === '..' || part === PROFILE_DRIVE_METADATA_DIRECTORY)) {
    throw new Error(`invalid path-kind replacement path: ${path}`);
  }
}

async function replaceMetadataFile(
  tree: HashTree,
  root: CID,
  name: string,
  raw: Uint8Array,
): Promise<CID> {
  const metadata = await resolveEntry(tree, root, [PROFILE_DRIVE_METADATA_DIRECTORY]);
  let metadataRoot = metadata?.type === LinkType.Dir
    ? metadata.cid
    : (await tree.putDirectory([])).cid;
  if (metadata && metadata.type !== LinkType.Dir) {
    root = await tree.removeEntry(root, [], PROFILE_DRIVE_METADATA_DIRECTORY);
  }
  const existing = await resolveEntry(tree, metadataRoot, [name]);
  if (existing) metadataRoot = await tree.removeEntry(metadataRoot, [], name);
  const file = await tree.putFile(raw);
  metadataRoot = await tree.setEntry(metadataRoot, [], name, file.cid, file.size, LinkType.Blob);
  return tree.setEntry(root, [], PROFILE_DRIVE_METADATA_DIRECTORY, metadataRoot, 0, LinkType.Dir);
}

async function removeMetadataFile(tree: HashTree, root: CID, name: string): Promise<CID> {
  const metadata = await resolveEntry(tree, root, [PROFILE_DRIVE_METADATA_DIRECTORY]);
  if (!metadata || metadata.type !== LinkType.Dir) return root;
  const existing = await resolveEntry(tree, metadata.cid, [name]);
  if (!existing) return root;
  const metadataRoot = await tree.removeEntry(metadata.cid, [], name);
  if ((await tree.listDirectory(metadataRoot)).length === 0) {
    return tree.removeEntry(root, [], PROFILE_DRIVE_METADATA_DIRECTORY);
  }
  return tree.setEntry(root, [], PROFILE_DRIVE_METADATA_DIRECTORY, metadataRoot, 0, LinkType.Dir);
}

async function resolveEntry(
  tree: HashTree,
  root: CID,
  parts: string[],
): Promise<TreeEntry | null> {
  const name = parts.at(-1);
  if (!name) return null;
  const parentParts = parts.slice(0, -1);
  const parent = parentParts.length > 0
    ? await tree.resolvePath(root, parentParts)
    : { cid: root, type: LinkType.Dir };
  if (!parent?.cid || parent.type !== LinkType.Dir) return null;
  const entries = await tree.listDirectory(parent.cid);
  return entries.find((entry) => entry.name === name) ?? null;
}

function pathIsAtOrBelow(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length
    && [...keys].sort().every((key, index) => actual[index] === key);
}
