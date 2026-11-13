import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { comparePositions, keyBetween, keysBetween } from '../src/lib/slides/order';
import {
  DECK_VERSION,
  Deck,
  LOCAL_ORIGIN,
  elementToJson,
  richTextToPlain,
  type ElementInit,
} from '../src/lib/slides/model';
import { LAYOUTS, layoutById } from '../src/lib/slides/layouts';

function sync(...docs: Y.Doc[]): void {
  for (const from of docs) {
    for (const to of docs) {
      if (from !== to) Y.applyUpdate(to, Y.encodeStateAsUpdate(from), 'remote');
    }
  }
}

function newDeck(): Deck {
  const deck = new Deck(new Y.Doc());
  deck.start('light');
  return deck;
}

const box = (x: number, extra: Partial<ElementInit> = {}): ElementInit => ({ type: 'shape', shape: 'rect', x, y: 0, w: 100, h: 100, rot: 0, ...extra });

function titles(deck: Deck): string[] {
  return deck.readSlides().map(slide => richTextToPlain(slide.elements[0]?.content));
}

function addTitled(deck: Deck, title: string, afterId: string | null = null): string {
  return deck.addSlide('content', [{ type: 'text', role: 'title', x: 0, y: 0, w: 100, h: 50, rot: 0, text: title }], afterId);
}

describe('position keys', () => {
  test('a key between two keys sorts between them', () => {
    const cases: Array<[string | null, string | null]> = [
      [null, null], ['V', null], [null, 'V'], ['A', 'B'], ['A', 'A1'], ['Az', 'B'], [null, '1'], [null, '01'], ['zz', null], ['A', 'B5'],
    ];
    for (const [before, after] of cases) {
      for (let run = 0; run < 20; run += 1) {
        const key = keyBetween(before, after);
        if (before) expect(key > before).toBe(true);
        if (after) expect(key < after).toBe(true);
        expect(key.endsWith('0')).toBe(false);
      }
    }
  });

  test('inserting at the same place again and again keeps working', () => {
    let low = keyBetween(null, null);
    const high = keyBetween(low, null);
    for (let run = 0; run < 200; run += 1) {
      const next = keyBetween(low, high);
      expect(next > low && next < high).toBe(true);
      low = next;
    }
    let front = high;
    for (let run = 0; run < 200; run += 1) {
      const next = keyBetween(null, front);
      expect(next < front).toBe(true);
      front = next;
    }
    expect(low.length).toBeLessThan(160);
  });

  test('several keys come out ascending, and equal neighbours still give a key', () => {
    const keys = keysBetween('A', 'B', 5);
    expect([...keys].sort()).toEqual(keys);
    expect(keys[0]! > 'A' && keys[4]! < 'B').toBe(true);
    expect(keyBetween('M', 'M') > 'M').toBe(true);
  });

  test('two devices inserting at the same place get different keys', () => {
    const seen = new Set<string>();
    for (let run = 0; run < 200; run += 1) seen.add(keyBetween('A', 'B'));
    expect(seen.size).toBeGreaterThan(150);
  });

  test('equal keys are ordered by id', () => {
    expect([{ pos: 'A', id: 'b' }, { pos: 'A', id: 'a' }].sort(comparePositions).map(item => item.id)).toEqual(['a', 'b']);
  });
});

