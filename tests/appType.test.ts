import { afterEach, describe, expect, it } from 'vitest';
import {
  shouldOpenSourceCodeLinkInNewTab,
  setAppType,
  supportsDocumentFeatures,
} from '../src/appType';

afterEach(() => {
  setAppType('files');
});

describe('app capabilities', () => {
  it('keeps the files app limited to generic file features', () => {
    setAppType('files');
    expect(supportsDocumentFeatures()).toBe(false);
    expect(shouldOpenSourceCodeLinkInNewTab()).toBe(true);
  });

  it('keeps source links external after resetting the app type', () => {
    setAppType('files');
    expect(shouldOpenSourceCodeLinkInNewTab()).toBe(true);
  });
});
