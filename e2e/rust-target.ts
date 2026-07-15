import os from 'os';
import path from 'path';
import { repoRoot, resolveHashtreeCiDir, resolveHashtreeRustDir } from '../scripts/hashtreePaths.mjs';

export const HASHTREE_RUST_DIR = resolveHashtreeRustDir() ?? path.join(repoRoot, 'rust');
export const HASHTREE_CI_DIR = resolveHashtreeCiDir() ?? path.join(repoRoot, 'hashtree-ci');

const repoRustTargetDir = path.join(HASHTREE_RUST_DIR, 'target');

const defaultRustTargetDir = repoRustTargetDir;
const defaultHashtreeCiTargetDir = path.join(os.tmpdir(), 'hashtree-iris-files-e2e-hashtree-ci-target');

export const HASHTREE_E2E_RUST_TARGET_DIR =
  process.env.HTREE_E2E_RUST_TARGET_DIR || defaultRustTargetDir;
export const HASHTREE_E2E_HASHTREE_CI_TARGET_DIR =
  process.env.HTREE_E2E_HASHTREE_CI_TARGET_DIR || defaultHashtreeCiTargetDir;

process.env.HTREE_E2E_RUST_TARGET_DIR = HASHTREE_E2E_RUST_TARGET_DIR;
process.env.HTREE_E2E_HASHTREE_CI_TARGET_DIR = HASHTREE_E2E_HASHTREE_CI_TARGET_DIR;

export function withRustTargetEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    CARGO_TARGET_DIR: HASHTREE_E2E_RUST_TARGET_DIR,
  };
}

export function withHashtreeCiTargetEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    CARGO_TARGET_DIR: HASHTREE_E2E_HASHTREE_CI_TARGET_DIR,
  };
}

export function rustTargetPath(...segments: string[]): string {
  return path.join(HASHTREE_E2E_RUST_TARGET_DIR, ...segments);
}

export function hashtreeCiTargetPath(...segments: string[]): string {
  return path.join(HASHTREE_E2E_HASHTREE_CI_TARGET_DIR, ...segments);
}