describe('slides', () => {
  test('a started deck has a version and a theme, and starting again changes nothing', () => {
    const deck = newDeck();
    expect(deck.version).toBe(DECK_VERSION);
    expect(deck.theme).toBe('light');
    deck.setTheme('dark');
    deck.start('light');
    expect(deck.theme).toBe('dark');
    expect(deck.isNewer).toBe(false);
    deck.meta.set('version', DECK_VERSION + 1);
    expect(deck.isNewer).toBe(true);
  });

  test('slides are added at the end or after a given slide', () => {
    const deck = newDeck();
    const a = addTitled(deck, 'A');
    addTitled(deck, 'C');
    addTitled(deck, 'B', a);
    expect(titles(deck)).toEqual(['A', 'B', 'C']);
  });

  test('every layout makes a slide with its boxes', () => {
    const deck = newDeck();
    for (const layout of LAYOUTS) {
      const id = deck.addSlide(layout.id, layout.elements);
      const slide = deck.readSlide(id)!;
      expect(slide.layout).toBe(layout.id);
      expect(slide.elements.map(element => element.role)).toEqual(layout.elements.map(element => element.role));
      for (const element of slide.elements) expect(element.content).toBeInstanceOf(Y.XmlFragment);
    }
    expect(layoutById('nope').id).toBe('blank');
  });

  test('moving slides keeps their order among themselves and loses none', () => {
    const deck = newDeck();
    const ids = ['A', 'B', 'C', 'D', 'E'].map(title => addTitled(deck, title));
    deck.moveSlides([ids[3]!, ids[1]!], ids[0]!);
    expect(titles(deck)).toEqual(['B', 'D', 'A', 'C', 'E']);
    deck.moveSlides([ids[1]!], null);
    expect(titles(deck)).toEqual(['D', 'A', 'C', 'E', 'B']);
    // Dropping a slide before itself or before its neighbour leaves it where it is.
    const before = deck.readSlide(ids[2]!)!.pos;
    deck.moveSlides([ids[2]!], ids[2]!);
    deck.moveSlides([ids[2]!], ids[4]!);
    expect(deck.readSlide(ids[2]!)!.pos).toBe(before);
    expect(titles(deck)).toEqual(['D', 'A', 'C', 'E', 'B']);
  });

  test('a duplicate lands after its original with its own copy of everything', () => {
    const deck = newDeck();
    const a = addTitled(deck, 'A');
    addTitled(deck, 'B');
    deck.setSlideBackground(a, '#112233');
    deck.setNotes(a, 'say hello');
    const [copy] = deck.duplicateSlides([a]);
    expect(titles(deck)).toEqual(['A', 'A', 'B']);
    const copied = deck.readSlide(copy!)!;
    expect(copied.background).toBe('#112233');
    expect(copied.notes?.toString()).toBe('say hello');
    // Editing the copy leaves the original alone.
    const original = deck.readSlide(a)!;
    expect(copied.elements[0]!.id).not.toBe(original.elements[0]!.id);
    deck.updateElements(copy!, { [copied.elements[0]!.id]: { x: 500 } });
    expect(deck.readSlide(a)!.elements[0]!.x).toBe(0);
  });

  test('notes change only where they differ', () => {
    const deck = newDeck();
    const a = addTitled(deck, 'A');
    deck.setNotes(a, 'one two three');
    const other = new Deck(new Y.Doc());
    sync(deck.ydoc, other.ydoc);
    deck.setNotes(a, 'one 2 three');
    other.setNotes(a, 'one two three four');
    sync(deck.ydoc, other.ydoc);
    expect(deck.notes(a)!.toString()).toBe('one 2 three four');
    expect(other.notes(a)!.toString()).toBe('one 2 three four');
  });
});

