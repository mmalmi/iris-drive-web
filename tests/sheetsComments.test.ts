import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { SheetController } from '../src/lib/sheets/controller.svelte';
import { addComment, deleteComment, isOwn, liveThreads, openThreadCells, reopenThread, resolveThread, threadsAt } from '../src/lib/sheets/comments';

const ada = { pubkey: 'a'.repeat(64), profile: 'ada-profile', name: 'Ada' };
const bob = { pubkey: 'b'.repeat(64), name: 'Bob' };

function open(doc = new Y.Doc()) {
  const ctl = new SheetController(doc);
  ctl.start(true);
  const cell = (row: number, col: number) => `${ctl.sheet.rows.ids[row]}:${ctl.sheet.cols.ids[col]}`;
  return { ctl, doc, cell };
}

function sync(a: Y.Doc, b: Y.Doc): void {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)), 'stored');
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)), 'stored');
}

describe('comments on cells', () => {
  it('make threads with answers in order, and follow their cell when rows are added', () => {
    const { ctl, cell } = open();
    const sheet = ctl.sheet;
    const thread = addComment(sheet, cell(2, 1), ada, 'Is this the final price?', undefined, 1000) as string;
    addComment(sheet, cell(2, 1), bob, 'Yes, with tax.', thread, 2000);
    expect(addComment(sheet, cell(2, 1), bob, '   ')).toBeNull();
    sheet.insert('row', 0, 1);
    const [found] = threadsAt(sheet, 3, 1);
    expect(found.messages.map(message => [message.author.name, message.text])).toEqual([['Ada', 'Is this the final price?'], ['Bob', 'Yes, with tax.']]);
    expect(openThreadCells(sheet).size).toBe(1);
  });

  it('two people answering and resolving at the same moment keep every answer', () => {
    const one = open();
    const two = open(new Y.Doc());
    const thread = addComment(one.ctl.sheet, one.cell(0, 0), ada, 'Check this') as string;
    sync(one.doc, two.doc);
    addComment(one.ctl.sheet, one.cell(0, 0), ada, 'Also the total', thread);
    addComment(two.ctl.sheet, two.cell(0, 0), bob, 'Done', thread);
    resolveThread(two.ctl.sheet, thread, bob);
    sync(one.doc, two.doc);
    for (const side of [one, two]) {
      const [found] = liveThreads(side.ctl.sheet);
      expect(found.messages.map(message => message.text).sort()).toEqual(['Also the total', 'Check this', 'Done']);
      expect(found.resolved?.by.name).toBe('Bob');
    }
    expect(openThreadCells(one.ctl.sheet).size).toBe(0);
    // Answering a resolved thread opens it again.
    addComment(one.ctl.sheet, one.cell(0, 0), ada, 'One more thing', thread);
    expect(liveThreads(one.ctl.sheet)[0].resolved).toBeNull();
    resolveThread(one.ctl.sheet, thread, ada);
    reopenThread(one.ctl.sheet, thread);
    expect(openThreadCells(one.ctl.sheet).size).toBe(1);
  });

  it('deleting the first message deletes the thread, and undo brings it back', () => {
    const { ctl, cell } = open();
    const thread = addComment(ctl.sheet, cell(1, 1), ada, 'First') as string;
    addComment(ctl.sheet, cell(1, 1), ada, 'Second', thread);
    deleteComment(ctl.sheet, thread);
    expect(liveThreads(ctl.sheet)).toEqual([]);
    ctl.undo();
    expect(liveThreads(ctl.sheet)[0].messages).toHaveLength(2);
  });

  it('a deleted row hides its comments, and a person is known by device or identity', () => {
    const { ctl, cell } = open();
    addComment(ctl.sheet, cell(4, 0), ada, 'Here');
    ctl.sheet.remove('row', 4, 1);
    expect(liveThreads(ctl.sheet)).toEqual([]);
    expect(isOwn(ada, { pubkey: 'c'.repeat(64), profile: 'ada-profile' })).toBe(true);
    expect(isOwn(bob, ada)).toBe(false);
    expect(isOwn(bob, null)).toBe(false);
  });
});
