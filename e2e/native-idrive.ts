import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let cachedIdriveBin: string | undefined;

export function irisDriveRepo(): string {
  return process.env.IRIS_DRIVE_REPO || path.resolve(appDir, '../iris-drive');
}

export function irisDriveAvailable(): boolean {
  const available = process.env.IRIS_DRIVE_BIN
    ? fs.existsSync(process.env.IRIS_DRIVE_BIN)
    : fs.existsSync(path.join(irisDriveRepo(), 'Cargo.toml'));
  if (!available && process.env.IRIS_DRIVE_REQUIRE_NATIVE === '1') {
    throw new Error('The release interop tests need a native idrive binary (IRIS_DRIVE_BIN) or checkout (IRIS_DRIVE_REPO).');
  }
  return available;
}

export function idriveBin(): string {
  if (cachedIdriveBin) return cachedIdriveBin;
  if (process.env.IRIS_DRIVE_BIN) return useBinary(path.resolve(process.env.IRIS_DRIVE_BIN));

  const repo = irisDriveRepo();
  const metadata = JSON.parse(execFileSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    cwd: repo,
    encoding: 'utf8',
  }));
  const targetDir = path.resolve(repo, process.env.CARGO_TARGET_DIR || metadata.target_directory || 'target');
  const bin = path.join(targetDir, 'debug', process.platform === 'win32' ? 'idrive.exe' : 'idrive');
  if (!fs.existsSync(bin) || process.env.IRIS_DRIVE_REQUIRE_NATIVE === '1') {
    execFileSync('cargo', ['build', '--locked', '-p', 'idrive'], { cwd: repo, stdio: 'inherit' });
  }
  if (!fs.existsSync(bin)) throw new Error(`idrive build finished but ${bin} was not found`);
  return useBinary(bin);
}

function useBinary(bin: string): string {
  if (process.env.IRIS_DRIVE_REQUIRE_NATIVE === '1') {
    const sha256 = createHash('sha256').update(fs.readFileSync(bin)).digest('hex');
    if (process.env.IRIS_DRIVE_BIN_SHA256 && sha256 !== process.env.IRIS_DRIVE_BIN_SHA256) {
      throw new Error('Native release candidate idrive SHA-256 mismatch');
    }
    console.log(`Native interop candidate SHA-256: ${sha256}`);
  }
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
