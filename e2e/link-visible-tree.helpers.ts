/**
 * E2E tests for linkvis (link-visible) trees
 *
 * Tests the three-tier visibility model:
 * - Creating link-visible trees with ?k= param in URL
 * - Uploading files to link-visible trees
 * - Accessing link-visible trees from a fresh browser with the link
 * - Verifying visibility icons in tree list and inside tree view
 */
import { expect } from './fixtures';
import { goToTreeList, flushPendingPublishes, waitForRelayConnected } from './test-utils.js';

export async function waitForLinkKey(page: any): Promise<string> {
  await expect(page).toHaveURL(/\?k=[a-f0-9]+/i);
  const match = page.url().match(/\?k=([a-f0-9]+)/i);
  if (!match) {
    throw new Error('Expected ?k= param in URL');
  }
  return match[1];
}

export async function getPubkeyHex(page: any): Promise<string> {
  const pubkey = await page.evaluate(() => (window as any).__nostrStore?.getState?.()?.pubkey || null);
  if (!pubkey) throw new Error('Could not find pubkey in nostr store');
  return pubkey;
}

export async function ensureFollowState(page: any, targetNpub: string): Promise<void> {
  await page.goto(`http://localhost:5173/#/${targetNpub}`);

  const followButton = page.getByRole('button', { name: 'Follow', exact: true });
  const followingButton = page.getByRole('button', { name: 'Following' });
  const unfollowButton = page.getByRole('button', { name: 'Unfollow' });
  const editProfileButton = page.getByRole('button', { name: 'Edit Profile' });

  await expect.poll(async () => {
    if (await followButton.isVisible().catch(() => false)) return 'follow';
    if (await followingButton.isVisible().catch(() => false)) return 'following';
    if (await unfollowButton.isVisible().catch(() => false)) return 'following';
    if (await editProfileButton.isVisible().catch(() => false)) return 'self';
    return '';
  }, { timeout: 30000, intervals: [500, 1000, 2000] }).not.toBe('');

  const currentState = await (async () => {
    if (await followButton.isVisible().catch(() => false)) return 'follow';
    if (await followingButton.isVisible().catch(() => false)) return 'following';
    if (await unfollowButton.isVisible().catch(() => false)) return 'following';
    if (await editProfileButton.isVisible().catch(() => false)) return 'self';
    return '';
  })();

  if (currentState === 'self') {
    throw new Error(`Cannot follow own profile (${targetNpub})`);
  }

  if (currentState === 'follow') {
    await followButton.click();
  }

  await expect(
    followingButton
      .or(unfollowButton)
      .or(followButton.and(page.locator('[disabled]')))
  ).toBeVisible({ timeout: 15000 });
}

export async function waitForElapsed(page: any, minMs: number): Promise<void> {
  const start = Date.now();
  await page.waitForFunction(
    ({ startMs, minWait }: { startMs: number; minWait: number }) => Date.now() - startMs >= minWait,
    { startMs: start, minWait: minMs }
  );
}

export async function createTreeWithVisibility(page: any, name: string, visibility: 'public' | 'link-visible' | 'private'): Promise<string | undefined> {
  await goToTreeList(page);
  const newFolderButton = page.getByRole('button', { name: 'New Folder' });
  await expect(newFolderButton).toBeVisible({ timeout: 30000 });
  await newFolderButton.click();

  const input = page.locator('input[placeholder="Folder name..."]');
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.fill(name);
  const modal = page.locator('.fixed.inset-0').filter({ has: input }).last();

  if (visibility !== 'public') {
    const visibilityButton = page.getByRole('button', { name: new RegExp(visibility, 'i') });
    await visibilityButton.click();
    await expect(visibilityButton).toHaveClass(/ring-accent/);
  }

  const createButton = modal.getByRole('button', { name: 'Create' });
  await expect(createButton).toBeVisible({ timeout: 10000 });
  await createButton.click().catch(async () => {
    await input.press('Enter');
  });
  await expect(page).toHaveURL(new RegExp(`${name}`), { timeout: 30000 });
  await expect(page.getByRole('button', { name: 'New File' })).toBeVisible({ timeout: 30000 });

  if (visibility === 'link-visible') {
    return waitForLinkKey(page);
  }
  return undefined;
}

