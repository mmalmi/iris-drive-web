import { describe, expect, it } from 'vitest';
import { HashTree, LinkType, MemoryStore, type CID, type TreeEntry } from '@hashtree/core';
import * as Y from 'yjs';
import { DocumentSession, type DocumentChange } from '../src/lib/yjs/documentStore';
import {
  listStoredFiles,
  placeBases,
  restoreVersion,
  versionTimeline,
  versionUpdate,
  type StoredFile,
} from '../src/lib/yjs/versionHistory';

const MINUTE = 60_000;
const cid = { hash: new Uint8Array(32) } as CID;

function save(writer: string, time: number, generation = 0): StoredFile {
  return { cid, writer, generation, base: false, time };
}

function base(writer: string, generation: number): StoredFile {
  return { cid, writer, generation, base: true, time: null };
}

/** A document folder that devices save into, as the editor does. */
class Folder {
  readonly tree = new HashTree({ store: new MemoryStore() });
  readonly files = new Map<string, Uint8Array>();
  clock = 1_000_000;

  device(writerId: string, options: { maxChanges?: number; quietMs?: number } = {}) {
    const ydoc = new Y.Doc();
    const session = new DocumentSession({
      ydoc,
      tree: this.tree,
      writerId,
      commit: async (change: DocumentChange) => {
        for (const write of change.writes) this.files.set(write.path.join('/'), write.data);
        for (const directory of change.removeDirectories) {
          const prefix = `${directory.join('/')}/`;
          for (const path of [...this.files.keys()]) if (path.startsWith(prefix)) this.files.delete(path);
        }
      },
      now: () => this.clock,
      ...options,
    });
    return { ydoc, session };
  }

  /** The folder as the Drive would hold it now. */
  async cid(): Promise<CID> {
    const put = async (prefix: string): Promise<CID> => {
      const names = new Set<string>();
      for (const path of this.files.keys()) {
        if (path.startsWith(prefix)) names.add(path.slice(prefix.length).split('/')[0]);
      }
      const entries: TreeEntry[] = [];
      for (const name of names) {
        const data = this.files.get(`${prefix}${name}`);
        if (data) {
          const file = await this.tree.putFile(data);
          entries.push({ name, cid: file.cid, size: file.size, type: LinkType.Blob });
        } else {
          entries.push({ name, cid: await put(`${prefix}${name}/`), size: 0, type: LinkType.Dir });
        }
      }
      return (await this.tree.putDirectory(entries)).cid;
    };
    return put('');
  }
}

async function stateAt(folder: Folder, time: number): Promise<Y.Doc> {
  const files = await listStoredFiles(folder.tree, await folder.cid());
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await versionUpdate(folder.tree, files, time));
  return doc;
}

describe('versionTimeline', () => {
  it('makes one version of saves close together and lists the newest first', () => {
    const versions = versionTimeline([
      save('a', 0),
      save('a', 2 * MINUTE),
      save('b', 4 * MINUTE),
      save('a', 20 * MINUTE),
      save('a', 21 * MINUTE),
    ]);
    expect(versions).toEqual([
      { time: 21 * MINUTE, writers: ['a'] },
      { time: 4 * MINUTE, writers: ['a', 'b'] },
    ]);
  });

  it('ends a long stretch of writing without pauses after a while', () => {
    const saves = Array.from({ length: 50 }, (_unused, index) => save('a', index * MINUTE));
    const versions = versionTimeline(saves);
    expect(versions.map(version => version.time)).toEqual([49 * MINUTE, 30 * MINUTE]);
    expect(versionTimeline(saves, { gapMs: 30_000 })).toHaveLength(50);
  });

  it('lists nothing from before a device folded away its older saves', () => {
    const files = placeBases([
      save('b', 1 * MINUTE),
      save('b', 30 * MINUTE),
      base('a', 3),
      save('a', 60 * MINUTE, 3),
      save('b', 90 * MINUTE),
    ]);
    expect(files.find(file => file.base)?.time).toBe(60 * MINUTE - 1);
    expect(versionTimeline(files).map(version => version.time)).toEqual([90 * MINUTE, 60 * MINUTE]);
  });

  it('places a fresh base after the saves it folded, while their folder is still there', () => {
    const files = placeBases([save('a', 1 * MINUTE, 0), save('a', 2 * MINUTE, 0), base('a', 1)]);
    expect(files.find(file => file.base)?.time).toBe(2 * MINUTE + 1);
    expect(versionTimeline(files)).toEqual([{ time: 2 * MINUTE + 1, writers: ['a'] }]);
  });

  it('has no versions to show when when a base was written cannot be told', () => {
    const files = placeBases([base('a', 2), save('b', 1 * MINUTE)]);
    expect(versionTimeline(files)).toEqual([]);
  });
});

