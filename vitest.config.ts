import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const require = createRequire(import.meta.url);

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: {
      '$lib': resolve(__dirname, 'src/lib'),
      'virtual:uno.css': resolve(__dirname, 'tests/stubs/emptyVirtualModule.ts'),
      '@noble/hashes/hkdf.js': require.resolve('@noble/hashes/hkdf.js'),
      '@noble/hashes/sha2.js': require.resolve('@noble/hashes/sha2.js'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
