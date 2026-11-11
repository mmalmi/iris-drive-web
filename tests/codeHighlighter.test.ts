// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { highlightCode } from '../src/lib/codeHighlighter';
import Prism from 'prismjs';

describe('code highlighter', () => {
  it('colours known languages and leaves unknown ones to the caller', () => {
    expect(highlightCode('const answer = 42;', 'javascript')).toContain('token keyword');
    expect(highlightCode('plain words', 'no-such-language')).toBeNull();
  });

  it('never highlights the page by itself', () => {
    // Loaded after the viewer has rendered, an automatic pass would replace the
    // viewer's numbered lines with one block.
    expect(Prism.manual).toBe(true);
  });
});