describe('rebuilding versions', () => {
  it('rebuilds the document as it was at each save, from every device', async () => {
    const folder = new Folder();
    const first = folder.device('aaaa');
    const second = folder.device('bbbb');
    first.ydoc.getText('body').insert(0, 'one');
    await first.session.save();
    const afterOne = folder.clock;

    folder.clock += 10 * MINUTE;
    await second.session.load(await folder.tree.listDirectory(await folder.cid()));
    second.ydoc.getText('body').insert(3, ' two');
    await second.session.save();
    const afterTwo = folder.clock;

    folder.clock += 10 * MINUTE;
    await first.session.load(await folder.tree.listDirectory(await folder.cid()));
    first.ydoc.getText('body').insert(7, ' three');
    await first.session.save();

    const files = await listStoredFiles(folder.tree, await folder.cid());
    const versions = versionTimeline(files);
    expect(versions.map(version => version.time)).toEqual([folder.clock, afterTwo, afterOne]);
    expect(versions[1].writers).toEqual(['bbbb']);
    expect((await stateAt(folder, afterOne)).getText('body').toString()).toBe('one');
    expect((await stateAt(folder, afterTwo)).getText('body').toString()).toBe('one two');
    expect((await stateAt(folder, folder.clock)).getText('body').toString()).toBe('one two three');
  });

  it('starts the history at a fold, with the document as the fold left it', async () => {
    const folder = new Folder();
    const writer = folder.device('aaaa', { maxChanges: 2, quietMs: 0 });
    const text = writer.ydoc.getText('body');
    const times: number[] = [];
    for (const word of ['a', 'b', 'c', 'd']) {
      folder.clock += 10 * MINUTE;
      text.insert(text.length, word);
      await writer.session.save();
      times.push(folder.clock);
    }
    // The third save folded the first two into a base and removed their folder.
    expect([...folder.files.keys()].some(path => path.endsWith('aaaa-1/base'))).toBe(true);
    expect([...folder.files.keys()].some(path => path.includes('aaaa-0/'))).toBe(false);
    // The base is placed just before the save after it, and is one version with it.
    const files = await listStoredFiles(folder.tree, await folder.cid());
    expect(files.find(file => file.base)?.time).toBe(times[3] - 1);
    expect(versionTimeline(files)).toEqual([{ time: times[3], writers: ['aaaa'] }]);
    expect((await stateAt(folder, times[3] - 1)).getText('body').toString()).toBe('abc');
    expect((await stateAt(folder, times[3])).getText('body').toString()).toBe('abcd');
  });

  it('keeps a restore apart from the edit just before it, and says what it restored', async () => {
    const folder = new Folder();
    const writer = folder.device('aaaa');
    const text = writer.ydoc.getText('body');
    text.insert(0, 'one');
    await writer.session.save();
    const first = folder.clock;
    folder.clock += 10 * MINUTE;
    text.insert(3, ' two');
    await writer.session.save();
    const second = folder.clock;

    folder.clock += 1000;
    restoreVersion(writer.ydoc, Y.encodeStateAsUpdate(await stateAt(folder, first)), 'mine');
    writer.session.markNext(`r${first.toString(36)}`);
    await writer.session.save();
    expect([...folder.files.keys()].filter(path => path.endsWith(`-r${first.toString(36)}`))).toHaveLength(1);

    const versions = versionTimeline(await listStoredFiles(folder.tree, await folder.cid()));
    expect(versions).toEqual([
      { time: folder.clock, writers: ['aaaa'], restored: first },
      { time: second, writers: ['aaaa'] },
      { time: first, writers: ['aaaa'] },
    ]);
    expect((await stateAt(folder, folder.clock)).getText('body').toString()).toBe('one');
    expect((await stateAt(folder, second)).getText('body').toString()).toBe('one two');
  });

  it('says so when a file of a version cannot be read here yet', async () => {
    const tree = { readFile: async () => null };
    await expect(versionUpdate(tree, [save('a', 1)], 1)).rejects.toThrow(/not on this device/);
  });
});

