import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let cachedIdriveBin: string | undefined;

export function irisDriveRepo(): string {
  return process.env.IRIS_DRIVE_REPO || path.resolve(appDir, '../iris-drive');
}

export function irisDriveAvailable(): boolean {
  return fs.existsSync(irisDriveRepo());
}

export function idriveBin(): string {
  if (process.env.IRIS_DRIVE_BIN) return process.env.IRIS_DRIVE_BIN;
  if (cachedIdriveBin) return cachedIdriveBin;

  const repo = irisDriveRepo();
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    cwd: repo,
    encoding: 'utf8',
  }));
  const targetDir = path.resolve(repo, process.env.CARGO_TARGET_DIR || metadata.target_directory || 'target');
  const bin = path.join(targetDir, 'debug', process.platform === 'win32' ? 'idrive.exe' : 'idrive');
  if (!fs.existsSync(bin)) {
    execFileSync('cargo', ['build', '-p', 'idrive'], { cwd: repo, stdio: 'inherit' });
  }
  if (!fs.existsSync(bin)) throw new Error(`idrive build finished but ${bin} was not found`);
  cachedIdriveBin = bin;
  return cachedIdriveBin;
}

export function runIdriveJson<T = any>(configDir: string, args: string[]): T {
  return JSON.parse(execFileSync(idriveBin(), args, {
    env: { ...process.env, IRIS_DRIVE_CONFIG_DIR: configDir },
    encoding: 'utf8',
  }));
}

export function configureNativeRelay(configDir: string, relayUrl: string): void {
  const configured = runIdriveJson<string[]>(configDir, ['relays']);
  for (const relay of configured) runIdriveJson(configDir, ['relays', 'remove', relay]);
  runIdriveJson(configDir, ['relays', 'add', relayUrl]);
}
