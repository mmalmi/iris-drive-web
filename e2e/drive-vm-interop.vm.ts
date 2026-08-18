import { expect } from './fixtures';
import { execFileSync } from 'node:child_process';
import { getPublicKey, nip19, generateSecretKey, type Event } from 'nostr-tools';

export type VmSession = {
  sshHost: string;
  idriveBin: string;
  baseDir: string;
  configDir: string;
  tmpDir: string;
  ownerNpub: string;
  ownerNsec: string;
  profileId: string;
  devicePubkey: string;
  relayUrl: string;
  blossomUrl: string;
};

export type WebDriveDevice = {
  secret: Uint8Array;
  pubkey: string;
  seq: number;
};

export type WebEntry =
  | { kind: 'file'; content: string }
  | { kind: 'directory' }
  | null;

export type DriveMutation =
  | { type: 'write'; path: string; content: string }
  | { type: 'mkdir'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'rename'; from: string; to: string };

export type DriveActor = 'web' | 'vm';

export type ReleaseSequence = {
  name: string;
  run: (ctx: InteropContext, source: DriveActor, prefix: string) => Promise<void>;
};

export type PublishResult = {
  published_files_root?: boolean;
  published_drive_root?: boolean;
};

export type ProviderList = {
  entries: Array<{ path: string; kind: string }>;
};

export type BrowserNostrState = {
  pubkey?: string;
  npub?: string;
  selectedTree?: {
    name?: string;
    pubkey?: string;
  } | null;
};

export type BrowserNostrStore = {
  getState?: () => BrowserNostrState;
};

export type BrowserWorkerAdapter = {
  pushToBlossom?: (hash: Uint8Array, key: Uint8Array | undefined, treeName: string) => Promise<{ failed: number }>;
  publish?: (event: Event) => Promise<void>;
  setP2PProvider?: (provider: unknown) => void;
};

export type BrowserDriveFipsStats = {
  active: boolean;
  discoveryScope: string;
  localPeerId: string;
  localXOnlyPubkey: string;
  localNpub: string;
  connectedPeerIds: string[];
  connectedNpubs: string[];
};

export type BrowserDriveFipsRuntime = {
  getStats: () => BrowserDriveFipsStats;
  getP2PProvider: () => unknown;
  stop: () => Promise<void>;
};

export type BrowserTestWindow = Window & {
  __nostrStore?: BrowserNostrStore;
  __getWorkerAdapter?: () => BrowserWorkerAdapter | undefined;
  __workerAdapter?: BrowserWorkerAdapter;
  __irisDriveFips?: BrowserDriveFipsRuntime;
};

export type VmDaemonProcess = {
  pidFile: string;
  logFile: string;
};

export type InteropContext = {
  page: Page;
  session: VmSession;
  webDevice: WebDriveDevice;
};

export const vmHost = process.env.IRIS_DRIVE_VM_HOST;
export const vmRelayUrl = process.env.IRIS_DRIVE_VM_RELAY_URL;
export const vmBlossomUrl = process.env.IRIS_DRIVE_VM_BLOSSOM_URL;
export const vmIdriveBin = process.env.IRIS_DRIVE_VM_IDRIVE || 'idrive';
export const vmRustLog = process.env.IRIS_DRIVE_VM_RUST_LOG || 'warn';
export const missingVmEnv = !vmHost || !vmRelayUrl || !vmBlossomUrl;
export let remoteFileCounter = 0;

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function runSsh(host: string, script: string, timeoutMs = 120000): string {
  return execFileSync('ssh', [host, 'bash', '-se'], {
    input: `set -euo pipefail\nexport RUST_LOG=${shellQuote(vmRustLog)}\n${script}`,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 16,
  });
}

export function parseJsonLines(stdout: string): unknown[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{') && line.endsWith('}'))
    .map((line) => JSON.parse(line) as unknown);
}

export function parseLastJson<T = Record<string, unknown>>(stdout: string): T {
  const items = parseJsonLines(stdout);
  if (items.length === 0) {
    throw new Error(`command did not print JSON: ${stdout}`);
  }
  return items[items.length - 1] as T;
}

export function marker(stdout: string, name: string): string {
  const prefix = `__IRIS_VM_${name}__=`;
  const line = stdout.split(/\r?\n/).find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    throw new Error(`missing VM setup marker ${name}`);
  }
  return line.slice(prefix.length);
}

export function isNavigationContextReset(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Execution context was destroyed')
    || message.includes('Cannot find context with specified id')
    || message.includes('Target page, context or browser has been closed');
}

export function npubToHex(npub: string): string {
  const decoded = nip19.decode(npub);
  if (decoded.type !== 'npub' || typeof decoded.data !== 'string') {
    throw new Error(`expected npub, got ${decoded.type}`);
  }
  return decoded.data;
}

export async function waitForDistinctRootTimestamp(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1100));
}

export function idrive(session: VmSession): string {
  return `${shellQuote(session.idriveBin)} --config-dir ${shellQuote(session.configDir)}`;
}

