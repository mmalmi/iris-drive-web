<script lang="ts">
  /**
   * When a row of a folder's list last changed, and a file's size: in
   * columns on a wide screen, and on a phone or beside an open file in a
   * line under the name. Screen readers hear the line as the row's
   * description, by its `id`, so the row's name stays its name.
   */
  import { LinkType, type TreeEntry } from '@hashtree/core';
  import { formatBytes } from '../store';
  import { describeModified, formatModified, modifiedAt } from '../lib/modifiedAt';

  interface Props {
    entry: TreeEntry;
    /** Where the line goes: under the name, or the columns at the end. */
    part: 'line' | 'columns';
    /** Beside an open file: only the line, always. */
    compact: boolean;
    id?: string;
  }

  let { entry, part, compact, id }: Props = $props();

  let modified = $derived(modifiedAt(entry));
  let isFile = $derived(entry.type !== LinkType.Dir);
  let line = $derived([modified ? formatModified(modified) : '', isFile ? formatBytes(entry.size) : ''].filter(Boolean).join(' · '));
</script>

{#if part === 'line'}
  {#if line}
    <span {id} class="truncate text-xs text-text-3 {compact ? '' : 'sm:hidden'}" aria-hidden="true" data-testid="row-details">{line}</span>
  {/if}
{:else if !compact}
  <span class="hidden sm:block shrink-0 w-32 truncate text-sm text-text-3" aria-hidden="true" data-testid="row-modified">
    {#if modified}<time datetime={new Date(modified * 1000).toISOString()} title={describeModified(modified)}>{formatModified(modified)}</time>{/if}
  </span>
  <span class="hidden sm:block shrink-0 w-20 text-right text-sm text-text-3" aria-hidden="true" data-testid="row-size">{isFile ? formatBytes(entry.size) : '—'}</span>
{/if}
