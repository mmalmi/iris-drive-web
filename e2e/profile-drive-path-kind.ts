import { expect, type Page } from './fixtures';
import type { MainActionMutation } from './profile-drive-actions';

type VisiblePrefixSnapshot = {
  topLevel: Array<{ name: string; isDirectory: boolean }>;
  fileContents: string[];
};

type PathKindActionScenario = {
  owner: Page;
  linked: Page;
  gotoMain: (page: Page) => Promise<void>;
  mutateAndPublish: (page: Page, mutations: MainActionMutation[]) => Promise<void>;
  expectFileContent: (page: Page, path: string, content: string) => Promise<void>;
};

/**
 * Exercise both path-kind replacement directions through the production Web
 * action layer on two linked AppKeys. The losing bytes must remain visible as
 * stable conflict copies through later publishes and path recreation.
 */
export async function expectProfilePathKindActionConvergence({
  owner,
  linked,
  gotoMain,
  mutateAndPublish,
  expectFileContent,
}: PathKindActionScenario): Promise<void> {
  await mutateAndPublish(owner, [{
    type: 'write',
    path: 'kind-folder/old.txt',
    content: 'folder bytes preserved as conflict',
  }]);
  await gotoMain(linked);
  await expectFileContent(linked, 'kind-folder/old.txt', 'folder bytes preserved as conflict');
  await mutateAndPublish(linked, [{
    type: 'write',
    path: 'kind-folder',
    content: 'file replacing folder',
  }]);
  await gotoMain(owner);
  const folderReplacementShape = (snapshot: VisiblePrefixSnapshot) => (
    snapshot.topLevel.length === 2
      && snapshot.topLevel.some((entry) => entry.name === 'kind-folder' && !entry.isDirectory)
      && snapshot.topLevel.some((entry) => entry.name !== 'kind-folder' && entry.isDirectory)
  );
  const folderReplacementConverged = (snapshot: VisiblePrefixSnapshot) => (
    folderReplacementShape(snapshot)
      && snapshot.fileContents.join('|')
        === ['file replacing folder', 'folder bytes preserved as conflict'].sort().join('|')
  );
  await expectVisiblePrefix(owner, 'kind-folder', folderReplacementConverged);

  // Let the replacing browser consume the materialized conflict before its
  // next contribution. Republishing that logical view must reuse the existing
  // conflict copy rather than adding a numbered duplicate.
  await gotoMain(linked);
  await expectUiConflictShape(linked, 'kind-folder');
  await mutateAndPublish(linked, [{
    type: 'write',
    path: 'after-kind-folder.txt',
    content: 'unrelated publish keeps one conflict copy',
  }]);
  await gotoMain(owner);
  await expectVisiblePrefix(owner, 'kind-folder', folderReplacementConverged);
  await expectFileContent(
    owner,
    'after-kind-folder.txt',
    'unrelated publish keeps one conflict copy',
  );

  await gotoMain(linked);
  await mutateAndPublish(linked, [{ type: 'delete', path: 'kind-folder' }, {
    type: 'write',
    path: 'kind-folder',
    content: 'recreated file keeps one old conflict copy',
  }]);
  await gotoMain(owner);
  await expectVisiblePrefix(owner, 'kind-folder', (snapshot) => (
    folderReplacementShape(snapshot)
      && snapshot.fileContents.join('|')
        === [
          'folder bytes preserved as conflict',
          'recreated file keeps one old conflict copy',
        ].sort().join('|')
  ));

  await mutateAndPublish(owner, [{
    type: 'write',
    path: 'kind-file',
    content: 'file bytes preserved as conflict',
  }]);
  await gotoMain(linked);
  await expectFileContent(linked, 'kind-file', 'file bytes preserved as conflict');
  await mutateAndPublish(linked, [{ type: 'mkdir', path: 'kind-file' }]);
  await gotoMain(owner);
  const fileReplacementShape = (snapshot: VisiblePrefixSnapshot) => (
    snapshot.topLevel.length === 2
      && snapshot.topLevel.some((entry) => entry.name === 'kind-file' && entry.isDirectory)
      && snapshot.topLevel.some((entry) => entry.name !== 'kind-file' && !entry.isDirectory)
  );
  const fileReplacementConverged = (snapshot: VisiblePrefixSnapshot) => (
    fileReplacementShape(snapshot)
      && snapshot.fileContents.join('|') === 'file bytes preserved as conflict'
  );
  await expectVisiblePrefix(owner, 'kind-file', fileReplacementConverged);
  await gotoMain(linked);
  await expectUiConflictShape(linked, 'kind-file');
  await mutateAndPublish(linked, [{
    type: 'write',
    path: 'after-kind-file.txt',
    content: 'unrelated publish keeps one file conflict',
  }]);
  await gotoMain(owner);
  await expectVisiblePrefix(owner, 'kind-file', fileReplacementConverged);
}

async function expectUiConflictShape(page: Page, prefix: string): Promise<void> {
  const matching = page.getByRole('listbox', { name: 'File list' })
    .getByRole('link')
    .filter({ hasText: prefix });
  await expect(matching).toHaveCount(2, { timeout: 60000 });
  await expect(matching.filter({ hasText: `${prefix} (conflict from ` }))
    .toHaveCount(1, { timeout: 60000 });
}

async function expectVisiblePrefix(
  page: Page,
  prefix: string,
  expected: (snapshot: VisiblePrefixSnapshot) => boolean,
): Promise<void> {
  let latest: VisiblePrefixSnapshot | null = null;
  try {
    await expect.poll(
      async () => {
        latest = await readVisiblePrefix(page, prefix);
        return expected(latest);
      },
      { timeout: 60000, intervals: [500, 1000, 2000, 3000] },
    ).toBe(true);
  } catch (error) {
    throw new Error(
      `Visible ${prefix} state did not converge; last snapshot: ${JSON.stringify(latest)}\n${String(error)}`,
    );
  }
}

async function readVisiblePrefix(page: Page, prefix: string): Promise<VisiblePrefixSnapshot> {
  return page.evaluate(async (targetPrefix: string) => {
    const { getTree, LinkType } = await import('/src/store.ts');
    const { directoryEntriesStore } = await import('/src/stores/directoryEntries.ts');
    let entries: Array<{
      name: string;
      cid: { hash: Uint8Array; key?: Uint8Array };
      type: number;
    }> = [];
    const unsubscribe = directoryEntriesStore.subscribe((state) => { entries = state.entries; });
    unsubscribe();

    const tree = getTree();
    const fileContents: string[] = [];
    const visit = async (entry: typeof entries[number]): Promise<void> => {
      if (entry.type !== LinkType.Dir) {
        const bytes = await tree.readFile(entry.cid);
        if (bytes) fileContents.push(new TextDecoder().decode(bytes));
        return;
      }
      for (const child of await tree.listDirectory(entry.cid)) await visit(child);
    };
    const matching = entries.filter((entry) => entry.name.startsWith(targetPrefix));
    for (const entry of matching) await visit(entry);
    return {
      topLevel: matching.map((entry) => ({
        name: entry.name,
        isDirectory: entry.type === LinkType.Dir,
      })).sort((left, right) => left.name.localeCompare(right.name)),
      fileContents: fileContents.sort(),
    };
  }, prefix);
}
