// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import * as Y from 'yjs';
import { SlidesEditorState } from '../src/lib/slides/editorState.svelte';
import { clipboardHtml, copyPayload, payloadFromHtml, type ClipboardPayload } from '../src/lib/slides/clipboard';
import { adoptMedia, readForeignHtml } from '../src/lib/slides/clipboardMedia';

const PNG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function editor(stored: string[] = []): { state: SlidesEditorState; added: File[] } {
  const added: File[] = [];
  const state = new SlidesEditorState(new Y.Doc(), {
    addAttachment: async (file) => {
      added.push(file);
      const name = `new-${added.length}.png`;
      stored.push(name);
      return name;
    },
    canEdit: () => true,
    deviceId: 'device',
  });
  state.startDeck();
  state.addSlide('blank');
  return { state, added };
}

describe('copying and pasting', () => {
  test('what is copied rides along in the HTML, words and all, and comes back out whole', () => {
    const payload: ClipboardPayload = { kind: 'iris-slides', version: 1, elements: [{ type: 'text', x: 1, y: 2, w: 3, h: 4, rot: 0 }], media: { 'a.png': { url: 'https://example.test/a.png' } } };
    const html = clipboardHtml(payload, 'Grüße <b>bold</b>\nsecond line');
    expect(html).toContain('<p>Grüße &lt;b&gt;bold&lt;/b&gt;</p><p>second line</p>');
    expect(payloadFromHtml(`<meta charset="utf-8">${html}`)).toEqual(payload);
    expect(payloadFromHtml('<p>someone else\'s</p>')).toBeNull();
  });

  test('a copied picture names where it can be had', () => {
    const { state } = editor();
    state.deck.addElement(state.currentId!, { type: 'image', src: 'photo.png', x: 0, y: 0, w: 100, h: 100, rot: 0 });
    state.selectAll();
    const copied = copyPayload(state, new Map([['photo.png', '/htree/nhash1abc/photo.png']]))!;
    expect(copied.payload.media).toEqual({ 'photo.png': { url: new URL('/htree/nhash1abc/photo.png', window.location.href).href } });
    expect(copied.elementIds).toHaveLength(1);
  });

  test('pasted into the same deck, a picture is used as it is; into another, it is stored there anew', async () => {
    const payload: ClipboardPayload = {
      kind: 'iris-slides',
      version: 1,
      elements: [
        { type: 'image', src: 'mine.png', x: 0, y: 0, w: 10, h: 10, rot: 0 },
        { type: 'image', src: 'theirs.png', x: 0, y: 0, w: 10, h: 10, rot: 0 },
        { type: 'image', src: 'lost.png', x: 0, y: 0, w: 10, h: 10, rot: 0 },
        { type: 'shape', x: 0, y: 0, w: 10, h: 10, rot: 0 },
      ],
      media: { 'mine.png': {}, 'theirs.png': { data: PNG_DATA }, 'lost.png': {} },
    };
    const { added } = editor();
    const { payload: own, missing } = await adoptMedia(payload, new Map([['mine.png', 'blob:x']]), async file => `stored-${file.name}`);
    expect(own.elements!.map(element => element.src ?? element.type)).toEqual(['mine.png', 'stored-pasted.png', 'shape']);
    expect(missing).toBe(1);
    expect(own.media).toBeUndefined();
    expect(added).toHaveLength(0);
  });

  test('slides copied with pictures keep them, made this deck\'s own', async () => {
    const payload: ClipboardPayload = {
      kind: 'iris-slides',
      version: 1,
      slides: [{ layout: 'blank', notes: '', elements: [{ type: 'image', src: 'theirs.png', x: 0, y: 0, w: 10, h: 10, rot: 0 }] }],
      media: { 'theirs.png': { data: PNG_DATA } },
    };
    const stored: string[] = [];
    const { state } = editor(stored);
    const { payload: own } = await adoptMedia(payload, new Map(), async () => 'here.png');
    state.paste(own);
    expect(state.current!.elements[0]!.src).toBe('here.png');
  });

  test('words and pictures are found in HTML from another app', () => {
    const found = readForeignHtml(`<html><body><h1>Title</h1><p>First <b>point</b></p><img src="${PNG_DATA}"><ul><li>One</li><li>Two</li></ul><img src="https://example.test/b.jpg"><img src="file:///nope.png"><table><tr><td>a</td><td>b</td></tr></table></body></html>`);
    expect(found.text).toBe('Title\nFirst point\nOne\nTwo\na\tb');
    expect(found.images).toEqual([PNG_DATA, 'https://example.test/b.jpg']);
  });
});