describe('changing the layout of a slide', () => {
  const layout = (id: string) => layoutById(id);
  const boxes = (deck: Deck, slide: string) => deck.readSlide(slide)!.elements.map(element => `${element.role}:${richTextToPlain(element.content)}`);

  function filled(): { deck: Deck; slide: string } {
    const deck = newDeck();
    const slide = deck.addSlide('content', layout('content').elements);
    const [title, body] = deck.readSlide(slide)!.elements;
    deck.transact(() => {
      const heading = new Y.XmlElement('paragraph');
      title!.content!.insert(0, [heading]);
      heading.insert(0, [new Y.XmlText('Heading')]);
      const points = new Y.XmlElement('paragraph');
      body!.content!.insert(0, [points]);
      points.insert(0, [new Y.XmlText('Points')]);
    });
    return { deck, slide };
  }

  test('text keeps its box when the new layout has one like it, and takes its frame', () => {
    const { deck, slide } = filled();
    const before = deck.readSlide(slide)!.elements.map(element => element.id);
    deck.applyLayout(slide, 'columns', layout('columns').elements);
    const after = deck.readSlide(slide)!;
    expect(after.layout).toBe('columns');
    expect(boxes(deck, slide)).toEqual(['title:Heading', 'body:Points', 'body:']);
    expect(after.elements.slice(0, 2).map(element => element.id)).toEqual(before);
    const wanted = layout('columns').elements;
    expect(after.elements.map(element => [element.x, element.y, element.w, element.h])).toEqual(wanted.map(box => [box.x, box.y, box.w, box.h]));
  });

  test('text with no box like its own takes the box that is left, and becomes that kind', () => {
    const { deck, slide } = filled();
    deck.applyLayout(slide, 'title', layout('title').elements);
    expect(boxes(deck, slide)).toEqual(['title:Heading', 'subtitle:Points']);
    expect(deck.readSlide(slide)!.elements[0]!.valign).toBe('bottom');
    deck.applyLayout(slide, 'content', layout('content').elements);
    expect(boxes(deck, slide)).toEqual(['title:Heading', 'body:Points']);
  });

  test('empty boxes go, boxes with text stay, and nothing else on the slide is touched', () => {
    const { deck, slide } = filled();
    deck.applyLayout(slide, 'columns', layout('columns').elements);
    const shape = deck.addElement(slide, { type: 'shape', shape: 'rect', x: 5, y: 6, w: 7, h: 8, rot: 0 })!;
    deck.applyLayout(slide, 'blank', []);
    // The empty second column is gone; the title and the first column keep their text and place.
    expect(boxes(deck, slide)).toEqual(['title:Heading', 'body:Points', 'undefined:']);
    expect(deck.readSlide(slide)!.elements.find(element => element.id === shape)).toMatchObject({ x: 5, y: 6, w: 7, h: 8 });
    deck.applyLayout(slide, 'section', layout('section').elements);
    expect(boxes(deck, slide).sort()).toEqual(['subtitle:Points', 'title:Heading', 'undefined:']);
  });

  test('a paragraph\'s own alignment can be taken off again', () => {
    const { deck, slide } = filled();
    const title = deck.readSlide(slide)!.elements[0]!;
    const paragraph = title.content!.get(0) as Y.XmlElement;
    deck.transact(() => paragraph.setAttribute('textAlign', 'center'));
    expect(paragraph.getAttribute('textAlign')).toBe('center');
    deck.clearParagraphAttribute(slide, title.id, 'textAlign');
    expect(paragraph.getAttribute('textAlign')).toBeUndefined();
  });
});

