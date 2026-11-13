<script lang="ts">
  /**
   * The bar above a document, spreadsheet or presentation: the way back, the
   * title, whether it is saved, and sharing and deleting. Buttons that only
   * one kind has go in as children, before Share.
   */
  import type { Snippet } from 'svelte';
  import type { DriveDocument } from '../../lib/yjs';

  interface Props {
    drive: DriveDocument;
    children?: Snippet;
  }
  let { drive, children }: Props = $props();

  let saveStatus = $derived(drive.saveStatus);
  let noun = $derived(drive.kind.noun);
</script>

<div class="shrink-0 h-12 px-2 sm:px-4 border-b border-surface-2 flex items-center gap-2 bg-surface-1">
  <a href={drive.backHref} class="btn-circle btn-ghost shrink-0 no-underline" title="Back to folder" aria-label="Back to folder">
    <span class="i-lucide-arrow-left text-base"></span>
  </a>
  <span class="{drive.kind.icon} shrink-0"></span>
  <h1 class="text-sm font-semibold text-text-1 truncate min-w-0" data-testid="document-title">{drive.title}</h1>
  {#if !drive.canEdit && !drive.loading}
    <span class="shrink-0 text-xs px-2 py-0.5 rounded-full bg-surface-2 text-text-2" data-testid="document-view-only">View only</span>
  {/if}

  <div class="ml-auto flex items-center gap-1 shrink-0">
    <!-- Saving happens on its own; only its outcome is worth a glance. -->
    <span class="text-xs text-text-3 flex items-center gap-1 mr-1" role="status" data-testid="document-save-status" data-state={saveStatus}>
      {#if saveStatus === 'saving' || saveStatus === 'unsaved' || saveStatus === 'saved'}
        <span class="i-lucide-cloud-check text-base" title={saveStatus === 'saved' ? 'Saved' : 'Saving'}></span>
      {:else if saveStatus === 'error'}
        <span class="text-danger flex items-center gap-1"><span class="i-lucide-triangle-alert"></span>Not saved, retrying</span>
      {:else if saveStatus === 'other-tab'}
        Open in another tab
      {/if}
    </span>
    {@render children?.()}
    <button onclick={() => void drive.share()} class="btn-circle btn-ghost" title="Share" aria-label="Share" data-testid="document-share">
      <span class="i-lucide-share text-base"></span>
    </button>
    {#if drive.canEdit}
      <button onclick={() => void drive.delete()} class="btn-circle btn-ghost" title="Delete {noun}" aria-label="Delete {noun}" data-testid="document-delete">
        <span class="i-lucide-trash-2 text-base"></span>
      </button>
    {/if}
  </div>
</div>
