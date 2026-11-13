import { describe, expect, it } from 'vitest';
import { LinkType } from '@hashtree/core';
import { copyKind, draggedPictureUrl, freeName, pastedIntoFolder, pasteStamp } from '../src/lib/driveClipboard';
import { copiedPictureUrls } from '../src/lib/yjs/copiedPictures';

/** Just enough of a DataTransfer for reading what a paste or a drop holds. */
function transfer(files: File[], strings: Record<string, string> = {}): DataTransfer {
  return {
    items: files.map(file => ({ kind: 'file', type: file.type, getAsFile: () => file })),
    files,
    types: [...(files.length ? ['Files'] : []), ...Object.keys(strings)],
    getData: (type: string) => strings[type] ?? '',
  } as unknown as DataTransfer;
}

const NOW = new Date(2026, 10, 13, 14, 5, 33);

describe('pasting into a Drive folder', () => {
  it('names a screenshot or copied picture after when it was pasted', () => {
    const pasted = pastedIntoFolder(transfer([new File(['x'], 'image.png', { type: 'image/png' })]), new Set(), NOW);
    expect(pasteStamp(NOW)).toBe('2026-11-13 at 14.05.33');
    expect(pasted?.files.map(file => file.name)).toEqual(['Pasted image 2026-11-13 at 14.05.33.png']);
    expect(pasted?.files[0]?.type).toBe('image/png');
  });

  it('keeps the names of files copied in Finder or Explorer, and never overwrites one', () => {
    const pasted = pastedIntoFolder(transfer([
      new File(['a'], 'report.pdf', { type: 'application/pdf' }),
      new File(['b'], 'notes.txt', { type: 'text/plain' }),
    ]), new Set(['notes.txt']), NOW);
    expect(pasted?.files.map(file => file.name)).toEqual(['report.pdf', 'notes (2).txt']);
    expect(pasted?.summary).toBe('2 files');
  });

  it('keeps plain text as a text file, and ignores an empty clipboard', () => {
    const pasted = pastedIntoFolder(transfer([], { 'text/plain': 'hello there' }), new Set(), NOW);
    expect(pasted?.files[0]?.name).toBe('Pasted text 2026-11-13 at 14.05.33.txt');
    expect(pasted?.summary).toBe('Pasted text 2026-11-13 at 14.05.33.txt');
    expect(pastedIntoFolder(transfer([], { 'text/plain': '  ' }), new Set(), NOW)).toBeNull();
  });

  it('prefers the files to the words that come with them', () => {
    const pasted = pastedIntoFolder(transfer([new File(['x'], 'photo.jpg', { type: 'image/jpeg' })], { 'text/plain': 'photo.jpg' }), new Set(), NOW);
    expect(pasted?.files.map(file => file.name)).toEqual(['photo.jpg']);
  });

  it('numbers a name that is taken', () => {
    expect(freeName('a.png', new Set(['a.png', 'a (2).png']))).toBe('a (3).png');
    expect(freeName('folder', new Set(['folder']))).toBe('folder (2)');
  });
});

describe('dropping a picture from a web page', () => {
  it('finds the picture in the HTML a page gives, or in its link', () => {
    expect(draggedPictureUrl(transfer([], { 'text/html': '<meta charset="utf-8"><img src="https://example.com/cat.jpg?a=1&amp;b=2" alt="">' })))
      .toBe('https://example.com/cat.jpg?a=1&b=2');
    expect(draggedPictureUrl(transfer([], { 'text/uri-list': '# comment\r\nhttps://example.com/dog.png' }))).toBe('https://example.com/dog.png');
    expect(draggedPictureUrl(transfer([], { 'text/uri-list': 'javascript:alert(1)' }))).toBeNull();
  });
});

describe('copying a file for other apps', () => {
  it('copies a picture as a picture, a text file as its text and anything else as a link', () => {
    expect(copyKind({ name: 'Photo.JPG', type: LinkType.Blob, size: 10 })).toBe('picture');
    expect(copyKind({ name: 'notes.md', type: LinkType.Blob, size: 10 })).toBe('text');
    expect(copyKind({ name: 'report.pdf', type: LinkType.Blob, size: 10 })).toBe('link');
    expect(copyKind({ name: 'Photos', type: LinkType.Dir, size: 0 })).toBe('link');
    expect(copyKind({ name: 'huge.png', type: LinkType.Blob, size: 80 * 1024 * 1024 })).toBe('link');
  });
});

describe('pictures copied out of a document', () => {
  it('finds the pictures the copied HTML names', () => {
    const html = '<p>a</p><img src="https://drive.example/htree/nhash1x/a.png?x=1&amp;y=2" data-iris-attachment="1-a.png"><img src="blob:https://drive.example/42" data-iris-attachment="2-b.png">';
    expect(copiedPictureUrls(html)).toEqual(['https://drive.example/htree/nhash1x/a.png?x=1&y=2', 'blob:https://drive.example/42']);
  });
});
