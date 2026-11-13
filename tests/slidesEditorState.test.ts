import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { SlidesEditorState } from '../src/lib/slides/editorState.svelte';
import { Deck, richTextToPlain } from '../src/lib/slides/model';

/** Each editor is a browser of its own unless told otherwise. */
function open(ydoc = new Y.Doc(), canEdit = true, deviceId = `device-${Math.random()}`): SlidesEditorState {
  const state = new SlidesEditorState(ydoc, { addAttachment: async () => 'image.png', canEdit: () => canEdit, deviceId });
  state.startDeck();
  return state;
}

function sync(from: Y.Doc, to: Y.Doc): void {
  Y.applyUpdate(to, Y.encodeStateAsUpdate(from), 'stored');
}

describe('the editor\'s view of a deck', () => {
  test('a new deck gets a title slide that undo cannot take away', () => {
    const state = open();
    expect(state.slides).toHaveLength(1);
    expect(state.slides[0]!.layout).toBe('title');
    expect(state.current).toBe(state.slides[0]);
    expect(state.canUndo).toBe(false);
    state.undo();
    expect(state.slides).toHaveLength(1);
  });

  describe('two devices opening a new deck at the same moment', () => {
    function both(): { a: SlidesEditorState; b: SlidesEditorState; exchange: () => void } {
      const first = new Y.Doc();
      const second = new Y.Doc();
      const a = open(first);
      const b = open(second);
      expect(a.slides).toHaveLength(1);
      expect(b.slides).toHaveLength(1);
      expect(a.slides[0]!.id).not.toBe(b.slides[0]!.id);
      return {
        a,
        b,
        exchange: () => {
          sync(first, second);
          sync(second, first);
          sync(first, second);
          sync(second, first);
        },
      };
    }
    const titleOf = (state: SlidesEditorState) => state.slides.map(slide => richTextToPlain(slide.elements[0]?.content));

    function typeTitle(state: SlidesEditorState, text: string): void {
      const title = state.slides.find(slide => slide.seed)!.elements[0]!;
      state.deck.transact(() => {
        const paragraph = new Y.XmlElement('paragraph');
        title.content!.insert(0, [paragraph]);
        paragraph.insert(0, [new Y.XmlText(text)]);
      });
    }

    test('each gives it a title slide, and one of the two is kept', () => {
      const { a, b, exchange } = both();
      exchange();
      expect(a.slides).toHaveLength(1);
      expect(b.slides).toHaveLength(1);
      expect(a.slides[0]!.id).toBe(b.slides[0]!.id);
      // Nothing of this is on the undo stack.
      expect(a.canUndo).toBe(false);
      expect(b.canUndo).toBe(false);
    });

    test('the one that was written on is the one kept, whichever it is', () => {
      for (const writer of ['a', 'b'] as const) {
        const pair = both();
        typeTitle(pair[writer], 'Already typing');
        pair.exchange();
        expect(titleOf(pair.a)).toEqual(['Already typing']);
        expect(titleOf(pair.b)).toEqual(['Already typing']);
      }
    });

    test('when both were written on, both are kept: nothing typed is thrown away', () => {
      const { a, b, exchange } = both();
      typeTitle(a, 'From a');
      typeTitle(b, 'From b');
      exchange();
      expect([...titleOf(a)].sort()).toEqual(['From a', 'From b']);
      expect(titleOf(a)).toEqual(titleOf(b));
    });

    test('typing that had not arrived yet is safe: a device only takes away its own untouched slide', () => {
      const first = new Y.Doc();
      const second = new Y.Doc();
      const a = open(first);
      const b = open(second);
      // b's empty slide reaches a; then b types, and only then do they meet again.
      sync(second, first);
      typeTitle(b, 'Typed meanwhile');
      sync(first, second);
      sync(second, first);
      sync(first, second);
      expect(titleOf(a)).toEqual(['Typed meanwhile']);
      expect(titleOf(b)).toEqual(['Typed meanwhile']);
    });

    test('one that reloads before they meet still ends up with one first slide', () => {
      // Slide ids are random, so which of the two is kept differs from run to run; try both often enough.
      for (let run = 0; run < 12; run += 1) {
        for (const reloader of ['a', 'b'] as const) {
          const docs = { a: new Y.Doc(), b: new Y.Doc() };
          const states = { a: open(docs.a, true, 'device-a'), b: open(docs.b, true, 'device-b') };
          // The reloading device's deck comes back from what it had stored, in a new document.
          const stored = Y.encodeStateAsUpdate(docs[reloader]);
          states[reloader].destroy();
          docs[reloader] = new Y.Doc();
          Y.applyUpdate(docs[reloader], stored, 'stored');
          states[reloader] = open(docs[reloader], true, `device-${reloader}`);
          expect(states[reloader].slides).toHaveLength(1);
          sync(docs.a, docs.b);
          sync(docs.b, docs.a);
          sync(docs.a, docs.b);
          sync(docs.b, docs.a);
          expect(states.a.slides).toHaveLength(1);
          expect(states.b.slides).toHaveLength(1);
          expect(states.a.slides[0]!.id).toBe(states.b.slides[0]!.id);
          expect(states.a.canUndo || states.b.canUndo).toBe(false);
        }
      }
    });

    test('after a reload, what the other device typed meanwhile is still never taken away', () => {
      for (let run = 0; run < 12; run += 1) {
        const first = new Y.Doc();
        const second = new Y.Doc();
        open(first, true, 'device-a').destroy();
        const b = open(second, true, 'device-b');
        // a reloads; b's empty slide reaches it; b types before hearing back.
        const again = new Y.Doc();
        Y.applyUpdate(again, Y.encodeStateAsUpdate(first), 'stored');
        const a = open(again, true, 'device-a');
        sync(second, again);
        typeTitle(b, 'Typed meanwhile');
        sync(again, second);
        sync(second, again);
        sync(again, second);
        expect(titleOf(a)).toEqual(['Typed meanwhile']);
        expect(titleOf(b)).toEqual(['Typed meanwhile']);
      }
    });

    test('a first slide from before browsers were told apart is left alone', () => {
      const first = new Y.Doc();
      const old = new Deck(first);
      old.start('light');
      first.transact(() => {
        const id = old.addSlide('title', []);
        old.slides.get(id)!.set('seed', true);
      });
      const second = new Y.Doc();
      const b = open(second, true, 'device-b');
      sync(first, second);
      sync(second, first);
      // b's own slide may go if the old one sorts first; the old one always stays.
      expect(b.slides.length).toBeGreaterThanOrEqual(1);
      expect(b.slides.some(slide => !slide.seedBy)).toBe(true);
    });

    test('a slide added by hand is never taken for a first slide', () => {
      const { a, b, exchange } = both();
      a.addSlide('title');
      exchange();
      expect(a.slides).toHaveLength(2);
      expect(b.slides).toHaveLength(2);
    });
  });

  test('someone who may only view changes nothing, not even an empty deck', () => {
    const ydoc = new Y.Doc();
    let updates = 0;
    ydoc.on('update', () => { updates += 1; });
    const state = open(ydoc, false);
    state.addSlide();
    state.addText();
    state.setTheme('dark');
    state.deleteSlides();
    expect(state.slides).toHaveLength(0);
    expect(updates).toBe(0);
  });

  test('a deck from a newer version of the format is not edited', () => {
    const ydoc = new Y.Doc();
    open(ydoc).deck.meta.set('version', 99);
    const state = open(ydoc);
    expect(state.canEdit).toBe(false);
    state.addSlide();
    expect(state.slides).toHaveLength(1);
  });

  test('a new slide follows the current one and becomes current; after a title slide comes a content slide', () => {
    const state = open();
    state.addSlide();
    expect(state.slides.map(slide => slide.layout)).toEqual(['title', 'content']);
    expect(state.currentIndex).toBe(1);
    state.addSlide('columns');
    state.addSlide();
    expect(state.slides.map(slide => slide.layout)).toEqual(['title', 'content', 'columns', 'columns']);
    state.goTo(state.slides[0]!.id);
    state.addSlide('blank');
    expect(state.slides.map(slide => slide.layout)).toEqual(['title', 'blank', 'content', 'columns', 'columns']);
  });

  test('only what changed is read again', () => {
    const state = open();
    state.addSlide();
    state.addShape('rect');
    state.addShape('ellipse');
    const [first, second] = state.slides;
    const [title, body, rect, ellipse] = second!.elements;
    state.updateElements({ [rect!.id]: { x: 10 } });
    expect(state.slides[0]).toBe(first);
    expect(state.slides[1]).not.toBe(second);
    expect(state.slides[1]!.elements[0]).toBe(title);
    expect(state.slides[1]!.elements[1]).toBe(body);
    expect(state.slides[1]!.elements[2]).not.toBe(rect);
    expect(state.slides[1]!.elements[3]).toBe(ellipse);
  });

  test('each action is one step of undo, and a run of nudges is one step too', () => {
    const state = open();
    state.addSlide('blank');
    state.addShape('rect');
    const id = state.selection[0]!;
    const x = state.selected[0]!.x;
    state.nudge(1, 0);
    state.nudge(1, 0);
    state.nudge(0, 10);
    expect(state.selected[0]).toMatchObject({ x: x + 2 });
    state.updateSelected({ fill: '#ff0000' });
    state.undo();
    expect(state.current!.elements[0]!.fill).toBeUndefined();
    expect(state.current!.elements[0]!.x).toBe(x + 2);
    state.undo();
    expect(state.current!.elements[0]).toMatchObject({ id, x });
    state.undo();
    expect(state.current!.elements).toHaveLength(0);
    state.undo();
    expect(state.slides).toHaveLength(1);
    state.redo();
    state.redo();
    expect(state.current!.elements).toHaveLength(1);
    expect(state.canRedo).toBe(true);
  });

  test('undo shows the slide the change was on', () => {
    const state = open();
    state.addSlide('blank');
    const second = state.currentId!;
    state.addShape('rect');
    state.goTo(state.slides[0]!.id);
    expect(state.currentIndex).toBe(0);
    state.undo();
    expect(state.currentId).toBe(second);
    expect(state.current!.elements).toHaveLength(0);
  });

  test('what another device removes drops out of the selection, and the place in the deck is kept', () => {
    const ydoc = new Y.Doc();
    const state = open(ydoc);
    state.addSlide('blank');
    state.addShape('rect');
    state.addShape('ellipse');
    state.selectAll();
    expect(state.selection).toHaveLength(2);
    state.addSlide('blank');
    state.goTo(state.slides[1]!.id);
    state.selectAll();

    const otherDoc = new Y.Doc();
    sync(ydoc, otherDoc);
    const other = new Deck(otherDoc);
    const slide = other.readSlides()[1]!;
    other.deleteElements(slide.id, [slide.elements[0]!.id]);
    sync(otherDoc, ydoc);
    expect(state.selection).toEqual([slide.elements[1]!.id]);
    // Edits from elsewhere are not this user's to undo.
    state.undo();
    expect(state.current!.elements).toHaveLength(1);
    state.redo();

    other.deleteSlides([slide.id]);
    sync(otherDoc, ydoc);
    expect(state.slides).toHaveLength(2);
    expect(state.currentIndex).toBe(1);
    expect(state.selection).toEqual([]);
  });

  test('picked slides move, copy and go together', () => {
    const state = open();
    for (let index = 0; index < 3; index += 1) state.addSlide('blank');
    const ids = state.slides.map(slide => slide.id);
    state.pickSlide(ids[1]!, 'only');
    state.pickSlide(ids[2]!, 'range');
    expect(state.pickedSlides).toEqual([ids[1], ids[2]]);
    state.shiftSlides(1);
    expect(state.slides.map(slide => slide.id)).toEqual([ids[0], ids[3], ids[1], ids[2]]);
    state.shiftSlides(1);
    expect(state.slides.map(slide => slide.id)).toEqual([ids[0], ids[3], ids[1], ids[2]]);
    state.shiftSlides(-1);
    state.shiftSlides(-1);
    expect(state.slides.map(slide => slide.id)).toEqual([ids[1], ids[2], ids[0], ids[3]]);
    state.duplicateSlides();
    expect(state.slides).toHaveLength(6);
    expect(state.pickedSlides).toHaveLength(2);
    state.deleteSlides();
    expect(state.slides.map(slide => slide.id)).toEqual([ids[1], ids[2], ids[0], ids[3]]);
    state.pickSlide(ids[3]!, 'only');
    state.pickSlide(ids[0]!, 'toggle');
    expect(state.pickedSlides).toEqual([ids[3], ids[0]]);
    state.pickSlide(ids[0]!, 'toggle');
    expect(state.pickedSlides).toEqual([ids[3]]);
    expect(state.currentId).toBe(ids[3]);
  });

  test('copies pasted again and again step aside; copied slides land after the current one', () => {
    const state = open();
    state.addSlide('blank');
    state.addShape('rect');
    const x = state.selected[0]!.x;
    const copied = state.copyPayload()!;
    expect(copied.payload.elements).toHaveLength(1);
    state.paste(JSON.parse(JSON.stringify(copied.payload)));
    state.paste(JSON.parse(JSON.stringify(copied.payload)));
    expect(state.current!.elements.map(element => element.x)).toEqual([x, x + 24, x + 48]);
    expect(state.selection).toEqual([state.current!.elements[2]!.id]);

    state.pasteText('Line one\r\nLine two');
    expect(richTextToPlain(state.selected[0]!.content)).toBe('Line one\nLine two');

    state.area = 'strip';
    state.setNotes('remember this');
    const slides = state.copyPayload()!;
    expect(slides.payload.slides).toHaveLength(1);
    state.goTo(state.slides[0]!.id);
    state.paste(JSON.parse(JSON.stringify(slides.payload)));
    expect(state.slides).toHaveLength(3);
    expect(state.currentIndex).toBe(1);
    expect(state.current!.elements).toHaveLength(4);
    expect(state.current!.notes?.toString()).toBe('remember this');
  });

  test('colour and size given to a box replace what its words had', () => {
    const state = open();
    state.addSlide('blank');
    state.pasteText('Some words');
    const id = state.selection[0]!;
    state.deck.formatAllText(state.currentId!, id, 'fontSize', { size: 60 });
    state.deck.formatAllText(state.currentId!, id, 'color', { color: '#ff0000' });
    state.setFontSize(500);
    state.setTextColour('accent');
    expect(state.selected[0]).toMatchObject({ fontSize: 240, color: 'accent' });
    expect(state.deck.allTextHasMark(state.currentId!, id, 'fontSize')).toBe(false);
    expect(state.deck.allTextHasMark(state.currentId!, id, 'color')).toBe(false);
    state.setTextColour(null);
    expect(state.selected[0]!.color).toBeUndefined();
    state.toggleMark('bold');
    expect(state.markActive('bold')).toBe(true);
    state.toggleMark('bold');
    expect(state.markActive('bold')).toBe(false);
  });

  test('elements line up with the slide', () => {
    const state = open();
    state.addSlide('blank');
    state.addShape('rect');
    state.alignToSlide('left');
    state.alignToSlide('top');
    expect(state.selected[0]).toMatchObject({ x: 0, y: 0 });
    state.alignToSlide('right');
    state.alignToSlide('bottom');
    expect(state.selected[0]).toMatchObject({ x: 1280 - 280, y: 720 - 170 });
    state.alignToSlide('centre');
    state.alignToSlide('middle');
    expect(state.selected[0]).toMatchObject({ x: 500, y: 275 });
    // A line drawn backwards lines up by where it is, not by where it starts.
    state.addLine(true);
    state.updateSelected({ x: 600, y: 300, w: -200, h: -100 });
    state.alignToSlide('left');
    state.alignToSlide('top');
    expect(state.selected[0]).toMatchObject({ x: 200, y: 100 });
  });
});
