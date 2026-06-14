import { describe, expect, it } from 'vitest';
import { parseHttpByteRange } from '../src/lib/httpRange';

describe('parseHttpByteRange', () => {
  it('parses open-ended ranges', () => {
    expect(parseHttpByteRange('bytes=1024-', 4096)).toEqual({
      kind: 'range',
      range: {
        start: 1024,
        endInclusive: 4095,
      },
    });
  });

  it('parses suffix ranges against total size', () => {
    expect(parseHttpByteRange('bytes=-65536', 200000)).toEqual({
      kind: 'range',
      range: {
        start: 134464,
        endInclusive: 199999,
      },
    });
  });

  it('clamps oversized suffix ranges to the whole file', () => {
    expect(parseHttpByteRange('bytes=-999999', 4096)).toEqual({
      kind: 'range',
      range: {
        start: 0,
        endInclusive: 4095,
      },
    });
  });

  it('marks invalid ranges unsatisfiable', () => {
    expect(parseHttpByteRange('bytes=500-100', 4096)).toEqual({
      kind: 'unsatisfiable',
    });
    expect(parseHttpByteRange('bytes=9999-', 4096)).toEqual({
      kind: 'unsatisfiable',
    });
  });

  it('rejects multipart ranges as unsupported', () => {
    expect(parseHttpByteRange('bytes=0-1,2-3', 4096)).toEqual({
      kind: 'unsupported',
    });
  });
});
