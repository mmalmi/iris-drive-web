import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  repoRoot,
  resolveHashtreeCiDir,
  resolveHashtreeRepoRoot,
  resolveHashtreeRustDir,
  resolveHtreeCommand,
} from '../scripts/hashtreePaths.mjs';

const originalEnv = {
  HASHTREE_REPO_ROOT: process.env.HASHTREE_REPO_ROOT,
  HASHTREE_RUST_DIR: process.env.HASHTREE_RUST_DIR,
  HASHTREE_CI_DIR: process.env.HASHTREE_CI_DIR,
  HTREE_BIN: process.env.HTREE_BIN,
};

function resetEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

afterEach(() => {
  resetEnv();
});

describe('hashtree path resolution', () => {
  it('auto-detects sibling hashtree checkouts when present', () => {
    delete process.env.HASHTREE_REPO_ROOT;
    delete process.env.HASHTREE_RUST_DIR;
    delete process.env.HASHTREE_CI_DIR;
    delete process.env.HTREE_BIN;

    const candidateRepoRoots = [
      path.join(repoRoot, 'hashtree'),
      path.resolve(repoRoot, '..', 'hashtree'),
    ];
    const expectedRepoRoot = candidateRepoRoots.find((candidate) =>
      fs.existsSync(path.join(candidate, 'rust', 'Cargo.toml')),
    ) ?? null;
    const expectedRustDir = expectedRepoRoot ? path.join(expectedRepoRoot, 'rust') : null;

    const candidateCiDirs = [
      path.join(repoRoot, 'hashtree-ci'),
      path.resolve(repoRoot, '..', 'hashtree-ci'),
    ];
    const expectedCiDir = candidateCiDirs.find((candidate) =>
      fs.existsSync(path.join(candidate, 'Cargo.toml')) ||
      fs.existsSync(path.join(candidate, 'package.json')),
    ) ?? null;

    expect(resolveHashtreeRepoRoot()).toBe(expectedRepoRoot);
    expect(resolveHashtreeRustDir()).toBe(expectedRustDir);
    expect(resolveHashtreeCiDir()).toBe(expectedCiDir);
    expect(resolveHtreeCommand('add', '.')).toEqual(expectedRustDir ? [
      'cargo',
      'run',
      '--manifest-path',
      path.join(expectedRustDir, 'Cargo.toml'),
      '-p',
      'hashtree-cli',
      '--bin',
      'htree',
      '--',
      'add',
      '.',
    ] : ['htree', 'add', '.']);
  });

  it('still honors explicit rust workspace overrides', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iris-files-hashtree-'));
    const rustDir = path.join(tempRoot, 'rust');

    fs.mkdirSync(rustDir, { recursive: true });
    fs.writeFileSync(path.join(rustDir, 'Cargo.toml'), '[package]\nname = "hashtree-cli"\nversion = "0.0.0"\n');
    process.env.HASHTREE_RUST_DIR = rustDir;

    expect(resolveHashtreeRustDir()).toBe(rustDir);
    expect(resolveHtreeCommand('add', '.')).toEqual([
      'cargo',
      'run',
      '--manifest-path',
      path.join(rustDir, 'Cargo.toml'),
      '-p',
      'hashtree-cli',
      '--bin',
      'htree',
      '--',
      'add',
      '.',
    ]);

    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
});
