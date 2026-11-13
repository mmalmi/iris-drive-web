<script lang="ts">
  /** Find, and for those who may edit, replace: a small box over the corner of the grid. */
  import { onMount } from 'svelte';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { findNext, findPosition, replaceAll, replaceOne } from '../../lib/sheets/dataCommands';

  interface Props {
    ctl: SheetController;
  }
  let { ctl }: Props = $props();

  let input: HTMLInputElement | undefined = $state();
  let find = $derived(ctl.find);
  let matches = $derived(ctl.findMatches);
  let position = $derived.by(() => {
    void ctl.active;
    return findPosition(ctl);
  });

  onMount(() => {
    input?.focus();
    input?.select();
  });

  function setQuery(query: string): void {
    if (!find) return;
    ctl.find = { ...find, query };
    // Show the first match at once, without leaving it while more is typed.
    if (ctl.findMatches.length > 0 && findPosition(ctl) === 0) findNext(ctl);
  }

  function close(): void {
    ctl.find = null;
    ctl.focusGrid();
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') close();
    else if (event.key === 'Enter') findNext(ctl, event.shiftKey);
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') input?.select();
    else {
      event.stopPropagation();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }
</script>

{#if find}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div class="find" role="search" data-testid="sheet-find" {onkeydown}>
    <div class="line">
      <input
        bind:this={input}
        value={find.query}
        oninput={event => setQuery(event.currentTarget.value)}
        placeholder="Find in sheet"
        aria-label="Find in sheet"
        spellcheck="false"
        data-testid="sheet-find-input"
      />
      <span class="count" data-testid="sheet-find-count">
        {#if find.query !== ''}{matches.length === 0 ? 'None' : `${position || '–'} of ${matches.length}`}{/if}
      </span>
      <button type="button" class="icon" onclick={() => findNext(ctl, true)} disabled={matches.length === 0} title="Previous" aria-label="Previous">
        <span class="i-lucide-chevron-up"></span>
      </button>
      <button type="button" class="icon" onclick={() => findNext(ctl)} disabled={matches.length === 0} title="Next" aria-label="Next" data-testid="sheet-find-next">
        <span class="i-lucide-chevron-down"></span>
      </button>
      {#if ctl.canEdit}
        <button
          type="button"
          class="icon"
          class:on={find.replace !== null}
          onclick={() => { ctl.find = { ...find, replace: find.replace === null ? '' : null }; }}
          title="Replace"
          aria-label="Replace"
          aria-pressed={find.replace !== null}
          data-testid="sheet-find-toggle-replace"
        >
          <span class="i-lucide-replace"></span>
        </button>
      {/if}
      <button type="button" class="icon" onclick={close} title="Close" aria-label="Close" data-testid="sheet-find-close">
        <span class="i-lucide-x"></span>
      </button>
    </div>
    {#if find.replace !== null && ctl.canEdit}
      <div class="line">
        <input
          value={find.replace}
          oninput={event => { ctl.find = { ...find, replace: event.currentTarget.value }; }}
          placeholder="Replace with"
          aria-label="Replace with"
          spellcheck="false"
          data-testid="sheet-replace-input"
        />
        <button type="button" class="text" onclick={() => replaceOne(ctl)} disabled={matches.length === 0} data-testid="sheet-replace-one">Replace</button>
        <button type="button" class="text" onclick={() => replaceAll(ctl)} disabled={matches.length === 0} data-testid="sheet-replace-all">All</button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .find {
    position: absolute;
    z-index: 4;
    top: 30px;
    right: 14px;
    width: min(360px, calc(100% - 20px));
    padding: 6px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 8px;
    background: rgb(var(--surface-1));
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.2);
    font-size: 0.82rem;
    color: rgb(var(--text-1));
  }

  .line {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .line + .line {
    margin-top: 6px;
  }

  input {
    flex: 1;
    min-width: 0;
    height: 30px;
    padding: 0 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: rgb(var(--surface-0));
    color: inherit;
    font-size: inherit;
    outline: none;
  }

  input:focus {
    border-color: #916dfe;
  }

  .count {
    flex: none;
    min-width: 54px;
    padding: 0 6px;
    text-align: center;
    color: rgb(var(--text-2));
    white-space: nowrap;
  }

  .icon,
  .text {
    flex: none;
    height: 30px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .icon {
    width: 30px;
    font-size: 1rem;
  }

  .text {
    padding: 0 10px;
    margin-left: 4px;
    background: rgb(var(--surface-2));
    font-size: inherit;
  }

  .icon:hover:not(:disabled),
  .text:hover:not(:disabled) {
    background: rgb(var(--surface-3));
  }

  .icon.on {
    background: rgb(145 109 254 / 0.18);
    color: #916dfe;
  }

  .icon:disabled,
  .text:disabled {
    opacity: 0.35;
    cursor: default;
  }
</style>
