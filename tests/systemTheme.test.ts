import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const appRoot = path.resolve(process.cwd());
const unoConfigPath = path.join(appRoot, 'uno.config.ts');
const themeCssPath = path.join(appRoot, 'src/system-theme.css');
const htmlFiles = [
  'index.html',
].map((file) => path.join(appRoot, file));

describe('system theme wiring', () => {
  it('uses CSS variables for semantic surface and text colors', () => {
    const unoConfig = fs.readFileSync(unoConfigPath, 'utf8');
    expect(unoConfig).toContain("0: 'rgb(var(--surface-0) / <alpha-value>)'");
    expect(unoConfig).toContain("1: 'rgb(var(--surface-1) / <alpha-value>)'");
    expect(unoConfig).toContain("3: 'rgb(var(--surface-3) / <alpha-value>)'");
    expect(unoConfig).toContain("1: 'rgb(var(--text-1) / <alpha-value>)'");
    expect(unoConfig).toContain("3: 'rgb(var(--text-3) / <alpha-value>)'");
  });

  it('publishes light and dark theme colors in every entry html', () => {
    const themeCss = fs.readFileSync(themeCssPath, 'utf8');
    expect(themeCss).toContain('color-scheme: light dark;');
    expect(themeCss).toContain('--surface-0: 245 245 245;');
    expect(themeCss).toContain('--surface-0: 15 15 15;');
    for (const htmlPath of htmlFiles) {
      const html = fs.readFileSync(htmlPath, 'utf8');
      expect(html).toContain('<meta name="theme-color" content="#0f0f0f" media="(prefers-color-scheme: dark)">');
      expect(html).toContain('<meta name="theme-color" content="#f5f5f5" media="(prefers-color-scheme: light)">');
      expect(html).toContain('<link rel="stylesheet" href="./src/system-theme.css" />');
      expect(html).not.toContain('<html lang="en" class="dark">');
    }
  });
});
