<script lang="ts" module>
  import { LinkType, type TreeEntry } from '@hashtree/core';
  import { deleteEntries } from '../actions';
  import { documentKindInfo, documentTitle } from '../lib/documentNames';
  import { toast } from '../stores/toast';

  const isDocument = (entry: TreeEntry) => entry.type === LinkType.Dir && !!documentKindInfo(entry.name);
  const title = (entry: TreeEntry) => (isDocument(entry) ? documentTitle(entry.name) : entry.name);

  /** Deletes the chosen items of the open folder, with Undo; `onDeleting` lets go of them. */
  export async function deleteChosen(items: TreeEntry[], onDeleting: () => void): Promise<void> {
    if (items.length === 0) return;
    onDeleting();
    await deleteEntries(items.map((entry) => entry.name))
      .catch(error => toast.error(error instanceof Error ? error.message : items.length === 1 ? `Could not delete ${title(items[0])}` : `Could not delete ${items.length} items`));
  }
</script>

<script lang="ts">
  /**
   * In place of a list's columns while items of it are chosen: how
   * many, and Move, Download (one ZIP for several) and Delete for them all,
   * by the same actions as a row's menu. Changes to the Drive are made one at
   * a time, each from the latest Drive.
   */
  import { open as openMoveModal } from './Modals/MoveModal.svelte';
  import { downloadEntriesZip, downloadFile, downloadFolderZip } from '../lib/downloadEntry';

  interface Props {
    /** What is chosen. */
    entries: TreeEntry[];
    /** The folder they are in. */
    path: string[];
    canEdit: boolean;
    /** What a ZIP of several is called. */
    zipName: string;
    /** Lets go of them all, and gives the keyboard back to the list. */
    onClear: () => void;
    /** Where the keyboard goes when what it was on has gone. */
    list: HTMLElement | undefined;
  }

  let { entries, path, canEdit, zipName, onClear, list }: Props = $props();

  /** Documents are opened, not downloaded. */
  let downloadable = $derived(entries.filter((entry) => !isDocument(entry)));

  function move(e: MouseEvent) {
    const button = e.currentTarget as HTMLElement;
    openMoveModal(entries.map((entry) => entry.name), path, () => {
      // Back to the button, or to the list once what was chosen has gone.
      (button.isConnected ? button : list)?.focus();
    });
  }

  // Escape lets go of them all, unless a dialog, a menu or a field has it.
  function onWindowKeyDown(e: KeyboardEvent) {
    if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('dialog[open], [aria-modal="true"]')) return;
    if (e.target instanceof Element && e.target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
    e.preventDefault();
    onClear();
  }

  async function download() {
    const items = downloadable;
    try {
      if (items.length === 1 && items[0].type !== LinkType.Dir) await downloadFile(items[0]);
      else if (items.length === 1) await downloadFolderZip(items[0].cid, items[0].name);
      else if (items.length > 1) await downloadEntriesZip(items, zipName);
    } catch (error) {
      console.warn('[Drive] Could not download:', error);
      toast.error('Could not download what was chosen');
    }
  }
</script>

<svelte:window onkeydown={onWindowKeyDown} />

{#snippet action(label: string, icon: string, testid: string, run: (e: MouseEvent) => void, disabled = false, danger = false)}
  <button
    type="button"
    class="shrink-0 flex items-center gap-2 h-8 px-2.5 rounded-full b-0 bg-transparent cursor-pointer hover:bg-surface-3 disabled:opacity-50 disabled:cursor-not-allowed {danger ? 'text-danger' : 'text-text-1'}"
    title={label}
    aria-label={label}
    data-testid={testid}
    {disabled}
    onclick={run}
  >
    <span class="{icon} text-lg"></span>
    <span class="hidden md:inline text-sm font-medium">{label}</span>
  </button>
{/snippet}

<div
  class="folder-selection-bar flex flex-1 min-w-0 items-center gap-1 px-1.5 lg:px-3 text-base"
  data-testid="selection-bar"
>
  <button
    type="button"
    class="btn-circle h-8 w-8 min-h-8 min-w-8 shrink-0 b-0 bg-transparent cursor-pointer text-text-2 hover:text-text-1 hover:bg-surface-3"
    title="Clear selection (Esc)"
    aria-label="Clear selection"
    data-testid="selection-clear"
    onclick={onClear}
  >
    <span class="i-lucide-x text-lg"></span>
  </button>
  <span class="min-w-0 flex-1 truncate font-medium text-text-1" data-testid="selection-count">{entries.length} selected</span>
  {#if canEdit}{@render action('Move', 'i-lucide-folder-input', 'selection-move', move)}{/if}
  {@render action('Download', 'i-lucide-download', 'selection-download', () => void download(), downloadable.length === 0)}
  {#if canEdit}{@render action('Delete', 'i-lucide-trash-2', 'selection-delete', () => void deleteChosen(entries, onClear), false, true)}{/if}
</div>
