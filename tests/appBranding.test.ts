import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { getAppBrand } from '../src/lib/appBrand';

const root = process.cwd();
const publicDir = path.join(root, 'public');

function read(relativePath: string): string {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

describe('iris-files app branding', () => {
  it('defines the Drive icon set', () => {
    const brand = getAppBrand('files');
    expect(fs.existsSync(path.join(publicDir, brand.iconSvg))).toBe(true);
    expect(fs.existsSync(path.join(publicDir, brand.appleTouchPng))).toBe(true);
    expect(fs.existsSync(path.join(publicDir, brand.pwa192Png))).toBe(true);
    expect(fs.existsSync(path.join(publicDir, brand.pwa512Png))).toBe(true);
  });

  it('points the html entry to the Drive favicon svg', () => {
    const source = read('index.html');
    const brand = getAppBrand('files');

    expect(source).toContain(`type="image/svg+xml" href="%BASE_URL%${brand.iconSvg}"`);
    expect(source).not.toContain('iris-favicon.png');
  });

  it('uses a lowercase browser page title', () => {
    const source = read('index.html');
    const brand = getAppBrand('files');

    expect(source).toContain(`<title>iris ${brand.label}</title>`);
  });

  it('keeps the shared header logo on the iris app family name', () => {
    const source = read('src/components/Logo.svelte');

    expect(source).toContain('>iris <span class="text-accent">{brand.label}</span>');
  });

  it('uses the Drive install icons in the portable build config', () => {
    const source = read('vite.config.ts');

    expect(source).toContain("const brand = getAppBrand('files')");
    expect(source).toContain('includeAssets: [brand.iconSvg, brand.appleTouchPng]');
    expect(source).toContain("icons: getAppPwaIcons('files')");
    expect(source).not.toContain("'iris-logo.png'");
  });

  it('publishes the Drive universal-link association file', () => {
    const association = JSON.parse(
      fs.readFileSync(path.join(publicDir, '.well-known/apple-app-site-association'), 'utf8')
    );

    expect(association.applinks.details[0].appIDs).toContain('J8PPJKD7TA.to.iris.drive.macos');
    expect(association.applinks.details[0].appIDs).toContain('J8PPJKD7TA.to.iris.drive.ios');
  });
});
