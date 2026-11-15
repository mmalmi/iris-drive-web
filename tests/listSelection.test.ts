import { describe, expect, it } from 'vitest';
import { ListSelection } from '../src/lib/listSelection.svelte';

const order = ['Archive', 'a.txt', 'b.txt', 'c.txt', 'd.txt'];
const chosen = (selection: ListSelection) => order.filter((name) => selection.has(name));

describe('what is chosen in a folder list', () => {
  it('extends a range from the anchor, the row last chosen on its own', () => {
    const selection = new ListSelection();
    selection.toggle('a.txt');
    selection.extendTo(order, 'c.txt');
    expect(chosen(selection)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    selection.extendTo(order, 'Archive');
    expect(chosen(selection)).toEqual(['Archive', 'a.txt']);
    selection.only('d.txt');
    selection.extendTo(order, 'b.txt');
    expect(chosen(selection)).toEqual(['b.txt', 'c.txt', 'd.txt']);
  });

  it('starts a range where it is extended from when nothing anchors it', () => {
    const selection = new ListSelection();
    selection.extendTo(order, 'b.txt', 'a.txt');
    expect(chosen(selection)).toEqual(['a.txt', 'b.txt']);
  });

  it('lets a rectangle replace what is chosen, or add to it', () => {
    const selection = new ListSelection();
    selection.toggle('a.txt');
    selection.startBand(false);
    selection.band(['c.txt', 'd.txt']);
    expect(chosen(selection)).toEqual(['c.txt', 'd.txt']);
    selection.band(['d.txt']);
    expect(chosen(selection)).toEqual(['d.txt']);
    selection.only('a.txt');
    selection.startBand(true);
    selection.band(['d.txt']);
    expect(chosen(selection)).toEqual(['a.txt', 'd.txt']);
  });
});
