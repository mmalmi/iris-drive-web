import { readFileSync } from 'node:fs';
import { nhashDecode } from '@hashtree/core';
import { test, expect } from './fixtures';
import { waitForAppReady } from './test-utils.js';

const fixture = JSON.parse(readFileSync(new URL('../tests/fixtures/native-sharing-wire.json', import.meta.url), 'utf8'));

// Rust's sharing_wire_fixture example emitted the disposable keys and ciphertext at
// mmalmi/iris-drive f4af90a92c7238c0601fb9dbae9ae216e0efa737 (CI run 41645237393).
test('reads native versioned roots and a compact invite through the same-origin worker', async ({ page }) => {
  await page.goto('/');
  await waitForAppReady(page);
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  const result = await page.evaluate(async (wire) => {
    const { getWorkerAdapter } = await import('/src/workerAdapter.ts');
    const { parseDriveRootEventForDevice, parseShareInvite } = await import('/src/drive/protocol.ts');
    const { resolveShareInvite } = await import('/src/drive/shareLinks.ts');
    const { getNhashFileUrl } = await import('/src/lib/mediaUrl.ts');
    const adapter = getWorkerAdapter();
    const fromHex = (hex: string) => Uint8Array.from(hex.match(/../g)!, (byte) => Number.parseInt(byte, 16));
    const toHex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    async function seed(ciphertextHex: string) {
      const bytes = fromHex(ciphertextHex);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
      await adapter.put(hash, bytes);
    }
    const secret = fromHex(wire.recipient_test_scalar.toString(16).padStart(64, '0'));
    const roots = [];
    for (const item of wire.roots) {
      await seed(item.ciphertext_hex);
      const { root } = parseDriveRootEventForDevice(item.event, secret);
      const url = getNhashFileUrl(root, 'native.txt');
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Unable to read native root: ${response.status}`);
      roots.push({
        cid: `${toHex(root.hash)}:${toHex(root.key)}`,
        prefix: root.key[0],
        length: root.key.length,
        plaintext: toHex(new Uint8Array(await response.arrayBuffer())),
      });
    }
    await seed(wire.invite.ciphertext_hex);
    const invite = parseShareInvite(await resolveShareInvite(wire.invite.url));
    return { roots, shareId: invite.shared_folder.share_id, recipient: invite.recipient_profile_id, role: invite.role };
  }, fixture);
  expect(result.roots).toEqual([
    { cid: fixture.roots[0].cid, prefix: 1, length: 33, plaintext: fixture.plaintext_hex },
    { cid: fixture.roots[1].cid, prefix: 2, length: 33, plaintext: fixture.plaintext_hex },
  ]);
  const inviteKey = nhashDecode(fixture.invite.url.split('/').at(-1)).key;
  expect(inviteKey).toHaveLength(33);
  expect(inviteKey?.[0]).toBe(1);
  expect(result.shareId).toBe(fixture.share_id);
  expect(result.recipient).toBe(fixture.recipient_profile_id);
  expect(result.role).toBe(fixture.invite.role);
});
