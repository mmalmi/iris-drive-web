import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { parseRectName } from '../src/lib/sheets/address';
import { SheetController } from '../src/lib/sheets/controller.svelte';
import { writeInput } from '../src/lib/sheets/edit';
import { linkTarget } from '../src/lib/sheets/links';

describe('links in cells', () => {
  it('reads a cell as a link only when it holds one web or mail address', () => {
    expect(linkTarget('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(linkTarget(' www.iris.to ')).toBe('https://www.iris.to');
    expect(linkTarget('mailto:ada@example.com')).toBe('mailto:ada@example.com');
    expect(linkTarget('see https://example.com')).toBeNull();
    expect(linkTarget('example.com')).toBeNull();
    expect(linkTarget('javascript:alert(1)')).toBeNull();
    expect(linkTarget('note:remember')).toBeNull();
    // HYPERLINK may name a bare domain.
    expect(linkTarget('example.com/x', true)).toBe('https://example.com/x');
    expect(linkTarget('not an address', true)).toBeNull();
    expect(linkTarget('data:text/html,hi', true)).toBeNull();
  });

  it('follows HYPERLINK to its address and shows its label', () => {
    const ctl = new SheetController(new Y.Doc());
    ctl.start(true);
    const put = (name: string, text: string) => {
      const rect = parseRectName(name)!;
      writeInput(ctl.book, ctl.sheet, rect.r1, rect.c1, text);
    };
    put('A1', 'iris.to/about');
    put('B1', '=HYPERLINK(A1, "About")');
    put('B2', '=HYPERLINK("https://example.com")');
    put('B3', '="https://example.com/" & "joined"');
    put('B4', '=HYPERLINK("javascript:alert(1)", "Bad")');
    const at = (row: number, col: number) => [ctl.engine.textAt(ctl.sheet, row, col), ctl.engine.linkAt(ctl.sheet, row, col)];
    expect(at(0, 1)).toEqual(['About', 'https://iris.to/about']);
    expect(at(1, 1)).toEqual(['https://example.com', 'https://example.com']);
    expect(at(2, 1)).toEqual(['https://example.com/joined', 'https://example.com/joined']);
    expect(at(3, 1)).toEqual(['Bad', null]);
    expect(at(0, 0)).toEqual(['iris.to/about', null]);
    ctl.destroy();
  });
});
