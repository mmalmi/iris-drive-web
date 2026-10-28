import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const port = Number(process.env.PEER_STORE_TEST_PORT ?? 5187);
export default defineConfig({
  testDir: '.', testMatch: 'peer-announcements.spec.ts', workers: 1,
  timeout: 30_000, use: { baseURL: 'http://127.0.0.1:' + port, headless: true },
  webServer: { cwd: fileURLToPath(new URL('..', import.meta.url)), command: 'node node_modules/vite/bin/vite.js --config e2e/peer-announcements.vite.config.ts --host 127.0.0.1 --port ' + port + ' --strictPort',
    url: 'http://127.0.0.1:' + port + '/e2e/fixtures/peer-announcements.html', reuseExistingServer: false, timeout: 30_000 },
});
