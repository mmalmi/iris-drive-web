<script lang="ts">
  /** Settings of a chart: its kind, title, cells and legend. Each change is one undo step. */
  import { parseRectName, quoteSheetName, rectName } from '../../lib/sheets/address';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { changeObject, chartRect, objectById, rectIds, removeObject, type ChartContent, type ChartType } from '../../lib/sheets/objects';
  import SidePanel from './SidePanel.svelte';

  interface Props {
    ctl: SheetController;
    id: string;
    onclose: () => void;
  }
  let { ctl, id, onclose }: Props = $props();

  const TYPES: Array<{ type: ChartType; label: string; icon: string }> = [
    { type: 'column', label: 'Columns', icon: 'i-lucide-chart-column' },
    { type: 'bar', label: 'Bars', icon: 'i-lucide-chart-bar' },
    { type: 'line', label: 'Line', icon: 'i-lucide-chart-line' },
    { type: 'pie', label: 'Pie', icon: 'i-lucide-chart-pie' },
  ];

  let object = $derived.by(() => {
    void ctl.revision;
    return ctl.hasSheet ? objectById(ctl.sheet, id) : null;
  });
  let chart = $derived(object?.content.kind === 'chart' ? object.content : null);
  let dataSheet = $derived(chart?.sheet && ctl.book.nameOf(chart.sheet) !== undefined ? ctl.book.sheet(chart.sheet) : ctl.sheet);
  let rangeText = $derived.by(() => {
    if (!chart) return '';
    const rect = chartRect(dataSheet, chart);
    if (!rect) return '';
    const prefix = chart.sheet ? `${quoteSheetName(ctl.book.nameOf(chart.sheet) ?? '')}!` : '';
    return prefix + rectName(rect);
  });
  let rangeError = $state('');

  $effect(() => {
    // The chart was deleted, here or elsewhere.
    if (!object) onclose();
  });

  function change(patch: Partial<ChartContent>): void {
    if (!chart || !ctl.canEdit) return;
    const next = { ...chart, ...patch } as Record<string, unknown>;
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    changeObject(ctl.sheet, id, next as unknown as ChartContent);
  }

  function setRange(text: string): void {
    if (!chart) return;
    const match = /^\s*(?:'((?:[^']|'')+)'|([^!']+))!(.+)$/.exec(text);
    const sheetName = match ? (match[1] ?? match[2]).replace(/''/g, "'").trim() : null;
    const info = sheetName ? ctl.book.sheetByName(sheetName) : null;
    const rect = parseRectName(match ? match[3] : text);
    if ((sheetName && !info) || !rect) {
      rangeError = 'Write cells like A1:C8, or Sheet2!A1:C8.';
      return;
    }
    const target = info ? ctl.book.sheet(info.id) : ctl.sheet;
    if (rect.r2 >= target.rows.length || rect.c2 >= target.cols.length) {
      rangeError = 'Those cells are outside the sheet.';
      return;
    }
    rangeError = '';
    const onOwn = !info || info.id === ctl.sheetId;
    const next: ChartContent = { ...chart, ...rectIds(target, rect) };
    if (onOwn) delete next.sheet;
    else next.sheet = info.id;
    changeObject(ctl.sheet, id, next);
  }

  function remove(): void {
    removeObject(ctl.sheet, id);
    ctl.selectedObject = null;
    onclose();
    ctl.focusGrid();
  }
</script>

{#if chart}
  <SidePanel title="Chart" {onclose} testId="chart-panel">
    <div class="choices" role="radiogroup" aria-label="Kind of chart">
      {#each TYPES as choice (choice.type)}
        <button
          class="choice"
          class:on={chart.type === choice.type}
          role="radio"
          aria-checked={chart.type === choice.type}
          onclick={() => change({ type: choice.type })}
          data-testid="chart-type-{choice.type}"
        >
          <span class={choice.icon}></span>{choice.label}
        </button>
      {/each}
    </div>
    <label class="field">
      Title
      <input type="text" value={chart.title} placeholder="No title" onchange={(event) => change({ title: (event.target as HTMLInputElement).value.trim().slice(0, 200) })} data-testid="chart-title" />
    </label>
    <label class="field">
      Cells
      <input type="text" value={rangeText} onchange={(event) => setRange((event.target as HTMLInputElement).value)} data-testid="chart-range" />
      {#if rangeError}<span class="hint" role="alert">{rangeError}</span>{/if}
    </label>
    <label class="check">
      <input type="checkbox" checked={chart.legend} onchange={(event) => change({ legend: (event.target as HTMLInputElement).checked })} data-testid="chart-legend" />
      Show legend
    </label>
    {#if chart.type !== 'pie'}
      <label class="check">
        <input type="checkbox" checked={!!chart.byRow} onchange={(event) => change({ byRow: (event.target as HTMLInputElement).checked || undefined })} data-testid="chart-by-row" />
        One line or colour per row
      </label>
    {/if}
    <p class="hint">
      The first row names the series and the first column labels the points, when they hold text.
      {#if chart.type === 'pie'}A pie shows the first series.{/if}
    </p>
    <div class="row">
      <button class="btn-ghost text-danger" onclick={remove} data-testid="chart-delete">
        <span class="i-lucide-trash-2"></span> Delete chart
      </button>
    </div>
  </SidePanel>
{/if}
