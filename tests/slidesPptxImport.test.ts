// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { strToU8, zipSync } from 'fflate';
import { inheritedPptx } from '../e2e/slides.pptxSample';
import { Deck, richTextToJson, richTextToPlain, type SlideElement } from '../src/lib/slides/model';
import { deckToPptx } from '../src/lib/slides/pptx';
import { importPptx } from '../src/lib/slides/pptxImport';
import { cellKey, newTable, readTable } from '../src/lib/slides/table';
import { mergeCells, setCellBorders } from '../src/lib/slides/tableCells';
import { themeById } from '../src/lib/slides/themes';
import { SlidesEditorState } from '../src/lib/slides/editorState.svelte';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

function target(): { ydoc: Y.Doc; stored: File[]; addAttachment: (file: File) => Promise<string> } {
  const stored: File[] = [];
  return { ydoc: new Y.Doc(), stored, addAttachment: async (file) => {
    stored.push(file);
    return `stored-${stored.length}.${file.name.split('.').pop()}`;
  } };
}

function paragraph(fragment: Y.XmlFragment, text: string, attributes: Record<string, unknown> = {}): void {
  const node = new Y.XmlElement('paragraph');
  fragment.insert(fragment.length, [node]);
  const run = new Y.XmlText();
  node.insert(0, [run]);
  run.insert(0, text, attributes);
}

const near = (value: number | undefined, expected: number) => expect(Math.abs((value ?? NaN) - expected)).toBeLessThanOrEqual(1);

