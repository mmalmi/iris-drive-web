import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const appDir = path.resolve(__dirname, '..');
export const repoRoot = appDir;

/**
 * @param {Array<string | null | undefined>} candidates
 * @param {(candidate: string) => boolean} predicate
 * @returns {string | null}
 */
function firstExistingPath(candidates, predicate = existsSync) {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (predicate(candidate)) return candidate;
  }
  return null;
}

export function resolveHashtreeRepoRoot() {
  return firstExistingPath(
    [
      process.env.HASHTREE_REPO_ROOT,
      path.join(repoRoot, 'hashtree'),
      path.resolve(repoRoot, '..', 'hashtree'),
    ],
    (candidate) => existsSync(path.join(candidate, 'rust', 'Cargo.toml')),
  );
}

export function resolveHashtreeRustDir() {
  const hashtreeRepoRoot = resolveHashtreeRepoRoot();
  return firstExistingPath(
    [
      process.env.HASHTREE_RUST_DIR,
      hashtreeRepoRoot ? path.join(hashtreeRepoRoot, 'rust') : null,
      path.join(repoRoot, 'rust'),
    ],
    (candidate) => existsSync(path.join(candidate, 'Cargo.toml')),
  );
}

export function resolveHashtreeCiDir() {
  return firstExistingPath(
    [
      process.env.HASHTREE_CI_DIR,
      path.join(repoRoot, 'hashtree-ci'),
      path.resolve(repoRoot, '..', 'hashtree-ci'),
    ],
    (candidate) =>
      existsSync(path.join(candidate, 'Cargo.toml')) ||
      existsSync(path.join(candidate, 'package.json')),
  );
}

export function resolveReferenceFile(...segments) {
  const directPath = path.join(repoRoot, ...segments);
  if (existsSync(directPath)) {
    return directPath;
  }

  const hashtreeRepoRoot = resolveHashtreeRepoRoot();
  if (!hashtreeRepoRoot) {
    return directPath;
  }

  return path.join(hashtreeRepoRoot, ...segments);
}

export function resolveScreensDir() {
  return path.join(repoRoot, 'tmp', 'screens');
}

export function resolveHtreeCommand(...args) {
  if (process.env.HTREE_BIN) {
    return [process.env.HTREE_BIN, ...args];
  }

  const rustDir = resolveHashtreeRustDir();
  if (rustDir) {
    return [
      'cargo',
      'run',
      '--manifest-path',
      path.join(rustDir, 'Cargo.toml'),
      '-p',
      'hashtree-cli',
      '--bin',
      'htree',
      '--',
      ...args,
    ];
  }

  return ['htree', ...args];
}
