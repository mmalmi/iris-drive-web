import { LinkType, toHex, type CID, type HashTree, type TreeEntry } from '@hashtree/core';

export const PROFILE_DRIVE_METADATA_DIRECTORY = '.hashtree';
export const PATH_KIND_REPLACEMENTS_FILE = 'path-kind-replacements';
export const PATH_KIND_REPLACEMENT_DELTA_FILE = 'path-kind-replacement-delta.json';

const utf8Encoder = new TextEncoder();
const fatalUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

export type PathKindReplacementOperation =
  | { op: 'set'; path: string; generation: number }
  | { op: 'clear'; path: string };

export type PathKindReplacementDelta = {
  inheritPrevious: boolean;
  operations: PathKindReplacementOperation[];
};

export type MetadataDirectoryState = {
  dir: TreeEntry | null;
  entries: Map<string, TreeEntry>;
};

function bytesEqual(left: Uint8Array | undefined, right: Uint8Array | undefined): boolean {
  if (!left || !right) return !left && !right;
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

export function sameCid(left: CID | undefined, right: CID | undefined): boolean {
  return (!left && !right) || (!!left && !!right && bytesEqual(left.hash, right.hash) && bytesEqual(left.key, right.key));
}

export function cidCacheKey(cid: CID): string {
  return cid.key ? `${toHex(cid.hash)}:${toHex(cid.key)}` : toHex(cid.hash);
}

/** Read `.hashtree` entries from `root` in a single pass. */
export async function readMetadataEntries(
  tree: HashTree,
  root: CID,
  signal?: AbortSignal,
): Promise<MetadataDirectoryState> {
  const rootEntries = await tree.listDirectory(root, signal);
  const dir = rootEntries.find((entry) => entry.name === PROFILE_DRIVE_METADATA_DIRECTORY) ?? null;
  if (!dir || dir.type !== LinkType.Dir) return { dir, entries: new Map() };
  const listed = await tree.listDirectory(dir.cid, signal);
  return { dir, entries: new Map(listed.map((entry) => [entry.name, entry])) };
}

/** Apply all `.hashtree` additions/updates/removals in a single directory write. */
export async function writeMetadataEntries(
  tree: HashTree,
  root: CID,
  meta: MetadataDirectoryState,
  updates: Record<string, TreeEntry | null>,
): Promise<CID> {
  const next = new Map(meta.entries);
  for (const [name, entry] of Object.entries(updates)) {
    if (entry === null) next.delete(name);
    else next.set(name, entry);
  }
  if (meta.dir?.type === LinkType.Dir && next.size === meta.entries.size) {
    let unchanged = true;
    for (const [name, entry] of next) {
      const prev = meta.entries.get(name);
      if (!prev || prev.type !== entry.type || prev.size !== entry.size || !sameCid(prev.cid, entry.cid)) {
        unchanged = false;
        break;
      }
    }
    if (unchanged) return root;
  }
  if (next.size === 0) {
    return meta.dir ? tree.removeEntry(root, [], PROFILE_DRIVE_METADATA_DIRECTORY) : root;
  }
  if (meta.dir && meta.dir.type !== LinkType.Dir) {
    root = await tree.removeEntry(root, [], PROFILE_DRIVE_METADATA_DIRECTORY);
  }
  const metadataRoot = (await tree.putDirectory([...next.values()])).cid;
  return tree.setEntry(root, [], PROFILE_DRIVE_METADATA_DIRECTORY, metadataRoot, 0, LinkType.Dir);
}

export function encodePathKindReplacements(roles: ReadonlyMap<string, number>): Uint8Array {
  const replacements = [...roles]
    .map(([path, generation]) => {
      assertLogicalPath(path);
      assertGeneration(generation);
      return { path, generation };
    })
    .sort((left, right) => compareUtf8(left.path, right.path));
  return utf8Encoder.encode(JSON.stringify({ schema: 1, replacements }));
}

export function decodePathKindReplacements(raw: Uint8Array): Map<string, number> {
  let value: unknown;
  try {
    value = JSON.parse(fatalUtf8Decoder.decode(raw));
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

export async function readPathKindReplacementsEntry(
  tree: HashTree,
  entry: TreeEntry | undefined,
): Promise<{ present: boolean; roles: Map<string, number> }> {
  if (!entry) return { present: false, roles: new Map() };
  if (entry.type === LinkType.Dir) throw new Error('path-kind replacement metadata must be a file');
  const raw = await tree.readFile(entry.cid);
  if (!raw) throw new Error('path-kind replacement metadata is unavailable');
  return { present: true, roles: decodePathKindReplacements(raw) };
}

export async function readPathKindReplacements(
  tree: HashTree,
  root: CID,
): Promise<{ present: boolean; roles: Map<string, number> }> {
  const meta = await readMetadataEntries(tree, root);
  return readPathKindReplacementsEntry(tree, meta.entries.get(PATH_KIND_REPLACEMENTS_FILE));
}

export async function replacePathKindReplacements(
  tree: HashTree,
  root: CID,
  roles: ReadonlyMap<string, number>,
): Promise<CID> {
  const meta = await readMetadataEntries(tree, root);
  const file = await tree.putFile(encodePathKindReplacements(roles));
  return writeMetadataEntries(tree, root, meta, {
    [PATH_KIND_REPLACEMENTS_FILE]: {
      name: PATH_KIND_REPLACEMENTS_FILE,
      cid: file.cid,
      size: file.size,
      type: LinkType.Blob,
    },
  });
}

export async function readPathKindReplacementDeltaEntry(
  tree: HashTree,
  entry: TreeEntry | undefined,
): Promise<PathKindReplacementDelta | null> {
  if (!entry) return null;
  if (entry.type === LinkType.Dir) throw new Error('path-kind replacement delta must be a file');
  const raw = await tree.readFile(entry.cid);
  if (!raw) throw new Error('path-kind replacement delta is unavailable');
  let value: unknown;
  try {
    value = JSON.parse(fatalUtf8Decoder.decode(raw));
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

export function encodePathKindReplacementDelta(delta: PathKindReplacementDelta): Uint8Array {
  const operations = delta.operations.map((operation) => {
    assertLogicalPath(operation.path);
    if (operation.op === 'set') {
      assertGeneration(operation.generation);
      return { op: operation.op, path: operation.path, generation: operation.generation };
    }
    return { op: operation.op, path: operation.path };
  });
  return utf8Encoder.encode(JSON.stringify({
    schema: 1,
    inherit_previous: delta.inheritPrevious,
    operations,
  }));
}

export function applyPathKindReplacementOperations(
  roles: ReadonlyMap<string, number>,
  operations: readonly PathKindReplacementOperation[],
): Map<string, number> {
  const next = new Map(roles);
  for (const operation of operations) {
    if (operation.op === 'set') {
      next.set(operation.path, operation.generation);
    } else if (operation.op === 'clear') {
      for (const path of next.keys()) {
        if (path === operation.path || path.startsWith(`${operation.path}/`)) next.delete(path);
      }
    }
  }
  return next;
}

export function compareUtf8(left: string, right: string): number {
  const leftBytes = utf8Encoder.encode(left);
  const rightBytes = utf8Encoder.encode(right);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
