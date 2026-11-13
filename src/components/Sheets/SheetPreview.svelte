<script lang="ts">
  /**
   * An .xlsx or .csv file from the Drive shown as a spreadsheet to look at,
   * select, copy, sort and filter, without saving anything (see fileImports.ts).
   */
  import { onDestroy, onMount } from 'svelte';
  import * as Y from 'yjs';
  import type { FilePreviewProps } from '../../lib/fileImports';
  import { SheetController } from '../../lib/sheets/controller.svelte';
  import FormulaBar from './FormulaBar.svelte';
  import SheetGrid from './SheetGrid.svelte';
  import SheetTabs from './SheetTabs.svelte';
  import { fillFromFile } from './sheetFiles';

  let { fileName, data }: FilePreviewProps = $props();

  const ctl = new SheetController(new Y.Doc());
  let state = $state<'loading' | 'ready' | 'failed'>('loading');

  onMount(() => {
    void (async () => {
      // Filled as an editor would, then shown to read only.
      ctl.start(true);
      const filled = await fillFromFile(ctl, fileName, data);
      ctl.start(false);
      state = filled ? 'ready' : 'failed';
    })();
  });

  onDestroy(() => {
    const doc = ctl.book.doc;
    ctl.destroy();
    doc.destroy();
  });
</script>

<div class="relative flex-1 flex flex-col min-h-0 bg-surface-0" data-testid="sheet-preview">
  {#if state === 'loading'}
    <div class="flex-1 flex items-center justify-center text-text-3"><span class="i-lucide-loader-2 animate-spin"></span></div>
  {:else if state === 'failed'}
    <div class="flex-1 flex items-center justify-center text-text-3 text-sm">This file could not be read as a spreadsheet.</div>
  {:else}
    <FormulaBar {ctl} />
    <SheetGrid {ctl} />
    <SheetTabs {ctl} />
  {/if}
</div>
