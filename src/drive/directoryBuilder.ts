import { LinkType, type CID, type DirEntry, type HashTree, type TreeEntry } from '@hashtree/core';

/**
 * A directory tree assembled in memory and stored bottom-up.
 *
 * Editing a stored tree one entry at a time re-resolves the path and rewrites
 * every ancestor directory per edit, and leaves each intermediate node behind
 * in the store. A caller that already knows the whole result assembles it here
 * so every directory is stored exactly once.
 */
export class DirectoryBuilder {
  /** Metadata on the link that points at this directory from its parent. */
  meta?: Record<string, unknown>;
  // A name lives in one of these, never both.
  private readonly directories = new Map<string, DirectoryBuilder>();
  private readonly leaves = new Map<string, Omit<DirEntry, 'name'>>();

  /**
   * The directory at `segments`, created along with any missing ancestors.
   * A file already holding one of those names is not a directory to descend into.
   */
  directory(segments: readonly string[]): DirectoryBuilder {
    let node: DirectoryBuilder = this;
    for (let depth = 0; depth < segments.length; depth += 1) {
      const segment = segments[depth];
      if (node.leaves.has(segment)) {
        throw new Error(`Path not found: ${segments.slice(0, depth + 1).join('/')}`);
      }
      let child = node.directories.get(segment);
      if (!child) {
        child = new DirectoryBuilder();
        node.directories.set(segment, child);
      }
      node = child;
    }
    return node;
  }

  /** Link stored content into this directory, replacing whatever held that name. */
  setLeaf(name: string, entry: Pick<TreeEntry, 'cid' | 'size' | 'type' | 'meta'>): void {
    this.directories.delete(name);
    this.leaves.set(name, { cid: entry.cid, size: entry.size, type: entry.type, meta: entry.meta });
  }

  /** Store this directory and everything below it, children first. */
  async put(tree: HashTree): Promise<CID> {
    const entries: DirEntry[] = [];
    for (const [name, leaf] of this.leaves) entries.push({ name, ...leaf });
    for (const [name, child] of this.directories) {
      entries.push({ name, cid: await child.put(tree), size: 0, type: LinkType.Dir, meta: child.meta });
    }
    return (await tree.putDirectory(entries)).cid;
  }
}
