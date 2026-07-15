import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { wranglerVersion } from './release-site.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');
const workerPath = path.join(__dirname, 'files-redirect-worker.mjs');

const command = [
  'npx',
  `wrangler@${wranglerVersion}`,
  'deploy',
  workerPath,
  '--name',
  'iris-files-redirect',
  '--compatibility-date',
  '2026-03-19',
  '--keep-vars',
  '--route',
  'files.iris.to/*',
];

console.log(`$ ${command.join(' ')}`);

const child = spawn(command[0], command.slice(1), {
  cwd: appDir,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`deploy interrupted by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
