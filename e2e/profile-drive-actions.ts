import type { Page } from './fixtures';

export type MainActionMutation =
  | { type: 'write'; path: string; content: string }
  | { type: 'mkdir'; path: string }
  | { type: 'delete'; path: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'move'; path: string; directory: string };

export async function applyMainActionMutations(
  page: Page,
  mutations: MainActionMutation[],
): Promise<void> {
  await page.evaluate(async (operations: MainActionMutation[]) => {
    const {
      createFolder,
      deleteEntry,
      moveEntry,
      renameEntry,
      saveFile,
    } = await import('/src/actions/index.ts');
    for (const mutation of operations) {
      if (mutation.type === 'write') await saveFile(mutation.path, mutation.content);
      else if (mutation.type === 'mkdir') await createFolder(mutation.path);
      else if (mutation.type === 'delete') await deleteEntry(mutation.path);
      else if (mutation.type === 'rename') await renameEntry(mutation.from, mutation.to);
      else await moveEntry(mutation.path, mutation.directory);
    }
  }, mutations);
}

export async function pauseProfileDriveRootUpdates(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { clearWorkerHydrateRetry } = await import('/src/stores/treeRootWorker.ts');
    const { subscriptionState } = await import('/src/stores/treeRootShared.ts');
    const stored = JSON.parse(localStorage.getItem('iris:identity:session') ?? 'null');
    const profileId = stored?.profileId ?? '';
    if (!profileId) throw new Error('No active Drive profile id');
    const key = `${profileId}/main`;
    const state = subscriptionState.get(key);
    if (!state) throw new Error(`No resolver subscription for ${key}`);
    state.unsubscribeResolver?.();
    state.unsubscribeResolver = null;
    state.unsubscribeWorker?.();
    state.unsubscribeWorker = null;
    clearWorkerHydrateRetry(key);
    return key;
  });
}

export async function resumeProfileDriveRootUpdates(page: Page, key: string): Promise<void> {
  await page.evaluate(async (resolverKey: string) => {
    const { refreshDriveRootResolverKey } = await import('/src/stores/treeRootResolver.ts');
    refreshDriveRootResolverKey(resolverKey);
  }, key);
}