export async function setupVmSession(): Promise<VmSession> {
  if (!vmHost || !vmRelayUrl || !vmBlossomUrl) {
    throw new Error('VM interop env is incomplete');
  }

  const stdout = runSsh(vmHost, `
base="$(mktemp -d "\${TMPDIR:-/tmp}/iris-drive-web-vm-XXXXXX")"
config="$base/config"
tmp="$base/tmp"
mkdir -p "$config" "$tmp"
idrive_bin=${shellQuote(vmIdriveBin)}
blossom_url=${shellQuote(vmBlossomUrl)}
init_json="$("$idrive_bin" --config-dir "$config" init --label iris-files-vm-e2e)"
"$idrive_bin" --config-dir "$config" blossom-servers remove "https://upload.iris.to" >/dev/null 2>&1 || true
"$idrive_bin" --config-dir "$config" blossom-servers add "$blossom_url" >/dev/null
owner_nsec="$(tr -d '\\r\\n' < "$config/owner_key")"
printf '%s\\n' "$init_json"
printf '__IRIS_VM_BASE__=%s\\n' "$base"
printf '__IRIS_VM_CONFIG__=%s\\n' "$config"
printf '__IRIS_VM_TMP__=%s\\n' "$tmp"
printf '__IRIS_VM_OWNER_NSEC__=%s\\n' "$owner_nsec"
`);
  const init = parseJsonLines(stdout)[0] as {
    owner_npub: string;
    device_npub: string;
    profile_id: string;
  };
  if (!init?.owner_npub || !init.device_npub || !init.profile_id) {
    throw new Error(`idrive init output did not include the profile and owner/device npubs: ${stdout}`);
  }

  return {
    sshHost: vmHost,
    idriveBin: vmIdriveBin,
    baseDir: marker(stdout, 'BASE'),
    configDir: marker(stdout, 'CONFIG'),
    tmpDir: marker(stdout, 'TMP'),
    ownerNsec: marker(stdout, 'OWNER_NSEC'),
    ownerNpub: init.owner_npub,
    profileId: init.profile_id,
    devicePubkey: npubToHex(init.device_npub),
    relayUrl: vmRelayUrl,
    blossomUrl: vmBlossomUrl,
  };
}

export function cleanupVmSession(session: VmSession): void {
  runSsh(session.sshHost, `rm -rf ${shellQuote(session.baseDir)}`, 30000);
}

export function runVmJson<T = Record<string, unknown>>(session: VmSession, command: string, timeoutMs = 120000): T {
  return parseLastJson<T>(runSsh(session.sshHost, command, timeoutMs));
}

export function vmStatus(session: VmSession): Record<string, unknown> {
  return runVmJson(session, `${idrive(session)} status`);
}

export function vmFipsStatus(session: VmSession): Record<string, unknown> {
  const status = vmStatus(session);
  const network = status.network as { fips?: Record<string, unknown> } | undefined;
  return network?.fips ?? {};
}

export function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function startVmDaemon(session: VmSession): VmDaemonProcess {
  const pidFile = `${session.baseDir}/idrive-daemon.pid`;
  const logFile = `${session.baseDir}/idrive-daemon.log`;
  runSsh(session.sshHost, `
pid_file=${shellQuote(pidFile)}
log_file=${shellQuote(logFile)}
if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  exit 0
fi
rm -f "$pid_file"
: > "$log_file"
IRIS_DRIVE_FIPS_ENABLE_UDP=0 \\
IRIS_DRIVE_FIPS_ENABLE_BOOTSTRAP=0 \\
IRIS_DRIVE_FIPS_WEBRTC_MAX_CONNECTIONS=8 \\
nohup ${idrive(session)} daemon --relay ${shellQuote(session.relayUrl)} --no-gateway > "$log_file" 2>&1 &
printf '%s\\n' "$!" > "$pid_file"
sleep 1
if ! kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  cat "$log_file"
  exit 1
fi
`);
  return { pidFile, logFile };
}

export function stopVmDaemon(session: VmSession, daemon: VmDaemonProcess | null): void {
  if (!daemon) return;
  runSsh(session.sshHost, `
pid_file=${shellQuote(daemon.pidFile)}
if [ -f "$pid_file" ]; then
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 1
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
fi
`, 30000);
}

export async function vmPublish(session: VmSession): Promise<void> {
  await waitForDistinctRootTimestamp();
  const result = runVmJson<PublishResult>(
    session,
    `${idrive(session)} publish --relay ${shellQuote(session.relayUrl)} --timeout 10`,
  );
  expect(result.published_files_root || result.published_drive_root).toBeTruthy();
}

export async function vmSync(session: VmSession): Promise<void> {
  runVmJson(
    session,
    `${idrive(session)} sync --relay ${shellQuote(session.relayUrl)} --timeout 10`,
  );
}

export async function vmProviderWriteLocal(session: VmSession, path: string, content: string): Promise<void> {
  const source = `${session.tmpDir}/provider-source-${Date.now()}-${remoteFileCounter++}`;
  runVmJson(
    session,
    `
source=${shellQuote(source)}
mkdir -p "$(dirname "$source")"
printf %s ${shellQuote(content)} > "$source"
${idrive(session)} provider write ${shellQuote(path)} "$source"
`,
  );
}

