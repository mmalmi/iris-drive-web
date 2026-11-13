import { describe, expect, it } from 'vitest';
import {
  documentFolderName,
  documentKind,
  documentTitle,
  isDocumentFolderName,
  routeDocumentFolderName,
  snapshotLinkQuery,
} from '../src/lib/documentNames';

describe('document folder names', () => {
  it('tells documents, spreadsheets and presentations from folders', () => {
    expect(documentKind('Trip plan.irisdoc')).toBe('document');
    expect(documentKind('Budget.irissheet')).toBe('sheet');
    expect(documentKind('Pitch.IRISSLIDES')).toBe('slides');
    expect(documentKind('Photos')).toBeNull();
    expect(documentKind('.irissheet')).toBeNull();
    expect(isDocumentFolderName('Budget.irissheet')).toBe(true);
  });

  it('shows the title without the extension and builds the name back', () => {
    expect(documentTitle('Budget.irissheet')).toBe('Budget');
    expect(documentTitle('Photos')).toBe('Photos');
    expect(documentFolderName(' Pitch ', 'slides')).toBe('Pitch.irisslides');
    expect(documentFolderName('Trip plan')).toBe('Trip plan.irisdoc');
  });

  it('carries the kind in a snapshot link', () => {
    const open = (query: string) => routeDocumentFolderName({
      path: [],
      isPermalink: true,
      params: new URLSearchParams(query),
    });
    expect(open(snapshotLinkQuery('Trip plan.irisdoc'))).toBe('Trip plan.irisdoc');
    expect(snapshotLinkQuery('Trip plan.irisdoc')).toBe('doc=Trip%20plan');
    expect(open(snapshotLinkQuery('Q1 & Q2.irissheet'))).toBe('Q1 & Q2.irissheet');
    expect(open(snapshotLinkQuery('Pitch.irisslides'))).toBe('Pitch.irisslides');
    expect(open('doc=Pitch&kind=nonsense')).toBe('Pitch.irisdoc');
  });
});