describe('restoreVersion', () => {
  function edited(change: (doc: Y.Doc) => void, from?: Y.Doc): Y.Doc {
    const doc = new Y.Doc();
    if (from) Y.applyUpdate(doc, Y.encodeStateAsUpdate(from));
    change(doc);
    return doc;
  }

  it('brings back text, values and nested content as one undoable edit', () => {
    const live = new Y.Doc();
    live.getText('notes').insert(0, 'Hello world');
    const slide = new Y.Map<unknown>();
    live.getMap('slides').set('s1', slide);
    slide.set('title', 'First');
    const words = new Y.Text('kept words');
    slide.set('words', words);
    live.getArray<string>('order').insert(0, ['a', 'b']);
    const version = Y.encodeStateAsUpdate(live);

    live.getText('notes').delete(5, 6);
    live.getText('notes').insert(5, ', there');
    live.getText('notes').format(0, 5, { bold: true });
    slide.set('title', 'Second');
    words.delete(0, 5);
    live.getMap('slides').set('s2', new Y.Map());
    live.getArray<string>('order').delete(0, 1);
    live.getArray<string>('order').push(['c']);

    const undo = new Y.UndoManager(live, { trackedOrigins: new Set(['mine']) });
    expect(restoreVersion(live, version, 'mine')).toBe(true);
    expect(live.getText('notes').toDelta()).toEqual([{ insert: 'Hello world' }]);
    expect(live.getMap('slides').toJSON()).toEqual({ s1: { title: 'First', words: 'kept words' } });
    expect(live.getArray('order').toArray()).toEqual(['a', 'b']);

    expect(undo.undoStack).toHaveLength(1);
    undo.undo();
    expect(live.getText('notes').toString()).toBe('Hello, there');
    expect(live.getMap('slides').toJSON()).toEqual({ s1: { title: 'Second', words: 'words' }, s2: {} });
    expect(live.getArray('order').toArray()).toEqual(['b', 'c']);
  });

  it('changes only the parts it is given', () => {
    const live = new Y.Doc();
    live.getXmlFragment('default').insert(0, [new Y.XmlText('Draft')]);
    live.getMap('comments').set('c1', 'first comment');
    const version = Y.encodeStateAsUpdate(live);
    (live.getXmlFragment('default').get(0) as Y.XmlText).insert(5, ' two');
    live.getMap('comments').set('c2', 'second comment');

    restoreVersion(live, version, 'mine', doc => [doc.getXmlFragment('default')]);
    expect(live.getXmlFragment('default').toString()).toBe('Draft');
    expect(live.getMap('comments').toJSON()).toEqual({ c1: 'first comment', c2: 'second comment' });
    expect(restoreVersion(live, version, 'mine', doc => [doc.getXmlFragment('default')])).toBe(false);
  });

  it('merges with an edit another device made at the same time', () => {
    const live = edited(doc => doc.getText('body').insert(0, 'one'));
    const version = Y.encodeStateAsUpdate(live);
    live.getText('body').insert(3, ' two');
    const other = edited(doc => doc.getMap('meta').set('theme', 'dark'), live);

    restoreVersion(live, version, 'mine');
    Y.applyUpdate(other, Y.encodeStateAsUpdate(live));
    Y.applyUpdate(live, Y.encodeStateAsUpdate(other));
    expect(live.getText('body').toString()).toBe('one');
    expect(live.getMap('meta').get('theme')).toBe('dark');
    expect(other.getText('body').toString()).toBe('one');
    expect(Y.encodeStateVector(other)).toEqual(Y.encodeStateVector(live));
  });
});
