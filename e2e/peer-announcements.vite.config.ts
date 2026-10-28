import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Optional source checkout for deliberate shared-library development. Release
// qualification omits this variable and uses the app's immutable dependency.
export default defineConfig({
  optimizeDeps: { entries: ['e2e/fixtures/peer-announcements.html'] },
  resolve: { alias: process.env.PEER_PUBSUB_SOURCE
    ? { 'nostr-pubsub': resolve(process.env.PEER_PUBSUB_SOURCE, 'src/index.ts') } : {} },
  server: { fs: { allow: [process.cwd(), ...(process.env.PEER_PUBSUB_SOURCE
    ? [resolve(process.env.PEER_PUBSUB_SOURCE, '../..')] : [])] } },
});
