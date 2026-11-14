import { describe, expect, it } from 'vitest';
import { HashTree, LinkType, MemoryStore, type CID, type TreeEntry } from '@hashtree/core';
import * as Y from 'yjs';
import { DocumentSession } from '../src/lib/yjs/documentStore';
import { findMovedDocument } from '../src/lib/yjs/movedDocument';

const tree = new HashTree({ store: new MemoryStore() });

async function file(text: string): Promise<TreeEntry> {
  const ydoc = new Y.Doc();
  ydoc.getText('body').insert(0, text);
  const stored = await tree.putFile(Y.encodeStateAsUpdate(ydoc));
  return { name: text, cid: stored.cid, size: stored.size, type: LinkType.Blob };
}

async function dir(entries: Record<string, CID | TreeEntry>): Promise<CID> {
  return (await tree.putDirectory(Object.entries(entries).map(([name, value]) => (
    'cid' in value
      ? { ...value, name }
      : { name, cid: value, size: 0, type: LinkType.Dir }
  )))).cid;
}

/** A document folder holding the given saved batches, in one writer's folder. */
async function documentFolder(files: TreeEntry[]): Promise<CID> {
  const saves = await dir(Object.fromEntries(files.map(entry => [entry.name, entry])));
  return dir({ updates: await dir({ 'aaaaaaaaaaaa-0': saves }) });
}

describe('finding where a renamed or moved document went', () => {
  it('picks the document folder that holds the most of what this copy read, beside the old place first', async () => {
    const [one, two, three, unrelated] = await Promise.all(['one', 'two', 'three', 'unrelated'].map(file));
    const session = new DocumentSession({ ydoc: new Y.Doc(), tree, writerId: 'bbbbbbbbbbbb', commit: async () => {} });
    await session.load(await tree.listDirectory(await documentFolder([one, two, three])));

    const notes = await dir({
      'Copy made earlier.irisdoc': await documentFolder([one]),
      'Renamed.irisdoc': await documentFolder([one, two, three]),
      'Unrelated.irisdoc': await documentFolder([unrelated]),
      // Another kind holding the same files is not this document.
      'Same files.irissheet': await documentFolder([one, two, three]),
    });
    const root = await dir({ Notes: notes, Elsewhere: await dir({ 'Far.irisdoc': await documentFolder([one, two, three]) }) });
    const search = {
      tree,
      root,
      from: ['Notes', 'Plan.irisdoc'],
      kind: 'document' as const,
      known: (entries: TreeEntry[]) => session.filesKnown(entries),
    };
    expect(await findMovedDocument(search)).toEqual(['Notes', 'Renamed.irisdoc']);

    // Moved to another folder: nothing related beside the old place, so the whole Drive is looked through.
    const moved = await dir({
      Notes: await dir({ 'Unrelated.irisdoc': await documentFolder([unrelated]) }),
      Archive: await dir({ Old: await dir({ 'Plan.irisdoc': await documentFolder([one, two]) }) }),
    });
    expect(await findMovedDocument({ ...search, root: moved })).toEqual(['Archive', 'Old', 'Plan.irisdoc']);
    // An older copy beside the old place does not win over where it was moved.
    const movedBesideCopy = await dir({
      Notes: await dir({ 'Copy made earlier.irisdoc': await documentFolder([one]) }),
      Archive: await dir({ 'Plan.irisdoc': await documentFolder([one, two, three]) }),
    });
    expect(await findMovedDocument({ ...search, root: movedBesideCopy })).toEqual(['Archive', 'Plan.irisdoc']);

    // Deleted: nothing holds any of it, and the folder at the old place itself does not count.
    const deleted = await dir({
      Notes: await dir({
        'Plan.irisdoc': await documentFolder([one, two, three]),
        'Unrelated.irisdoc': await documentFolder([unrelated]),
      }),
    });
    expect(await findMovedDocument({ ...search, root: deleted })).toBeNull();
  });
});