export async function createFileWithContent(page: any, fileName: string, content: string): Promise<void> {
  await page.getByRole('button', { name: 'New File' }).click();
  const nameInput = page.locator('input[placeholder="File name..."]');
  await expect(nameInput).toBeVisible({ timeout: 10000 });
  await nameInput.fill(fileName);
  const modal = page.locator('.fixed.inset-0').filter({ has: nameInput }).last();
  const createButton = modal.getByRole('button', { name: 'Create' });
  await expect(createButton).toBeVisible({ timeout: 10000 });
  await createButton.click().catch(async () => {
    await nameInput.press('Enter');
  });

  const editor = page.locator('textarea');
  await expect(editor).toBeVisible({ timeout: 30000 });
  await editor.fill(content);

  const saveButton = page.getByRole('button', { name: /Save|Saved|Saving/ });
  if (await saveButton.isEnabled().catch(() => false)) {
    try {
      await saveButton.click({ timeout: 10000 });
    } catch (err) {
      console.log('[test] Save click skipped:', err);
    }
  }
  await expect(saveButton).toBeDisabled({ timeout: 30000 });

  await page.getByRole('button', { name: 'Done' }).click();
  await expect(editor).not.toBeVisible({ timeout: 30000 });
}

export async function waitForTreePublished(page: any, npub: string, treeName: string, timeoutMs: number = 30000): Promise<void> {
  await waitForRelayConnected(page, Math.min(timeoutMs, 15000));
  await flushPendingPublishes(page);
  await page.waitForFunction(
    ({ owner, tree }) => {
      const raw = localStorage.getItem('hashtree:localRootCache');
      if (!raw) return false;
      try {
        const data = JSON.parse(raw);
        const entry = data?.[`${owner}/${tree}`];
        return entry && entry.dirty === false;
      } catch {
        return false;
      }
    },
    { owner: npub, tree: treeName },
    { timeout: timeoutMs }
  );
}

export async function waitForTreeRoot(page: any, npub: string, treeName: string, timeoutMs: number = 60000): Promise<void> {
  await page.evaluate(async ({ targetNpub, targetTree, timeout }) => {
    const { waitForTreeRoot } = await import('/src/stores');
    await waitForTreeRoot(targetNpub, targetTree, timeout);
  }, { targetNpub: npub, targetTree: treeName, timeout: timeoutMs });
}

export async function waitForTreeEntry(page: any, npub: string, treeName: string, entryPath: string, timeoutMs: number = 60000): Promise<void> {
  await expect.poll(async () => {
    return page.evaluate(async ({ targetNpub, targetTree, targetPath }) => {
      try {
        const { getTreeRootSync } = await import('/src/stores');
        const { getTree } = await import('/src/store');
        const root = getTreeRootSync(targetNpub, targetTree);
        if (!root) return false;
        const tree = getTree();
        const entry = await tree.resolvePath(root, targetPath);
        return !!entry?.cid;
      } catch {
        return false;
      }
    }, { targetNpub: npub, targetTree: treeName, targetPath: entryPath });
  }, { timeout: timeoutMs, intervals: [1000, 2000, 3000] }).toBe(true);
}

export async function getTreeRootHex(page: any, npub: string, treeName: string): Promise<{ hashHex: string; keyHex: string | null }> {
  const root = await page.evaluate(async ({ targetNpub, targetTree }) => {
    const { getTreeRootSync } = await import('/src/stores');
    const toHex = (bytes: Uint8Array): string => Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    const rootCid = getTreeRootSync(targetNpub, targetTree);
    if (!rootCid?.hash) return null;
    return {
      hashHex: toHex(rootCid.hash),
      keyHex: rootCid.key ? toHex(rootCid.key) : null,
    };
  }, { targetNpub: npub, targetTree: treeName });

  if (!root) {
    throw new Error(`Could not read tree root for ${npub}/${treeName}`);
  }
  return root;
}

export async function primeTreeRootInViewer(
  page: any,
  npub: string,
  treeName: string,
  root: { hashHex: string; keyHex: string | null }
): Promise<void> {
  await page.evaluate(async ({ targetNpub, targetTree, hashHex, keyHex }) => {
    const { updateLocalRootCacheHex } = await import('/src/treeRootCache');
    const fromHex = (hex: string): Uint8Array => {
      const normalized = hex.trim().toLowerCase();
      if (!normalized || normalized.length % 2 !== 0) return new Uint8Array();
      const out = new Uint8Array(normalized.length / 2);
      for (let i = 0; i < out.length; i += 1) {
        const byte = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
        if (Number.isNaN(byte)) return new Uint8Array();
        out[i] = byte;
      }
      return out;
    };
    updateLocalRootCacheHex(targetNpub, targetTree, hashHex, keyHex ?? undefined, 'link-visible');

    const adapter = (window as any).__getWorkerAdapter?.() ?? (window as any).__workerAdapter;
    if (adapter?.setTreeRootCache) {
      await adapter.setTreeRootCache(
        targetNpub,
        targetTree,
        fromHex(hashHex),
        keyHex ? fromHex(keyHex) : undefined,
        'link-visible'
      );
    }
  }, { targetNpub: npub, targetTree: treeName, hashHex: root.hashHex, keyHex: root.keyHex });
}
