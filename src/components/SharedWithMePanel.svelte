<script lang="ts">
  import {
    nativeShareActionEndpoint,
    type NativeSharedFolderView,
  } from '../drive/nativeShareActions';
  import {
    applyNativeShareActionResult,
    nativeShares as nativeShareStore,
    refreshNativeShareState,
  } from '../drive/nativeShareState';
  import type { SharedFolderView } from '../drive/protocol';
  import { addShareShortcutThroughCore } from '../drive/shareInviteActions';
  import {
    acceptedShares,
    addShareShortcut,
    projectAcceptedShareViews,
  } from '../drive/shareLibrary';
  import { toast } from '../stores/toast';

  interface Props {
    standalone?: boolean;
  }

  let { standalone = false }: Props = $props();

  type SharedWithMeRow = NativeSharedFolderView | SharedFolderView;

  let nativeActionEndpoint = $derived(nativeShareActionEndpoint());
  let shareActionPending = $state('');
  let localShareViews = $derived(projectAcceptedShareViews($acceptedShares).map((share) => share.view));
  let shares = $derived.by((): SharedWithMeRow[] => (
    nativeActionEndpoint ? $nativeShareStore : localShareViews
  ));

  $effect(() => {
    if (!nativeActionEndpoint) return;
    void refreshNativeShareState().catch(() => undefined);
  });

  async function handleAddShortcut(shareId: string) {
    if (shareActionPending) return;
    shareActionPending = shareId;
    try {
      if (nativeActionEndpoint) {
        applyNativeShareActionResult(await addShareShortcutThroughCore(shareId));
      } else if (!addShareShortcut(shareId)) {
        return;
      }
      toast.success('Shortcut added');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add shortcut');
    } finally {
      shareActionPending = '';
    }
  }

  function roleLabel(share: SharedWithMeRow): string {
    if ('local_role_label' in share && share.local_role_label) return share.local_role_label;
    if ('role_label' in share && share.role_label) return share.role_label;
    return labelText(share.local_role);
  }

  function keyStatusLabel(share: SharedWithMeRow): string {
    if ('key_status_label' in share && share.key_status_label) return share.key_status_label;
    return labelText(share.key_status);
  }

  function participantText(share: SharedWithMeRow): string {
    return `${share.participant_count} ${share.participant_count === 1 ? 'person' : 'people'}`;
  }

  function repairText(share: SharedWithMeRow): string {
    if (!share.repair_needed) return '';
    if (share.missing_key_wrap_count > 0) {
      const noun = share.missing_key_wrap_count === 1 ? 'access wrap' : 'access wraps';
      return `${share.missing_key_wrap_count} missing ${noun}`;
    }
    return 'repair needed';
  }

  function labelText(value: string): string {
    return value
      .split('_')
      .map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part)
      .join(' ');
  }
</script>

{#if shares.length > 0 || standalone}
  <section class={standalone ? 'rounded-xl border border-surface-2 overflow-hidden' : 'mx-3 mt-3 rounded border border-surface-2 bg-surface-1/70'} data-testid="shared-with-me-panel">
    <div class="h-11 px-4 flex items-center gap-2 border-b border-surface-2 bg-surface-1/70">
      <span class="i-lucide-folder-key text-accent"></span>
      <span class="text-sm font-medium text-text-2">Shared with me</span>
    </div>
    <div class="divide-y divide-surface-2 bg-surface-0">
      {#if shares.length === 0}
        <div class="px-4 py-10 text-center text-sm text-text-3">
          Folders shared with you will appear here.
        </div>
      {/if}
      {#each shares as share (share.share_id)}
        <div class="px-3 py-2 flex items-center gap-3" data-testid="shared-with-me-row">
          <span class="i-lucide-folder text-warning shrink-0"></span>
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-text-1 truncate">{share.display_name}</div>
            {#if share.source_path}
              <div class="text-xs text-text-3 truncate">{share.source_path}</div>
            {/if}
            <div class="text-xs text-text-3 truncate">
              {roleLabel(share)} · {keyStatusLabel(share)} · {participantText(share)}
              {#if share.repair_needed}
                · {repairText(share)}
              {/if}
            </div>
            {#if share.shortcut_paths.length > 0}
              <div class="text-xs text-text-3 truncate">
                {share.shortcut_paths[0]}
              </div>
            {/if}
          </div>
          {#if share.shortcut_paths.length === 0}
            <button
              class="btn-ghost h-8 w-8 min-h-8 min-w-8 p-0"
              title="Add shortcut to My Drive"
              aria-label="Add shortcut to My Drive"
              data-testid="shared-with-me-add-shortcut"
              disabled={Boolean(shareActionPending)}
              onclick={() => handleAddShortcut(share.share_id)}
            >
              <span class="i-lucide-plus text-base"></span>
            </button>
          {:else}
            <span class="i-lucide-check text-success shrink-0" title="Shortcut added"></span>
          {/if}
        </div>
      {/each}
    </div>
  </section>
{/if}
