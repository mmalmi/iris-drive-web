import { describe, expect, it } from 'vitest';
import { htmlIsOnlyPictures, imageFiles, isForeignImageSrc, rewriteCopiedHtml } from '../src/lib/yjs/pastedImages';

describe('pictures copied out of a document', () => {
  it('are named by where they can be fetched, keeping the attachment name', () => {
    const html = '<p>Hi</p><img src="attachments:mwf1-abc123.png" alt="x"><img src="attachments:unknown.png">';
    const out = rewriteCopiedHtml(html, name => (name === 'mwf1-abc123.png' ? '/htree/nhash1abc/mwf1-abc123.png' : undefined), 'https://drive.example/#/x');
    expect(out).toContain('src="https://drive.example/htree/nhash1abc/mwf1-abc123.png" data-iris-attachment="mwf1-abc123.png"');
    // A picture this browser cannot place stays as it was.
    expect(out).toContain('src="attachments:unknown.png"');
  });

  it('leaves names that are not attachment names alone', () => {
    const html = '<img src="attachments:../../etc"><img src="https://example.com/a.png">';
    expect(rewriteCopiedHtml(html, () => '/x', 'https://drive.example/')).toBe(html);
  });
});

describe('pictures pasted into a document', () => {
  it('are foreign unless the document holds them', () => {
    expect(isForeignImageSrc('attachments:a.png')).toBe(false);
    expect(isForeignImageSrc('https://example.com/a.png')).toBe(true);
    expect(isForeignImageSrc('data:image/png;base64,AAAA')).toBe(true);
    expect(isForeignImageSrc('')).toBe(false);
    expect(isForeignImageSrc(null)).toBe(false);
  });

  it('come as files when the HTML only wraps them', () => {
    expect(htmlIsOnlyPictures(undefined)).toBe(true);
    expect(htmlIsOnlyPictures('<meta charset="utf-8"><img src="https://x/a.png">')).toBe(true);
    expect(htmlIsOnlyPictures('<style>p{}</style><img src="a.png">&nbsp;')).toBe(true);
    expect(htmlIsOnlyPictures('<p>Caption</p><img src="a.png">')).toBe(false);
  });

  it('are taken from the clipboard in order, and only pictures', () => {
    const file = (name: string, type: string) => new File(['x'], name, { type });
    const items = [file('a.png', 'image/png'), file('notes.txt', 'text/plain'), file('b.jpg', 'image/jpeg')]
      .map(f => ({ kind: 'file', type: f.type, getAsFile: () => f }));
    const data = { items, files: [] } as unknown as DataTransfer;
    expect(imageFiles(data).map(f => f.name)).toEqual(['a.png', 'b.jpg']);
    expect(imageFiles(null)).toEqual([]);
    const onlyFiles = { items: [], files: [file('c.gif', 'image/gif')] } as unknown as DataTransfer;
    expect(imageFiles(onlyFiles).map(f => f.name)).toEqual(['c.gif']);
  });
});
