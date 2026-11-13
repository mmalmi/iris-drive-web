import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page } from './fixtures';
import { parseNostrIdentityRosterOpEvent } from '../src/drive/protocolProfileEvents';
import { clearAllStorage, configureBlossomServers, flushPendingPublishes, presetLocalRelayInDB, waitForAppReady, waitForRelayConnected } from './test-utils';

export async function waitForSharedFolderPublished(
  page: Page,
  shareId: string,
  /** What the folder's top level must (or must not) list first: a change the page shows can still be on its way to being saved. */
  expected: { has?: string[]; lacks?: string[] } = {},
) {
  if (expected.has?.length || expected.lacks?.length) {
    await page.waitForFunction(async ({ id, has, lacks }) => {
      const { getTreeRootSync } = await import('/src/stores/treeRoot.ts');
      const { getTree } = await import('/src/store.ts');
      const root = getTreeRootSync(id, 'main');
      if (!root) return false;
      const names = new Set((await getTree().listDirectory(root)).map(entry => entry.name));
      return has.every(name => names.has(name)) && lacks.every(name => !names.has(name));
    }, { id: shareId, has: expected.has ?? [], lacks: expected.lacks ?? [] }, { timeout: 30_000 });
  }
  await flushPendingPublishes(page);
  // Flushing timers can race an already-running upload. Observe durable publish
  // completion for this folder before another client performs a one-shot sync.
  await page.waitForFunction(async (id) => {
    const { treeRootRegistry } = await import('/src/TreeRootRegistry.ts');
    const record = treeRootRegistry.getByKey(`${id}/main`);
    return record && !record.dirty;
  }, shareId, { timeout: 30_000 });
}

export async function openProfile(page: Page, configDir: string, relayUrl: string) {
  const key = fs.readFileSync(path.join(configDir, 'key'), 'utf8').trim();
  const roster = JSON.parse(fs.readFileSync(path.join(configDir, 'profile-roster-events.json'), 'utf8'));
  const session = { schema: 1, profileId: roster.profile_id, appKeyNsec: key, status: 'active',
    rosterOps: roster.events.map((event: string) => parseNostrIdentityRosterOpEvent(JSON.parse(event))),
    createdAt: Math.floor(Date.now() / 1000) };
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') console.log('browser:', message.text().slice(0, 450)); });
  page.on('pageerror', (error) => console.log('page error:', error.message));
  await page.addInitScript(() => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
    delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
  await page.goto('/');
  const url = new URL(page.url());
  url.hostname = 'drive.localhost';
  await page.goto(url.origin);
  await clearAllStorage(page);
  await presetLocalRelayInDB(page, relayUrl);
  await page.evaluate(({ key, session }) => {
    localStorage.setItem('hashtree:disableTestAutoCreate', '1');
    localStorage.setItem('hashtree:loginType', 'nsec');
    localStorage.setItem('hashtree:nsec', key);
    localStorage.setItem('iris:identity:session', JSON.stringify(session));
  }, { key, session });
  await page.reload();
  await waitForAppReady(page);
  await configureBlossomServers(page);
  await waitForRelayConnected(page);
}

export async function acceptAndOpen(page: Page, invite: string) {
  expect(invite).toMatch(/^https:\/\/drive\.iris\.to\/#\/share-invite\/nhash1/);
  const reference = invite.split('/share-invite/')[1]!;
  expect(reference).toMatch(/^nhash1/);
  expect(invite.length).toBeLessThan(180);
  await page.goto(`${new URL(page.url()).origin}/#/share-invite/${reference}`);
  await expect(page.getByTestId('share-invite-accept')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('share-invite-accept').click();
  await page.getByTestId('share-invite-open').click();
  await expect(page.getByRole('link', { name: /^Plan\.txt\b/ })).toBeVisible({ timeout: 30_000 });
}

