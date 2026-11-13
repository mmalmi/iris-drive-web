<script lang="ts">
  /** Named ranges: words that stand for cells in formulas, such as =SUM(Sales). */
  import { parseRectName, rectName } from '../../lib/sheets/address';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { defineName, listNames, nameText, removeName } from '../../lib/sheets/names';
  import SidePanel from './SidePanel.svelte';

  interface Props {
    ctl: SheetController;
    onclose: () => void;
  }
  let { ctl, onclose }: Props = $props();

  let names = $derived.by(() => {
    void ctl.revision;
    return listNames(ctl.book).map(named => ({ ...named, text: nameText(ctl.book, named) }));
  });
  let draftName = $state('');
  let draftRange = $state('');
  let problem = $state('');

  function add(): void {
    const rect = draftRange.trim() ? parseRectName(draftRange) : ctl.selection;
    if (!rect || rect.r2 >= ctl.sheet.rows.length || rect.c2 >= ctl.sheet.cols.length) {
      problem = 'Write cells like B2:B9.';
      return;
    }
    problem = defineName(ctl.book, draftName.trim(), ctl.sheet, rect);
    if (!problem) {
      draftName = '';
      draftRange = '';
    }
  }
</script>

<SidePanel title="Named ranges" {onclose} testId="names-panel">
  {#if names.length === 0}
    <p class="hint">Give cells a name to use it in formulas, as in =SUM(Sales), and to jump to them from the box left of the formula bar.</p>
  {/if}
  {#each names as named (named.name)}
    <div class="row">
      <button class="choice grow" onclick={() => { ctl.goToName(named.name); }} data-testid="named-range">
        <b>{named.name}</b><span class="hint">{named.text}</span>
      </button>
      <button class="btn-circle btn-ghost" onclick={() => removeName(ctl.book, named.name)} title="Remove name" aria-label="Remove {named.name}"><span class="i-lucide-trash-2"></span></button>
    </div>
  {/each}
  <form class="field" onsubmit={(event) => { event.preventDefault(); add(); }}>
    New name
    <input type="text" placeholder="Sales" bind:value={draftName} data-testid="names-name" />
    <input type="text" placeholder={rectName(ctl.selection)} bind:value={draftRange} aria-label="Cells" data-testid="names-range" />
    {#if problem}<span class="hint" role="alert">{problem}</span>{/if}
    <div class="row">
      <button class="btn-ghost" type="submit" disabled={!draftName.trim()} data-testid="names-add"><span class="i-lucide-plus"></span> Add</button>
    </div>
  </form>
</SidePanel>

<style>
  .grow {
    flex: 1;
    min-width: 0;
    justify-content: space-between;
  }
</style>
