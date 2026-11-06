import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const profile = new URL('./fixtures/loopback-only.sb', import.meta.url);
const profileSha256 = '339423f809b977e1c1a1b0ca1d88035fc03f56227d8ae69e844d983b61bc484f';

// Reuses the independently qualified loopback policy and preflight. Socket
// routing supplies local test data; this boundary independently prevents egress.
export async function enforceLoopbackBoundary(script) {
  assert.equal(createHash('sha256').update(await readFile(profile)).digest('hex'), profileSha256);
  // The rejecting browser proxy and raw worker controls remain mandatory on
  // every platform. This host also confines Node and browser descendants.
  if (process.platform !== 'darwin') return { kernelBoundary: 'not-applicable; browser proxy required' };
  if (process.platform === 'darwin' && process.env.IRIS_DRIVE_LOOPBACK_CHILD !== '1') {
    const result = spawnSync('sandbox-exec', ['-f', fileURLToPath(profile), process.execPath,
      script, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, IRIS_DRIVE_LOOPBACK_CHILD: '1' } });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  }
  async function denied(host) {
    const code = await new Promise(resolve => {
      const socket = createConnection({ host, port: 443 });
      socket.on('connect', () => { socket.destroy(); resolve('CONNECTED'); });
      socket.on('error', error => resolve(error.code));
      socket.setTimeout(1000, () => { socket.destroy(); resolve('TIMEOUT'); });
    });
    assert.equal(code, 'EPERM', 'An independent loopback-only network boundary is required before browser tests');
  }
  await denied('203.0.113.1'); await denied('2001:db8::1');
  const server = createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: server.address().port });
      socket.on('error', reject); socket.on('connect', () => { socket.end(); resolve(); });
    });
  } finally { await new Promise(resolve => server.close(resolve)); }
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { createConnection } from 'node:net';
    const socket = createConnection({ host: '203.0.113.1', port: 443 });
    socket.on('connect', () => process.exit(2));
    socket.on('error', error => process.exit(error.code === 'EPERM' ? 0 : 3));
    socket.setTimeout(1000, () => process.exit(4));
  `]);
  assert.equal(child.status, 0, 'Child processes must inherit independent outbound denial');
  return { profileSha256, ipv4Denied: true, ipv6Denied: true, childDenial: true, loopbackAllowed: true };
}
