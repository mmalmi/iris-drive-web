<script lang="ts">
  /**
   * The bar above a document, spreadsheet or presentation: the way back, the
   * title, whether it is saved, and sharing and deleting. Buttons that only
   * one kind has go in as children, before Share.
   */
  import type { Snippet } from 'svelte';
  import type { DriveDocument } from '../../lib/yjs';
  import { showToast } from '../../stores/toast';
  import AccessBadge from '../AccessBadge.svelte';

  interface Props {
    drive: DriveDocument;
    children?: Snippet;
  }
  let { drive, children }: Props = $props();

  let saveStatus = $derived(drive.saveStatus);
  let noun = $derived(drive.kind.noun);

  // The title is renamed where it is shown: click, type, Enter.
  let renaming = $state(false);
  let titleField: HTMLInputElement | undefined = $state();

  $effect(() => {
    if (!renaming || !titleField) return;
    titleField.focus();
    titleField.select();
  });

  async function finishRename(): Promise<void> {
    if (!renaming || !titleField) return;
    const title = titleField.value.trim();
    renaming = false;
    if (!title || title === drive.title) return;
    if (title.includes('/')) {
      showToast('error', 'A name cannot have / in it.');
      return;
    }
    try {
      if (!await drive.rename(title)) showToast('error', `There is already something named "${title}" here.`);
    } catch {
      showToast('error', `Could not rename the ${noun}.`);
    }
  }

  function onTitleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void finishRename();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      renaming = false;
    }
  }
</script>

<div class="shrink-0 h-12 px-2 sm:px-4 border-b border-surface-2 flex items-center gap-2 bg-surface-1">
  <a href={drive.backHref} class="btn-circle btn-ghost shrink-0 no-underline" title="Back to folder" aria-label="Back to folder">
    <span class="i-lucide-arrow-left text-base"></span>
  </a>
  <span class="{drive.kind.icon} shrink-0"></span>
  {#if renaming}
    <input
      bind:this={titleField}
      value={drive.title}
      onkeydown={onTitleKeyDown}
      onblur={() => void finishRename()}
      class="title-field text-sm font-semibold"
      aria-label="Name"
      autocomplete="off"
      spellcheck="false"
      data-testid="document-title-input"
    />
  {:else if drive.canEdit && !drive.loading}
    <h1 class="text-sm font-semibold text-text-1 min-w-0 flex" data-testid="document-title">
      <button type="button" class="title-button truncate" onclick={() => { renaming = true; }} title="Rename">{drive.title}</button>
    </h1>
  {:else}
    <h1 class="text-sm font-semibold text-text-1 truncate min-w-0" data-testid="document-title">{drive.title}</h1>
  {/if}
  {#if !drive.canEdit && !drive.loading}
    <span class="shrink-0 text-xs px-2 py-0.5 rounded-full bg-surface-2 text-text-2" data-testid="document-view-only">View only</span>
  {/if}
  <AccessBadge access={drive.access} label onclick={drive.canEdit ? () => void drive.share() : undefined} />

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

<style>
  .title-button {
    min-width: 0;
    max-width: 100%;
    padding: 2px 6px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: text;
  }

  .title-button:hover {
    border-color: rgb(var(--surface-3));
  }

  .title-field {
    min-width: 0;
    width: 18rem;
    max-width: 50vw;
    height: 30px;
    padding: 0 6px;
    border: 1px solid #916dfe;
    border-radius: 6px;
    background: rgb(var(--surface-0));
    color: rgb(var(--text-1));
    outline: none;
  }

  /* Smaller text makes phones zoom in on the field. */
  @media (max-width: 640px) {
    .title-field {
      font-size: 16px;
    }
  }
</style>
