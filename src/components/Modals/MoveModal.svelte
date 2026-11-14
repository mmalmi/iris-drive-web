<script lang="ts" module>
  /**
   * Moving a file or folder to another folder of the same Drive or shared
   * folder: go through its folders and choose where.
   */
  let show = $state(false);
  let name = $state('');
  let from = $state<string[]>([]);
  let at = $state<string[]>([]);

  /** `parentPath` is the folder the item is in now. */
  export function open(itemName: string, parentPath: string[]) {
    name = itemName;
    from = parentPath;
    at = parentPath;
    show = true;
  }

  export function close() {
    show = false;
  }
</script>

<script lang="ts">
  import { get } from 'svelte/store';
  import { LinkType } from '@hashtree/core';
  import Modal from '../ui/Modal.svelte';
  import { moveEntryTo } from '../../actions';
  import { getCurrentRootCid } from '../../actions/route';
  import { getTree } from '../../store';
  import { nostrStore } from '../../nostr';
  import { acceptedShares } from '../../drive/shareLibrary';
  import { activeNostrIdentityRootScope } from '../../drive/profileRoute';
  import { isDocumentFolderName } from '../../lib/documentNames';
  import { filterVisibleDirectoryEntries } from '../../lib/directoryEntryVisibility';
  import { parseRoute } from '../../utils/route';
  import { toast } from '../../stores/toast';

  let folders = $state<string[] | null>(null);
  let moving = $state(false);

  /** What the top of the open tree is called: My Drive, or the shared folder's name. */
  function topName(): string {
    const scope = parseRoute().npub;
    if (scope && scope === activeNostrIdentityRootScope(get(nostrStore))) return 'My Drive';
    return get(acceptedShares).find((record) => record.share_id === scope)?.folder.display_name || 'Top';
  }

  const same = (a: string[], b: string[]) => a.length === b.length && a.every((part, index) => part === b[index]);
  /** The item itself, and what is inside it, cannot hold it. */
  const isInsideItem = (path: string[]) => [...from, name].every((part, index) => path[index] === part);

  let here = $derived(at.length ? at[at.length - 1]! : topName());

  $effect(() => {
    if (!show) return;
    const path = at;
    let current = true;
    folders = null;
    void (async () => {
      const root = getCurrentRootCid();
      const tree = getTree();
      const dir = !root ? null : path.length === 0 ? { cid: root } : await tree.resolvePath(root, path.join('/'));
      const entries = dir ? await tree.listDirectory(dir.cid) : [];
      if (!current) return;
      folders = filterVisibleDirectoryEntries(entries)
        .filter((entry) => entry.type === LinkType.Dir && !isDocumentFolderName(entry.name) && !isInsideItem([...path, entry.name]))
        .map((entry) => entry.name)
        .sort((a, b) => a.localeCompare(b));
    })().catch(() => { if (current) folders = []; });
    return () => { current = false; };
  });

  async function moveHere() {
    if (moving) return;
    moving = true;
    try {
      await moveEntryTo(from, name, at);
      toast.success(`Moved ${name} to ${here}`);
      close();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not move ${name}`);
    } finally {
      moving = false;
    }
  }
</script>

<Modal open={show} onClose={close} label="Move" panelClass="bg-surface-1 rounded-lg shadow-lg w-full max-w-md mx-4 overflow-hidden">
  <div data-testid="move-dialog">
    <h2 class="px-5 pt-5 text-lg font-semibold truncate">Move “{name}”</h2>
    <div class="px-3 py-2 flex items-center gap-1 min-h-12">
      {#if at.length > 0}
        <button class="btn-circle btn-ghost h-8 w-8 min-h-8 min-w-8" title="Up" aria-label="Up" onclick={() => { at = at.slice(0, -1); }}>
          <span class="i-lucide-chevron-left text-lg"></span>
        </button>
      {/if}
      <span class="px-2 truncate font-medium text-text-1" data-testid="move-here-name">{here}</span>
    </div>
    <div class="h-64 overflow-auto border-y border-surface-2">
      {#if folders === null}
        <div class="p-4"></div>
      {:else if folders.length === 0}
        <p class="p-4 text-sm text-text-3">No folders in here</p>
      {:else}
        {#each folders as folder (folder)}
          <button
            class="w-full flex items-center gap-3 px-5 py-2.5 text-left hover:bg-surface-2"
            onclick={() => { at = [...at, folder]; }}
            data-testid="move-folder"
          >
            <span class="i-lucide-folder text-warning shrink-0"></span>
            <span class="flex-1 min-w-0 truncate">{folder}</span>
            <span class="i-lucide-chevron-right text-text-3 shrink-0"></span>
          </button>
        {/each}
      {/if}
    </div>
    <div class="flex justify-end gap-2 p-4">
      <button class="btn-ghost" onclick={close}>Cancel</button>
      <button class="btn-success" disabled={moving || same(at, from)} onclick={moveHere} data-testid="move-confirm">Move here</button>
    </div>
  </div>
</Modal>
