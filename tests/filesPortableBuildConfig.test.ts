import { describe, expect, it } from 'vitest';
import { filesManualChunks, filesPortableBuild, getFilesBase, sanitizePortableHtml } from '../portableViteConfig';

describe('files portable build config', () => {
  it('uses a relative asset base for files builds served from htree trees', () => {
    expect(getFilesBase({})).toBe('./');
    expect(filesPortableBuild.modulePreload).toBe(false);
  });

  it('does not split a removed executable-emulation chunk', () => {
    expect(filesManualChunks('/workspace/node_modules/emulators/dist/index.js')).toBeUndefined();
    expect(filesManualChunks('/workspace/node_modules/js-dos/index.js')).toBeUndefined();
    expect(filesManualChunks('/workspace/node_modules/marked/lib/marked.js')).toBe('markdown');
  });

  it('strips module preload and crossorigin hints for htree webviews', () => {
    const sanitized = sanitizePortableHtml(`
      <script type="module" crossorigin src="./assets/main.js"></script>
      <link rel="modulepreload" crossorigin href="./assets/vendor.js">
      <link rel="stylesheet" crossorigin href="./assets/main.css">
    `);

    expect(sanitized).not.toContain('modulepreload');
    expect(sanitized).not.toContain('crossorigin');
    expect(sanitized).toContain('<script type="module" src="./assets/main.js"></script>');
    expect(sanitized).toContain('<link rel="stylesheet" href="./assets/main.css">');
  });
});
