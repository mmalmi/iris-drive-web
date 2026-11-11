import { afterEach, describe, expect, it } from 'vitest';
import {
  shouldOpenSourceCodeLinkInNewTab,
  setAppType,
} from '../src/appType';

afterEach(() => {
  setAppType('files');
});

describe('app capabilities', () => {
  it('opens source links outside the files app', () => {
    setAppType('files');
    expect(shouldOpenSourceCodeLinkInNewTab()).toBe(true);
  });

  it('keeps source links external after resetting the app type', () => {
    setAppType('files');
    expect(shouldOpenSourceCodeLinkInNewTab()).toBe(true);
  });
});