describe('PowerPoint files brought in', () => {
  test('a deck written by our own exporter comes back with its text, shapes, lines, pictures, tables, notes and backgrounds', async () => {
    const deck = new Deck(new Y.Doc());
    deck.start('light');
    const id = deck.addSlide('content', [
      { type: 'text', role: 'title', x: 88, y: 32, w: 1104, h: 134, rot: 0, text: 'Harbour walk' },
      { type: 'text', role: 'body', x: 88, y: 184, w: 700, h: 300, rot: 0 },
    ], null, '#fff8e1');
    const body = deck.readSlide(id)!.elements[1]!.content!;
    deck.transact(() => {
      const list = new Y.XmlElement('bulletList');
      body.insert(0, [list]);
      for (const [index, word] of ['Boots', 'Water'].entries()) {
        const item = new Y.XmlElement('listItem');
        list.insert(index, [item]);
        const node = new Y.XmlElement('paragraph');
        item.insert(0, [node]);
        const run = new Y.XmlText();
        node.insert(0, [run]);
        run.insert(0, word, index === 0 ? { bold: {}, color: { color: '#e03131' } } : {});
      }
    });
    deck.addElements(id, [
      { type: 'shape', shape: 'ellipse', x: 900, y: 420, w: 280, h: 200, rot: 15, fill: '#2f9e44', stroke: '#17181c', strokeWidth: 4, text: 'Meet' },
      { type: 'line', x: 800, y: 600, w: -200, h: -80, rot: 0, arrow: true, stroke: '#e03131', strokeWidth: 4 },
      { type: 'image', src: 'pic.png', x: 100, y: 500, w: 200, h: 100, rot: 0, alt: 'A map', crop: [0.1, 0, 0.1, 0.2] },
      { type: 'table', x: 300, y: 450, w: 400, h: 200, rot: 0, table: newTable(2, 3) },
    ]);
    const tableId = deck.readSlide(id)!.elements.find(element => element.type === 'table')!.id;
    const tableMap = (deck.slides.get(id)!.get('elements') as Y.Map<Y.Map<unknown>>).get(tableId)!;
    deck.transact(() => {
      const table = readTable(tableMap)!;
      paragraph(table.cells.get(cellKey(table.rows[0]!.id, table.cols[0]!.id))!.content!, 'Plan');
      mergeCells(tableMap, { r0: 0, r1: 0, c0: 0, c1: 2 });
      setCellBorders(tableMap, { r0: 1, r1: 1, c0: 0, c1: 0 }, 'bottom', { width: 4, colour: '#e03131' });
    });
    deck.setNotes(id, 'Mention the ferry.\nAnd lunch.');
    deck.setSlideMotion([id], { transition: 'fade' });
    const bytes = await deckToPptx({
      slides: deck.readSlides(),
      theme: themeById('light'),
      title: 'Walk',
      loadImage: async () => ({ bytes: PNG, ext: 'png', width: 1, height: 1 }),
    });

    const into = target();
    const result = await importPptx(bytes, into, { replace: true });
    expect(result.slides).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(into.stored).toHaveLength(1);
    expect(into.stored[0]!.type).toBe('image/png');
    const slide = new Deck(into.ydoc).readSlides()[0]!;
    expect(slide.background).toBe('#fff8e1');
    expect(slide.transition).toBe('fade');
    expect(slide.notes?.toString()).toBe('Mention the ferry.\nAnd lunch.');
    const byType = (type: SlideElement['type']) => slide.elements.filter(element => element.type === type);
    const [title, list] = byType('text');
    expect(richTextToPlain(title!.content)).toBe('Harbour walk');
    near(title!.x, 88);
    near(title!.w, 1104);
    near(title!.fontSize, 52);
    const listJson = JSON.stringify(richTextToJson(list!.content));
    expect(listJson).toContain('"bulletList"');
    expect(listJson).toContain('"bold":{}');
    // Of two colours as common as each other, one is the box's and the other its words'.
    expect(`${list!.color} ${listJson}`).toContain('#e03131');
    expect(`${list!.color} ${listJson}`).toContain('#17181c');
    expect(richTextToPlain(list!.content)).toBe('Boots\nWater');
    const [shape] = byType('shape');
    expect(shape).toMatchObject({ shape: 'ellipse', fill: '#2f9e44', stroke: '#17181c', rot: 15 });
    expect(richTextToPlain(shape!.content)).toBe('Meet');
    const [line] = byType('line');
    expect(line).toMatchObject({ x: 800, y: 600, w: -200, h: -80, arrow: true, stroke: '#e03131' });
    const [image] = byType('image');
    expect(image).toMatchObject({ src: 'stored-1.png', alt: 'A map', x: 100, y: 500, w: 200, h: 100 });
    expect(image!.crop).toEqual([0.1, 0, 0.1, 0.2]);
    const [table] = byType('table');
    expect(table!.table!.rows).toHaveLength(2);
    expect(table!.table!.cols).toHaveLength(3);
    expect(table!.table!.merges.size).toBe(1);
    const first = table!.table!;
    expect(richTextToPlain(first.cells.get(cellKey(first.rows[0]!.id, first.cols[0]!.id))!.content)).toBe('Plan');
    expect(first.cells.get(cellKey(first.rows[1]!.id, first.cols[0]!.id))!.borders?.b).toEqual({ width: 4, colour: '#e03131' });
    // Imported into an empty deck, it is the whole deck, and undo is not needed to see it.
    expect(new Deck(into.ydoc).readSlides()).toHaveLength(1);
  });

  test('a hand-written file whose slides inherit from their layout and master', async () => {
    const bytes = inheritedPptx();
    const into = target();
    // Into a deck that already has a slide: the new one comes after it.
    const existing = new Deck(into.ydoc);
    existing.start('light');
    existing.addSlide('title', [{ type: 'text', role: 'title', x: 0, y: 0, w: 100, h: 100, rot: 0, text: 'Mine' }]);
    const result = await importPptx(bytes, into);
    expect(result.slides).toBe(1);
    const slides = new Deck(into.ydoc).readSlides();
    expect(slides).toHaveLength(2);
    expect(richTextToPlain(slides[0]!.elements[0]!.content)).toBe('Mine');
    const slide = slides[1]!;
    // The master's background colour, through the colour map.
    expect(slide.background).toBe('#faf6ee');
    const [band, title, body, dot] = slide.elements;
    // A 4:3 slide is 960 × 720 in ours, 160 in from each side.
    const k = 720 / 6858000;
    expect(band).toMatchObject({ type: 'shape', shape: 'rect' });
    near(band!.x, 160);
    near(band!.y, 6400800 * k);
    expect(band!.fill).toMatch(/^#[0-9a-f]{6}$/);
    expect(band!.fill).not.toBe('#b4532a');
    // The title takes its place from the layout, its size, weight and colour from the master, and its alignment from the layout.
    expect(title).toMatchObject({ type: 'text', role: 'title', color: '#b4532a', align: 'left', valign: 'bottom' });
    near(title!.x, 160 + 457200 * k);
    near(title!.y, 457200 * k);
    near(title!.fontSize, 44 * 12700 * k);
    expect(JSON.stringify(richTextToJson(title!.content))).toContain('"bold":{}');
    // The body takes its place from the master and its points from the master's list styles; a paragraph without a bullet stays out of the list.
    expect(body).toMatchObject({ type: 'text', role: 'body' });
    near(body!.y, 1600200 * k);
    const json = JSON.stringify(richTextToJson(body!.content));
    expect(json.match(/bulletList/g)).toHaveLength(2);
    expect(richTextToPlain(body!.content)).toBe('Rooms\nKitchen\nNote');
    expect(json).toContain('"italic":{}');
    // A shape in a group, placed through the group, coloured by its style.
    expect(dot).toMatchObject({ type: 'shape', shape: 'ellipse', fill: '#b4532a', stroke: '#b4532a', color: '#faf6ee', valign: 'middle' });
    near(dot!.x, 160 + 6000000 * k);
    near(dot!.w, 1000000 * k);
    expect(result.theme).toBe('light');
    const replaced = await importPptx(bytes, target(), { replace: true });
    expect(replaced.theme).toBe('paper');
  });

  test('a first slide from an earlier visit that arrives after the file took its place goes away', async () => {
    const earlier = new Y.Doc();
    new SlidesEditorState(earlier, { addAttachment: async () => '', canEdit: () => true, deviceId: 'laptop' }).startDeck();
    const into = target();
    const state = new SlidesEditorState(into.ydoc, { addAttachment: into.addAttachment, canEdit: () => true, deviceId: 'laptop' });
    state.startDeck();
    expect(state.isBlank).toBe(true);
    await importPptx(inheritedPptx(), into, { replace: true });
    expect(state.slides).toHaveLength(1);
    Y.applyUpdate(into.ydoc, Y.encodeStateAsUpdate(earlier), 'stored');
    expect(state.slides).toHaveLength(1);
    expect(richTextToPlain(state.slides[0]!.elements.find(element => element.role === 'title')?.content)).toBe('Old house');
  });

  test('something that is not a presentation is turned away in plain words', async () => {
    await expect(importPptx(new Uint8Array([1, 2, 3]), target())).rejects.toThrow('not a PowerPoint presentation');
    const empty = zipSync({ 'hello.txt': strToU8('hi') });
    await expect(importPptx(empty, target())).rejects.toThrow('not a PowerPoint presentation');
  });
});