export async function vmProviderWrite(session: VmSession, path: string, content: string): Promise<void> {
  await vmProviderWriteLocal(session, path, content);
  await vmPublish(session);
}

export async function vmProviderMkdirLocal(session: VmSession, path: string): Promise<void> {
  runVmJson(session, `${idrive(session)} provider mkdir ${shellQuote(path)}`);
}

export async function vmProviderMkdir(session: VmSession, path: string): Promise<void> {
  await vmProviderMkdirLocal(session, path);
  await vmPublish(session);
}

export async function vmProviderRenameLocal(session: VmSession, from: string, to: string): Promise<void> {
  runVmJson(session, `${idrive(session)} provider rename ${shellQuote(from)} ${shellQuote(to)}`);
}

export async function vmProviderRename(session: VmSession, from: string, to: string): Promise<void> {
  await vmProviderRenameLocal(session, from, to);
  await vmPublish(session);
}

export async function vmProviderDeleteLocal(session: VmSession, path: string): Promise<void> {
  runVmJson(session, `${idrive(session)} provider delete ${shellQuote(path)}`);
}

export async function vmProviderDelete(session: VmSession, path: string): Promise<void> {
  await vmProviderDeleteLocal(session, path);
  await vmPublish(session);
}

export function vmProviderList(session: VmSession): ProviderList {
  return runVmJson<ProviderList>(session, `${idrive(session)} provider list`);
}

export function readVmFile(session: VmSession, path: string): string | null {
  const output = `${session.tmpDir}/provider-read-${Date.now()}-${remoteFileCounter++}`;
  try {
    return runSsh(
      session.sshHost,
      `${idrive(session)} provider read ${shellQuote(path)} ${shellQuote(output)} >/dev/null\ncat ${shellQuote(output)}`,
      120000,
    );
  } catch {
    return null;
  }
}

export function vmEntryKind(session: VmSession, path: string): string | null {
  try {
    const listing = vmProviderList(session);
    return listing.entries.find((entry) => entry.path === path)?.kind ?? null;
  } catch {
    return null;
  }
}

export async function expectVmFile(session: VmSession, path: string, expectedContent: string): Promise<void> {
  await expect.poll(async () => {
    await vmSync(session);
    return readVmFile(session, path);
  }, {
    timeout: 120000,
    intervals: [1000, 2000, 3000, 5000],
  }).toBe(expectedContent);
}

export async function expectVmMissing(session: VmSession, path: string): Promise<void> {
  await expect.poll(async () => {
    await vmSync(session);
    return vmEntryKind(session, path);
  }, {
    timeout: 120000,
    intervals: [1000, 2000, 3000, 5000],
  }).toBeNull();
}

export async function expectVmEntryKind(session: VmSession, path: string, kind: string): Promise<void> {
  await expect.poll(async () => {
    await vmSync(session);
    return vmEntryKind(session, path);
  }, {
    timeout: 120000,
    intervals: [1000, 2000, 3000, 5000],
  }).toBe(kind);
}

export function readVmFilesBatch(session: VmSession, paths: string[]): Record<string, string | null> {
  if (paths.length === 0) return {};
  const listPath = `${session.tmpDir}/provider-read-list-${Date.now()}-${remoteFileCounter++}`;
  const stdout = runSsh(
    session.sshHost,
    `
list=${shellQuote(listPath)}
cat > "$list" <<'__IRIS_PATHS__'
${paths.join('\n')}
__IRIS_PATHS__
while IFS= read -r path; do
  out=${shellQuote(`${session.tmpDir}/provider-read-batch`)}"-$(date +%s)-$RANDOM"
  if ${idrive(session)} provider read "$path" "$out" >/dev/null 2>&1; then
    encoded="$(base64 < "$out" | tr -d '\\n')"
    printf '__IRIS_READ__%s\\tok\\t%s\\n' "$path" "$encoded"
  else
    printf '__IRIS_READ__%s\\tmissing\\t\\n' "$path"
  fi
  rm -f "$out"
done < "$list"
rm -f "$list"
`,
    120000,
  );
  const values: Record<string, string | null> = {};
  for (const path of paths) values[path] = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('__IRIS_READ__')) continue;
    const [path, status, encoded = ''] = line.slice('__IRIS_READ__'.length).split('\t');
    values[path] = status === 'ok' ? Buffer.from(encoded, 'base64').toString('utf8') : null;
  }
  return values;
}

export async function readVmFiles(session: VmSession, paths: string[]): Promise<Record<string, string | null>> {
  await vmSync(session);
  return readVmFilesBatch(session, paths);
}

export async function expectVmFiles(session: VmSession, files: Record<string, string>): Promise<void> {
  await expect.poll(
    () => readVmFiles(session, Object.keys(files)),
    { timeout: 120000, intervals: [1000, 2000, 3000, 5000] },
  ).toEqual(files);
}
