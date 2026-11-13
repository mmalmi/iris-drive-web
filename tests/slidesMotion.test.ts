import { afterEach, describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { Deck, type Slide } from '../src/lib/slides/model';
import { buildPlan, buildPoints } from '../src/lib/slides/motion';
import { Presentation } from '../src/lib/slides/presentation.svelte';

function list(fragment: Y.XmlFragment, points: string[]): void {
  const listNode = new Y.XmlElement('bulletList');
  fragment.insert(fragment.length, [listNode]);
  for (const point of points) {
    const item = new Y.XmlElement('listItem');
    const paragraph = new Y.XmlElement('paragraph');
    listNode.insert(listNode.length, [item]);
    item.insert(0, [paragraph]);
    if (point) paragraph.insert(0, [new Y.XmlText(point)]);
  }
}

/** A deck of a title slide and a slide of three points that build. */
function talk(): { deck: Deck; slides: () => Slide[] } {
  const deck = new Deck(new Y.Doc());
  deck.start('light');
  deck.addSlide('title', [{ type: 'text', role: 'title', x: 0, y: 0, w: 100, h: 100, rot: 0, text: 'Hello' }]);
  const second = deck.addSlide('content', [
    { type: 'text', role: 'title', x: 0, y: 0, w: 100, h: 100, rot: 0, text: 'Plan' },
    { type: 'text', role: 'body', x: 0, y: 0, w: 100, h: 100, rot: 0 },
  ]);
  const body = deck.readSlide(second)!.elements[1]!.content!;
  deck.transact(() => list(body, ['Walk', 'Lunch', '', 'Swim']));
  deck.setSlideMotion([second], { transition: 'fade', build: true });
  deck.addSlide('content', [{ type: 'text', role: 'title', x: 0, y: 0, w: 100, h: 100, rot: 0, text: 'Thanks' }]);
  return { deck, slides: () => deck.readSlides() };
}

const open: Presentation[] = [];
afterEach(() => {
  while (open.length) open.pop()!.close();
});

describe('moving while presenting', () => {
  test('points are counted at the top level of a list, leaving out empty ones', () => {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment('text');
    list(fragment, ['One', '', 'Two']);
    const paragraph = new Y.XmlElement('paragraph');
    fragment.insert(fragment.length, [paragraph]);
    paragraph.insert(0, [new Y.XmlText('A closing line')]);
    expect(buildPoints(fragment)).toBe(3);
  });

  test('a slide stores its transition and build, and they travel with a copy', () => {
    const { deck, slides } = talk();
    const second = slides()[1]!;
    expect(second.transition).toBe('fade');
    expect(second.build).toBe(true);
    expect(buildPlan(second).steps).toBe(3);
    // The title of a slide that builds is there from the start.
    expect(buildPlan(second).offsets.has(second.elements[0]!.id)).toBe(false);
    const [copy] = deck.duplicateSlides([second.id]);
    expect(deck.readSlide(copy!)!.transition).toBe('fade');
    deck.setSlideMotion([second.id], { transition: 'none', build: false });
    expect(deck.readSlide(second.id)!.transition).toBeUndefined();
    expect(deck.readSlide(second.id)!.build).toBeUndefined();
  });

  test('moving on brings in one point at a time, then the next slide; back takes them away again', () => {
    const { slides } = talk();
    const run = new Presentation({ slides, startId: null, key: 'motion-a', leads: true });
    open.push(run);
    run.next();
    expect([run.index, run.step, run.steps]).toEqual([1, 0, 3]);
    run.next();
    run.next();
    run.next();
    expect([run.index, run.step]).toEqual([1, 3]);
    run.next();
    expect([run.index, run.step]).toEqual([2, 0]);
    // Back onto a slide that builds shows it complete.
    run.previous();
    expect([run.index, run.step]).toEqual([1, 3]);
    run.previous();
    expect([run.index, run.step]).toEqual([1, 2]);
    expect(run.direction).toBe(-1);
  });

  test('the presenter\'s window follows each point, not just each slide', async () => {
    const { slides } = talk();
    const audience = new Presentation({ slides, startId: null, key: 'motion-b', leads: true });
    const presenter = new Presentation({ slides, startId: null, key: 'motion-b', leads: false });
    open.push(audience, presenter);
    audience.next();
    audience.next();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect([presenter.index, presenter.step]).toEqual([1, 1]);
    presenter.next();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect([audience.index, audience.step]).toEqual([1, 2]);
  });
});
