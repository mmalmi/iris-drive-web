// @vitest-environment happy-dom
import { afterEach, expect, test } from 'vitest';
import * as Y from 'yjs';
import { createTextEditor, cssColour, renderRichText, validFontSize } from '../src/lib/slides/richText';
import { Deck, richTextToJson, richTextToPlain } from '../src/lib/slides/model';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function textBox(): { deck: Deck; slide: string; id: string; fragment: Y.XmlFragment } {
  const deck = new Deck(new Y.Doc());
  const slide = deck.addSlide('blank', []);
  const id = deck.addElement(slide, { type: 'text', x: 0, y: 0, w: 400, h: 100, rot: 0 })!;
  cleanups.push(() => deck.ydoc.destroy());
  return { deck, slide, id, fragment: deck.readSlide(slide)!.elements[0]!.content! };
}

function edit(fragment: Y.XmlFragment) {
  const element = document.createElement('div');
  document.body.append(element);
  const editor = createTextEditor({ element, fragment });
  cleanups.push(() => {
    editor.destroy();
    element.remove();
  });
  return editor;
}

/** What a piece of rendered text looks like, without the attributes only an editor needs. */
function shape(node: Node): unknown {
  if (node.nodeType === 3) return node.textContent;
  const element = node as HTMLElement;
  const style = element.getAttribute('style')?.replace(/\s+/g, '').replace(/;$/, '');
  const children = [...element.childNodes].map(shape);
  return style ? [element.tagName, style, ...children] : [element.tagName, ...children];
}

function drawn(fragment: Y.XmlFragment): unknown[] {
  const container = document.createElement('div');
  renderRichText(fragment, container);
  return [...container.childNodes].map(shape);
}

test('text is drawn the same while it is being edited and when it is not', () => {
  const { fragment } = textBox();
  const editor = edit(fragment);
  editor.commands.setContent([
    '<p>Plain <strong>bold</strong> <em>italic</em> <u>under</u> <s>struck</s></p>',
    '<p><span data-colour="#e03131">red</span> and <span data-size="40">big</span> and <span data-colour="accent"><span data-size="12"><strong><u>all of it</u></strong></span></span></p>',
    '<p></p>',
    '<ul><li><p>one</p></li><li><p>two</p><ul><li><p>nested</p></li></ul></li></ul>',
    '<ol start="3"><li><p>third</p></li></ol>',
    '<p>line<br>break</p>',
    '<p data-align="center">in the middle</p><p data-align="right">at the right</p>',
  ].join(''));
  const edited = [...editor.view.dom.childNodes].map(shape);
  expect(drawn(fragment)).toEqual(edited);
  // And the pieces are what they should be.
  const container = document.createElement('div');
  renderRichText(fragment, container);
  expect(container.querySelector('strong')?.textContent).toBe('bold');
  expect((container.querySelector('span') as HTMLElement).getAttribute('style')).toBe('color: #e03131');
  expect(container.querySelectorAll('ul ul li')).toHaveLength(1);
  expect(container.querySelector('ol')?.getAttribute('start')).toBe('3');
  expect(richTextToPlain(fragment)).toBe('Plain bold italic under struck\nred and big and all of it\n\none\ntwo\nnested\nthird\nline\nbreak\nin the middle\nat the right');
  expect([...container.querySelectorAll('p')].map(p => p.getAttribute('style')).filter(Boolean)).toEqual(['text-align: center', 'text-align: right']);
});

test('what is typed in one copy of a deck is drawn in another', () => {
  const { deck, fragment } = textBox();
  const editor = edit(fragment);
  editor.commands.setContent('<ul><li><p>Shared <strong>point</strong></p></li></ul>');
  const other = new Y.Doc();
  cleanups.push(() => other.destroy());
  Y.applyUpdate(other, Y.encodeStateAsUpdate(deck.ydoc));
  const copy = new Deck(other).readSlides()[0]!.elements[0]!.content!;
  expect(drawn(copy)).toEqual(drawn(fragment));
  expect(drawn(copy)).toEqual([['UL', ['LI', ['P', 'Shared ', ['STRONG', 'point']]]]]);
});