describe('elements', () => {
  test('elements stack in the order they were added and can be rearranged', () => {
    const deck = newDeck();
    const slide = deck.addSlide('blank', []);
    const [a, b, c, d] = deck.addElements(slide, [box(1), box(2), box(3), box(4)]);
    const order = () => deck.readSlide(slide)!.elements.map(element => element.x);
    expect(order()).toEqual([1, 2, 3, 4]);
    deck.arrange(slide, [a!], 'front');
    expect(order()).toEqual([2, 3, 4, 1]);
    deck.arrange(slide, [a!], 'back');
    expect(order()).toEqual([1, 2, 3, 4]);
    deck.arrange(slide, [a!], 'forward');
    expect(order()).toEqual([2, 1, 3, 4]);
    deck.arrange(slide, [d!], 'backward');
    expect(order()).toEqual([2, 1, 4, 3]);
    deck.arrange(slide, [b!, c!], 'front');
    expect(order()).toEqual([1, 4, 2, 3]);
    // Already at the top: nothing changes.
    const z = deck.readSlide(slide)!.elements.map(element => element.z);
    deck.arrange(slide, [c!], 'forward');
    expect(deck.readSlide(slide)!.elements.map(element => element.z)).toEqual(z);
  });

  test('properties are written one by one and removed with undefined', () => {
    const deck = newDeck();
    const slide = deck.addSlide('blank', []);
    const id = deck.addElement(slide, box(10, { fill: '#ff0000' }))!;
    deck.updateElements(slide, { [id]: { x: 50, fill: undefined, stroke: 'accent' } });
    const element = deck.readSlide(slide)!.elements[0]!;
    expect(element).toMatchObject({ x: 50, y: 0, stroke: 'accent' });
    expect(element.fill).toBeUndefined();
  });

  test('duplicates and pasted copies get their own ids and text', () => {
    const deck = newDeck();
    const slide = deck.addSlide('blank', []);
    const id = deck.addElement(slide, { type: 'text', x: 0, y: 0, w: 200, h: 50, rot: 0, text: 'first\nsecond' })!;
    const [copy] = deck.duplicateElements(slide, [id]);
    const elements = deck.readSlide(slide)!.elements;
    expect(elements).toHaveLength(2);
    expect(elements[1]!.id).toBe(copy);
    expect(elements[1]!.x).toBe(24);
    expect(richTextToPlain(elements[1]!.content)).toBe('first\nsecond');

    // Through the clipboard, as plain data, into another deck.
    const json = JSON.parse(JSON.stringify(elementToJson(elements[0]!)));
    const other = newDeck();
    const otherSlide = other.addSlide('blank', []);
    other.addElements(otherSlide, [json]);
    expect(richTextToPlain(other.readSlide(otherSlide)!.elements[0]!.content)).toBe('first\nsecond');
  });

  test('formatting all the text of a box', () => {
    const deck = newDeck();
    const slide = deck.addSlide('blank', []);
    const id = deck.addElement(slide, { type: 'text', x: 0, y: 0, w: 200, h: 50, rot: 0, text: 'one\ntwo' })!;
    expect(deck.allTextHasMark(slide, id, 'bold')).toBe(false);
    deck.formatAllText(slide, id, 'bold', {});
    expect(deck.allTextHasMark(slide, id, 'bold')).toBe(true);
    deck.formatAllText(slide, id, 'bold', null);
    expect(deck.allTextHasMark(slide, id, 'bold')).toBe(false);
  });

  test('what cannot be read is skipped or given a default', () => {
    const deck = newDeck();
    const slide = deck.addSlide('blank', []);
    const id = deck.addElement(slide, box(0))!;
    const elements = deck.slides.get(slide)!.get('elements') as Y.Map<Y.Map<unknown>>;
    elements.get(id)!.set('w', 'wide');
    elements.get(id)!.set('shape', 'star');
    elements.get(id)!.set('future', { anything: true });
    const junk = new Y.Map<unknown>();
    elements.set('junk', junk);
    junk.set('type', 'hologram');
    deck.slides.set('broken', 'not a slide' as unknown as Y.Map<unknown>);
    const read = deck.readSlides();
    expect(read).toHaveLength(1);
    expect(read[0]!.elements).toHaveLength(1);
    expect(read[0]!.elements[0]).toMatchObject({ w: 100, shape: 'rect' });
  });
});

