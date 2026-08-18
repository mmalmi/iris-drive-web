import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  filesManualChunks,
  filesPortableBuild,
  getFilesBase,
  sanitizePortableHtml,
  shouldAnalyzeBuild,
} from '../portableViteConfig';

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

  it('keeps the FIPS runtime out of the main application chunk', () => {
    expect(filesManualChunks('/workspace/node_modules/@fips/core/dist/index.js')).toBe('fips');
    expect(filesManualChunks('/workspace/node_modules/@hashtree/fips-transport/dist/browser.js')).toBe('fips');
  });

  it('only enables expensive bundle diagnostics for analyze builds', () => {
    expect(shouldAnalyzeBuild({ npm_lifecycle_event: 'build' })).toBe(false);
    expect(shouldAnalyzeBuild({ npm_lifecycle_event: 'build:analyze' })).toBe(true);
    expect(shouldAnalyzeBuild({ BUILD_ANALYZE: '1' })).toBe(true);
  });

  it('loads shared runtimes from installed packages without sibling workspaces', () => {
    const source = fs.readFileSync(path.join(process.cwd(), 'vite.config.ts'), 'utf8');

    expect(source).not.toContain("resolve(__dirname, '../iris-kit')");
    expect(source).not.toContain("resolve(__dirname, '../hashtree')");
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
