import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function read(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', relativePath), 'utf8');
}

describe('asset paths are base-url aware', () => {
  it('does not hardcode root asset paths in UI components', () => {
    expect(read('src/components/Logo.svelte')).not.toContain('/iris-logo.png');
  });
});