test('formatting a whole box from outside the editor matches what the editor makes', () => {
  const { deck, slide, id, fragment } = textBox();
  const editor = edit(fragment);
  editor.commands.setContent('<p>first</p><p>second</p>');
  editor.destroy();
  deck.formatAllText(slide, id, 'bold', {});
  expect(drawn(fragment)).toEqual([['P', ['STRONG', 'first']], ['P', ['STRONG', 'second']]]);
  // Reopened in an editor, it reads the mark and can take it off again.
  const again = edit(fragment);
  expect(again.getHTML()).toBe('<p><strong>first</strong></p><p><strong>second</strong></p>');
  again.chain().selectAll().unsetMark('bold').run();
  expect(drawn(fragment)).toEqual([['P', 'first'], ['P', 'second']]);
});

test('only known elements and checked styles are drawn, whatever the document holds', () => {
  const { deck, fragment } = textBox();
  deck.transact(() => {
    const script = new Y.XmlElement('script');
    const inside = new Y.XmlText();
    inside.insert(0, 'alert(1)');
    script.insert(0, [inside]);
    script.setAttribute('onload', 'alert(2)');
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, '<img src=x onerror=alert(3)>', {
      color: { color: 'red; background: url(https://example.com/x)' },
      fontSize: { size: '9999px; position: fixed' },
      link: { href: 'javascript:alert(4)' },
    });
    paragraph.insert(0, [text]);
    fragment.insert(0, [script, paragraph]);
  });
  const container = document.createElement('div');
  renderRichText(fragment, container);
  expect(container.querySelector('script, img, a')).toBeNull();
  expect(container.innerHTML).not.toContain('onload');
  expect(container.innerHTML).not.toContain('example.com');
  expect(container.querySelector('p')?.textContent).toBe('<img src=x onerror=alert(3)>');
  // The size is held to what a slide can use; the colour is dropped.
  expect((container.querySelector('p span') as HTMLElement).getAttribute('style')).toBe('font-size: calc(240px * var(--fit, 1))');
});

test('colours and sizes are checked', () => {
  expect(cssColour('#abc')).toBe('#abc');
  expect(cssColour('#A1B2C3')).toBe('#A1B2C3');
  expect(cssColour('accent')).toBe('var(--slide-accent)');
  expect(cssColour('url(x)')).toBeNull();
  expect(cssColour(undefined)).toBeNull();
  expect(validFontSize(24)).toBe(24);
  expect(validFontSize('31.6')).toBe(32);
  expect(validFontSize(1)).toBe(8);
  expect(validFontSize('big')).toBeNull();
});

test('rich text survives the trip through the clipboard', () => {
  const { deck, slide, fragment } = textBox();
  const editor = edit(fragment);
  editor.commands.setContent('<p>A <strong>bold</strong> word</p><ul><li><p><span data-colour="#1c7ed6">blue</span></p></li></ul>');
  const json = JSON.parse(JSON.stringify(richTextToJson(fragment)));
  const [copy] = deck.addElements(slide, [{ type: 'text', x: 0, y: 0, w: 10, h: 10, rot: 0, content: json }]);
  const pasted = deck.readSlide(slide)!.elements.find(element => element.id === copy)!.content!;
  expect(drawn(pasted)).toEqual(drawn(fragment));
});

test('a point left empty at the end of a list is drawn without its bullet', () => {
  const { fragment } = textBox();
  const editor = edit(fragment);
  editor.commands.setContent('<ul><li><p>one</p></li><li><p></p></li></ul>');
  const container = document.createElement('div');
  renderRichText(fragment, container);
  const points = [...container.querySelectorAll('li')];
  expect(points.map(point => point.className)).toEqual(['', 'slide-empty-point']);
});
