import fs from 'node:fs';
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { strFromU8, unzipSync } from 'fflate';
import { Deck } from '../src/lib/slides/model';
import { deckToPptx, fontFor, imageKind } from '../src/lib/slides/pptx';
import { newTable, readTable, cellKey } from '../src/lib/slides/table';
import { themeById } from '../src/lib/slides/themes';

const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));

/** A deck with one of everything. */
function sampleDeck(): Deck {
  const deck = new Deck(new Y.Doc());
  deck.start('ocean');
  deck.addSlide('title', [
    { type: 'text', role: 'title', x: 88, y: 190, w: 1104, h: 190, rot: 0, valign: 'bottom', text: 'Harbour & "walk" <2026>' },
    { type: 'text', role: 'subtitle', x: 88, y: 404, w: 1104, h: 90, rot: 0, text: 'Saturday' },
  ]);
  const second = deck.addSlide('content', [
    { type: 'text', role: 'title', x: 88, y: 32, w: 1104, h: 134, rot: 0, text: 'Bring' },
    { type: 'text', role: 'body', x: 88, y: 184, w: 1104, h: 464, rot: 0 },
  ]);
  const body = deck.readSlide(second)!.elements[1]!.content!;
  deck.transact(() => {
    const list = new Y.XmlElement('bulletList');
    body.insert(0, [list]);
    for (const [index, word] of ['Boots', 'Water'].entries()) {
      const item = new Y.XmlElement('listItem');
      const paragraph = new Y.XmlElement('paragraph');
      list.insert(index, [item]);
      item.insert(0, [paragraph]);
      const text = new Y.XmlText();
      paragraph.insert(0, [text]);
      text.insert(0, word, index === 0 ? { bold: {}, color: { color: '#e03131' } } : {});
    }
  });
  deck.setNotes(second, 'Mention the forecast.\nAnd the ferry.');
  deck.setSlideMotion([second], { transition: 'slide', build: true });
  deck.addElements(second, [
    { type: 'shape', shape: 'round', x: 900, y: 500, w: 280, h: 170, rot: 15, text: 'Meet here' },
    { type: 'line', x: 800, y: 600, w: -200, h: -80, rot: 0, arrow: true },
    { type: 'image', src: 'pic.png', x: 100, y: 500, w: 200, h: 100, rot: 0 },
    { type: 'table', x: 300, y: 450, w: 400, h: 200, rot: 0, header: true, table: newTable(2, 2) },
  ]);
  const table = deck.readSlide(second)!.elements.find(element => element.type === 'table')!;
  const data = readTable((deck.slides.get(second)!.get('elements') as Y.Map<Y.Map<unknown>>).get(table.id)!)!;
  deck.transact(() => {
    const first = data.cells.get(cellKey(data.rows[0]!.id, data.cols[0]!.id))!.content!;
    const paragraph = new Y.XmlElement('paragraph');
    first.insert(0, [paragraph]);
    paragraph.insert(0, [new Y.XmlText('Time')]);
  });
  deck.setSlideBackground(second, '#fff8e1');
  return deck;
}

describe('a deck as a PowerPoint file', () => {
  test('has every part PowerPoint needs, and what the slides hold', async () => {
    const deck = sampleDeck();
    const bytes = await deckToPptx({
      slides: deck.readSlides(),
      theme: themeById('ocean'),
      title: 'Harbour walk',
      loadImage: async src => (src === 'pic.png' ? { bytes: PNG, ext: 'png', width: 1, height: 1 } : null),
    });
    if (process.env.PPTX_OUT) fs.writeFileSync(process.env.PPTX_OUT, bytes);
    const files = unzipSync(bytes);
    const names = Object.keys(files);
    expect(names[0]).toBe('[Content_Types].xml');
    for (const part of ['_rels/.rels', 'ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels', 'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml', 'ppt/theme/theme1.xml', 'ppt/slides/slide1.xml', 'ppt/slides/slide2.xml',
      'ppt/notesSlides/notesSlide2.xml', 'ppt/notesMasters/notesMaster1.xml', 'ppt/media/image1.png']) {
      expect(names).toContain(part);
    }
    expect(names).not.toContain('ppt/notesSlides/notesSlide1.xml');
    const first = strFromU8(files['ppt/slides/slide1.xml']!);
    // Special characters are escaped; the cover slide keeps its gradient.
    expect(first).toContain('Harbour &amp; &quot;walk&quot; &lt;2026&gt;');
    expect(first).toContain('<a:gradFill');
    const second = strFromU8(files['ppt/slides/slide2.xml']!);
    expect(second).toContain('<a:buChar char="•"/>');
    expect(second).toContain('b="1"');
    expect(second).toContain('<a:srgbClr val="E03131"/>');
    expect(second).toContain('prst="roundRect"');
    expect(second).toContain('rot="900000"');
    expect(second).toContain('flipH="1" flipV="1"');
    expect(second).toContain('<a:tailEnd type="triangle"');
    expect(second).toContain('<a:tbl>');
    expect(second).toContain('<a:t>Time</a:t>');
    expect(second).toContain('<p:push dir="l"/>');
    expect(second).toContain('<a:srgbClr val="FFF8E1"/>');
    expect(strFromU8(files['ppt/notesSlides/notesSlide2.xml']!)).toContain('And the ferry.');
    expect(strFromU8(files['[Content_Types].xml']!)).toContain('Extension="png"');
    const rels = strFromU8(files['ppt/slides/_rels/slide2.xml.rels']!);
    expect(rels).toContain('../media/image1.png');
    expect(rels).toContain('../notesSlides/notesSlide2.xml');
  });

  test('picks fonts PowerPoint has and knows pictures by their bytes', () => {
    expect(fontFor('system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif')).toBe('Arial');
    expect(fontFor('"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif')).toBe('Georgia');
    expect(imageKind(PNG)).toBe('png');
    expect(imageKind(new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="x">'))).toBe('svg');
  });
});