describe('two devices', () => {
  function pair(): { a: Deck; b: Deck; ids: string[] } {
    const a = newDeck();
    const ids = ['A', 'B', 'C', 'D'].map(title => addTitled(a, title));
    const b = new Deck(new Y.Doc());
    sync(a.ydoc, b.ydoc);
    return { a, b, ids };
  }

  test('reordering on both at once never duplicates or drops a slide', () => {
    const { a, b, ids } = pair();
    a.moveSlides([ids[0]!], null);
    b.moveSlides([ids[0]!], ids[2]!);
    b.moveSlides([ids[3]!], ids[1]!);
    sync(a.ydoc, b.ydoc);
    expect(titles(a)).toEqual(titles(b));
    expect([...titles(a)].sort()).toEqual(['A', 'B', 'C', 'D']);
  });

  test('slides added at the same place on both are all kept, in the same order on both', () => {
    const { a, b, ids } = pair();
    addTitled(a, 'from a', ids[1]!);
    addTitled(b, 'from b', ids[1]!);
    sync(a.ydoc, b.ydoc);
    expect(titles(a)).toEqual(titles(b));
    expect(titles(a)).toHaveLength(6);
    expect(titles(a).slice(0, 2)).toEqual(['A', 'B']);
    expect(titles(a).slice(4)).toEqual(['C', 'D']);
  });

  test('moving a box while someone restyles it keeps both changes', () => {
    const { a, b, ids } = pair();
    const element = a.readSlide(ids[0]!)!.elements[0]!.id;
    a.updateElements(ids[0]!, { [element]: { x: 300, y: 200 } });
    b.updateElements(ids[0]!, { [element]: { color: '#ff0000', fontSize: 40 } });
    sync(a.ydoc, b.ydoc);
    for (const deck of [a, b]) {
      expect(deck.readSlide(ids[0]!)!.elements[0]).toMatchObject({ x: 300, y: 200, color: '#ff0000', fontSize: 40 });
    }
  });

  test('typing in the same box on both keeps both texts', () => {
    const { a, b, ids } = pair();
    const textOf = (deck: Deck) => (deck.readSlide(ids[0]!)!.elements[0]!.content!.get(0) as Y.XmlElement).get(0) as Y.XmlText;
    a.transact(() => textOf(a).insert(1, ' from a'));
    b.transact(() => textOf(b).insert(0, 'from b '));
    sync(a.ydoc, b.ydoc);
    expect(titles(a)[0]).toBe('from b A from a');
    expect(titles(b)[0]).toBe('from b A from a');
  });

  test('deleting a slide wins over an edit made to it elsewhere, and nothing else is hurt', () => {
    const { a, b, ids } = pair();
    a.deleteSlides([ids[1]!]);
    b.addElement(ids[1]!, box(5));
    b.moveSlides([ids[1]!], null);
    sync(a.ydoc, b.ydoc);
    expect(titles(a)).toEqual(['A', 'C', 'D']);
    expect(titles(b)).toEqual(['A', 'C', 'D']);
  });

  test('elements added to one slide on both are all kept', () => {
    const { a, b, ids } = pair();
    a.addElement(ids[0]!, box(1));
    b.addElement(ids[0]!, box(2));
    sync(a.ydoc, b.ydoc);
    expect(a.readSlide(ids[0]!)!.elements.map(element => element.id)).toEqual(b.readSlide(ids[0]!)!.elements.map(element => element.id));
    expect(a.readSlide(ids[0]!)!.elements).toHaveLength(3);
  });

  test('undo reverts only this device\'s edits, one step at a time', () => {
    const { a, b, ids } = pair();
    const undo = new Y.UndoManager([a.slides, a.meta], { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 });
    const element = a.readSlide(ids[0]!)!.elements[0]!.id;
    a.updateElements(ids[0]!, { [element]: { x: 300, y: 200 } });
    b.updateElements(ids[0]!, { [element]: { fill: '#00ff00' } });
    b.deleteSlides([ids[3]!]);
    sync(a.ydoc, b.ydoc);
    a.deleteSlides([ids[2]!]);
    expect(titles(a)).toEqual(['A', 'B']);
    undo.undo();
    expect(titles(a)).toEqual(['A', 'B', 'C']);
    undo.undo();
    // The move is undone as one step; the other device's changes stay.
    expect(a.readSlide(ids[0]!)!.elements[0]).toMatchObject({ x: 0, y: 0, fill: '#00ff00' });
    expect(titles(a)).toEqual(['A', 'B', 'C']);
    undo.redo();
    expect(a.readSlide(ids[0]!)!.elements[0]).toMatchObject({ x: 300, y: 200 });
  });
});
