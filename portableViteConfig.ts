import { readFile, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type PortableFileOps = Pick<typeof import('node:fs/promises'), 'readFile' | 'writeFile' | 'unlink'>;

// What these import (the @noble and @scure libraries) goes with them, so that
// the copies only the peer network uses stay in its own chunk.
const portableVendorLibs = [
  'svelte',
  'nostr-tools',
  'idb-keyval',
];

export const portableAssetBase = './';

export const filesPortableBuild = {
  modulePreload: false,
} as const;

export function shouldAnalyzeBuild(env: Record<string, string | undefined> = process.env): boolean {
  return env.BUILD_ANALYZE === '1' || env.npm_lifecycle_event === 'build:analyze';
}

export function getFilesBase(env: Record<string, string | undefined> = process.env): string {
  return env.GITHUB_PAGES === 'true' ? '/iris-drive-web/' : portableAssetBase;
}

export function sanitizePortableHtml(html: string): string {
  return html
    .replace(/^\s*<link rel="modulepreload".*$/gm, '')
    .replace(/\s+crossorigin(?=[\s>])/g, '');
}

export async function rewritePortableEntryHtml(
  buildDir: string,
  sourceName: string,
  fileOps: PortableFileOps = {
    readFile,
    writeFile,
    unlink,
  },
): Promise<void> {
  const source = resolve(buildDir, sourceName);
  const target = resolve(buildDir, 'index.html');
  const html = await fileOps.readFile(source, 'utf8');
  await fileOps.writeFile(target, sanitizePortableHtml(html), 'utf8');
  if (source !== target) {
    await fileOps.unlink(source);
  }
}

export function portableAssetFileNames(assetInfo: { name?: string | undefined }): string {
  if (assetInfo.name?.endsWith('.wasm')) {
    return 'assets/[name][extname]';
  }
  return 'assets/[name]-[hash][extname]';
}

function resolveSharedVendorChunk(id: string): string | undefined {
  // Signing in with a remote signer brings its own relay pool; it loads then.
  if (/node_modules\/nostr-tools\/lib\/esm\/(nip46|pool|abstract-pool)\.js$/.test(id)) return undefined;
  return portableVendorLibs.some((lib) => id.includes(`node_modules/${lib}`)) ? 'vendor' : undefined;
}

export function filesManualChunks(id: string): string | undefined {
  if (id.includes('node_modules/@fips/') || id.includes('node_modules/@hashtree/fips-transport')) {
    return 'fips';
  }
  if (id.includes('marked')) {
    return 'markdown';
  }
  if (id.includes('fflate')) {
    return 'compression';
  }
  if (id.includes('hls.js')) {
    return 'media';
  }
  if (id.includes('@nostr-dev-kit/ndk')) {
    return 'ndk';
  }
  if (id.includes('dexie')) {
    return 'dexie';
  }
  // Needed at start; kept out of the 'dexie' chunk, which only the peer
  // network uses, so that chunk loads with it instead of before the first screen.
  if (/node_modules\/(@hashtree\/core|@msgpack\/msgpack)\//.test(id)) {
    return 'hashtree';
  }
  // The text editor goes only to documents and presentations; spreadsheets
  // share just the Yjs part.
  if (/node_modules\/(@tiptap|prosemirror-|linkifyjs|rope-sequence|orderedmap|w3c-keyname)/.test(id)) {
    return 'richtext';
  }
  if (/node_modules\/(yjs|lib0|y-protocols)\//.test(id)) {
    return 'yjs';
  }
  return resolveSharedVendorChunk(id);
}
