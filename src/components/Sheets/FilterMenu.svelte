<script lang="ts">
  /** What one column of the filter shows: sorting, a condition, and a tick for each value. */
  import { onMount } from 'svelte';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { setColumnFilter, sortFiltered } from '../../lib/sheets/dataCommands';
  import { CONDITION_LABELS, columnChoices, type ColumnFilter, type ConditionKind } from '../../lib/sheets/filter';

  interface Props {
    ctl: SheetController;
    colId: string;
    x: number;
    y: number;
    onclose: () => void;
  }
  let { ctl, colId, x, y, onclose }: Props = $props();

  const MOST_SHOWN = 400;
  const KINDS = Object.keys(CONDITION_LABELS) as ConditionKind[];

  let element: HTMLDivElement | undefined = $state();
  let left = $state(0);
  let top = $state(0);
  let placed = $state(false);
  let search = $state('');

  let column = $derived<ColumnFilter>(ctl.filter?.columns.get(colId) ?? { excluded: new Set(), condition: null });
  let choices = $derived.by(() => {
    void ctl.revision;
    const filter = ctl.filter;
    return filter ? columnChoices(ctl.sheet, ctl.engine, filter, colId) : [];
  });
  let listed = $derived(choices.filter(choice => choice.text.toLowerCase().includes(search.trim().toLowerCase())));
  let kind = $derived(column.condition?.kind ?? '');
  let needsValue = $derived(kind !== '' && kind !== 'empty' && kind !== 'notEmpty');

  onMount(() => {
    if (!element) return undefined;
    const { width, height } = element.getBoundingClientRect();
    left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
    top = Math.max(4, Math.min(y, window.innerHeight - height - 4));
    placed = true;
    const outside = (event: Event) => {
      if (!element?.contains(event.target as Node)) onclose();
    };
    window.addEventListener('pointerdown', outside, true);
    return () => window.removeEventListener('pointerdown', outside, true);
  });

  function update(change: Partial<ColumnFilter>): void {
    setColumnFilter(ctl, colId, { ...column, ...change });
  }

  /** Ticks or unticks values: the ones given, or every value in the list as the search box narrows it. */
  function setShown(texts: string[], shown: boolean): void {
    const others = [...column.excluded].filter(text => !texts.includes(text));
    update({ excluded: new Set(shown ? others : [...others, ...texts]) });
  }

  function toggle(text: string, shown: boolean): void {
    setShown([text], shown);
  }

  function setAll(shown: boolean): void {
    setShown(listed.map(choice => choice.text), shown);
  }

  function setKind(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as ConditionKind | '';
    update({ condition: value === '' ? null : { kind: value, value: column.condition?.value ?? '' } });
  }

  function sort(ascending: boolean): void {
    sortFiltered(ctl, colId, ascending);
    onclose();
  }
</script>

<div
  bind:this={element}
  class="panel"
  class:placed
  style="left: {left}px; top: {top}px"
  role="dialog"
  tabindex="-1"
  aria-label="Filter"
  data-testid="sheet-filter-menu"
  onkeydown={(event) => { if (event.key === 'Escape') onclose(); event.stopPropagation(); }}
>
  <div class="row">
    <button type="button" class="action" onclick={() => sort(true)} data-testid="filter-sort-az">
      <span class="i-lucide-arrow-down-a-z"></span>Sort A to Z
    </button>
    <button type="button" class="action" onclick={() => sort(false)} data-testid="filter-sort-za">
      <span class="i-lucide-arrow-up-z-a"></span>Sort Z to A
    </button>
  </div>

  <div class="row condition">
    <select value={kind} onchange={setKind} aria-label="Condition" data-testid="filter-condition">
      <option value="">No condition</option>
      {#each KINDS as option (option)}
        <option value={option}>{CONDITION_LABELS[option]}</option>
      {/each}
    </select>
    {#if needsValue}
      <input
        value={column.condition?.value ?? ''}
        oninput={event => update({ condition: { kind: kind as ConditionKind, value: event.currentTarget.value } })}
        placeholder="Value"
        aria-label="Value"
        data-testid="filter-condition-value"
      />
    {/if}
  </div>

  <input class="search" bind:value={search} placeholder="Search values" aria-label="Search values" data-testid="filter-search" />
  <div class="links">
    <button type="button" onclick={() => setAll(true)} data-testid="filter-select-all">Select all</button>
    <button type="button" onclick={() => setAll(false)} data-testid="filter-clear">Clear</button>
    <span>{listed.length} {listed.length === 1 ? 'value' : 'values'}</span>
  </div>
  <div class="values" data-scrollable>
    {#each listed.slice(0, MOST_SHOWN) as choice (choice.text)}
      <label>
        <input type="checkbox" checked={!column.excluded.has(choice.text)} onchange={event => toggle(choice.text, event.currentTarget.checked)} />
        <span class="text" class:blank={choice.text === ''}>{choice.text === '' ? '(Empty)' : choice.text}</span>
        <span class="count">{choice.count}</span>
      </label>
    {/each}
    {#if listed.length > MOST_SHOWN}
      <div class="more">Search to see the rest.</div>
    {/if}
  </div>

  <div class="row end">
    <button type="button" class="action" onclick={() => { setColumnFilter(ctl, colId, null); search = ''; }} data-testid="filter-reset">Show all</button>
    <button type="button" class="action primary" onclick={onclose} data-testid="filter-done">Done</button>
  </div>
</div>

<style>
  .panel {
    position: fixed;
    z-index: 60;
    width: min(280px, calc(100vw - 8px));
    padding: 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 8px;
    background: rgb(var(--surface-1));
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.22);
    color: rgb(var(--text-1));
    font-size: 0.82rem;
    opacity: 0;
    outline: none;
  }

  .panel.placed {
    opacity: 1;
  }

  .row {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }

  .row.end {
    justify-content: flex-end;
    margin: 8px 0 0;
  }

  .action {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    height: 32px;
    padding: 0 10px;
    border: none;
    border-radius: 6px;
    background: rgb(var(--surface-2));
    color: inherit;
    font-size: inherit;
    cursor: pointer;
    white-space: nowrap;
  }

  .row.end .action {
    flex: none;
  }

  .action:hover {
    background: rgb(var(--surface-3));
  }

  .action.primary {
    background: #916dfe;
    color: #fff;
  }

  select,
  .search,
  .condition input {
    height: 32px;
    min-width: 0;
    padding: 0 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: rgb(var(--surface-0));
    color: inherit;
    font-size: inherit;
    outline: none;
  }

  select,
  .condition input {
    flex: 1;
  }

  .search {
    width: 100%;
  }

  select:focus,
  .search:focus,
  .condition input:focus {
    border-color: #916dfe;
  }

  .links {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 6px 2px;
    color: rgb(var(--text-3));
  }

  .links button {
    border: none;
    background: none;
    padding: 0;
    color: #916dfe;
    font-size: inherit;
    cursor: pointer;
  }

  .links span {
    margin-left: auto;
  }

  .values {
    max-height: min(240px, 34vh);
    overflow-y: auto;
    border: 1px solid rgb(var(--surface-2));
    border-radius: 6px;
    background: rgb(var(--surface-0));
  }

  label {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    padding: 0 8px;
    cursor: pointer;
  }

  label:hover {
    background: rgb(var(--surface-1));
  }

  .text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .blank,
  .count,
  .more {
    color: rgb(var(--text-3));
  }

  .more {
    padding: 6px 8px;
  }

  @media (pointer: coarse) {
    label {
      min-height: 38px;
    }
  }
</style>
