<script lang="ts">
  import { LinkType } from '@hashtree/core';
  import { nostrStore } from '../nostr';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { acceptedShares } from '../drive/shareLibrary';
  import { documentTitle } from '../lib/documentNames';
  import { listTrash, watchTrash, type TrashItem } from '../lib/driveTrash';
  import { hasTrashAccess, restoreTrashItems } from '../actions/entry';
  import { toast } from '../stores/toast';

  let account = $derived($nostrStore.isLoggedIn ? activeNostrIdentityRootScope($nostrStore) ?? $nostrStore.npub : null);
  let rows = $state<TrashItem[]>([]);
  let visibleRows = $derived(rows.filter(item => hasTrashAccess(item.account, item.scope, $nostrStore, $acceptedShares)));
  let status = $state('');
  let restoring = $state<string | null>(null);

  $effect(() => {
    const owner = account;
    let generation = 0;
    rows = [];
    status = owner ? 'Loading…' : 'Sign in to see Trash.';
    if (!owner) return;
    const refresh = async () => {
      const turn = ++generation;
      try {
        const found = await listTrash(owner);
        if (turn !== generation) return;
        rows = found;
        status = '';
      } catch {
        if (turn === generation) status = 'Could not load Trash.';
      }
    };
    const unsubscribe = watchTrash(refresh);
    void refresh();
    return () => { generation++; unsubscribe(); };
  });

  function driveName(item: TrashItem): string {
    if (item.scope === account && item.treeName === 'main') return 'My Drive';
    return $acceptedShares.find(record => record.share_id === item.scope && record.local_profile_id === account)?.folder.display_name ?? item.treeName;
  }

  function itemTitle(item: TrashItem, name: string): string {
    return item.entry.type === LinkType.Dir ? documentTitle(name) : name;
  }

  async function restore(item: TrashItem) {
    if (restoring) return;
    restoring = item.id;
    try {
      const restored = await restoreTrashItems(item.account, [item.id]);
      const path = restored.get(item.id);
      const name = path?.at(-1);
      if (path && name) {
        const folder = [driveName(item), ...path.slice(0, -1)].join(' / ');
        toast.success(`Restored “${itemTitle(item, name)}” to ${folder}`);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not restore the item');
    } finally {
      restoring = null;
    }
  }
</script>

<main class="flex-1 min-w-0 flex flex-col bg-surface-0" data-drive-undo data-testid="trash-route">
  <header class="shrink-0 border-b border-surface-2 px-3 py-3 lg:px-5">
    <h1 class="m-0 flex items-center gap-2 text-base lg:text-xl font-medium text-text-1"><span class="i-lucide-trash-2 text-accent"></span>Trash</h1>
    <p class="mt-1 mb-0 text-sm text-text-3">Items deleted in this browser stay here for 30 days.</p>
  </header>
  <div class="flex-1 overflow-auto">
    {#each visibleRows as item (item.id)}
      {@const name = itemTitle(item, item.entry.name)}
      {@const place = driveName(item)}
      <div class="flex items-center gap-3 border-b border-surface-2 px-3 py-2.5 lg:px-5" data-testid="trash-item">
        <div class="flex-1 min-w-0">
          <div class="truncate text-sm font-medium text-text-1">{name}</div>
          <div class="truncate text-xs text-text-3">{[place, ...item.path].join(' / ')} · {new Date(item.deletedAt).toLocaleDateString()}</div>
        </div>
        <button class="btn-ghost text-sm" aria-label={`Restore ${name}`} disabled={!!restoring} onclick={() => void restore(item)}>{restoring === item.id ? 'Restoring…' : 'Restore'}</button>
      </div>
    {:else}
      <p class="px-4 py-12 text-center text-sm text-text-3" role="status">{status || 'Trash is empty.'}</p>
    {/each}
  </div>
</main>
