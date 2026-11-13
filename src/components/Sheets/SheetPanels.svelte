<script lang="ts">
  /** The settings panel that is open beside the grid. Loaded only when one opens. */
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import ChartPanel from './ChartPanel.svelte';
  import CommentsPanel from './CommentsPanel.svelte';
  import FormatPanel from './FormatPanel.svelte';
  import NamesPanel from './NamesPanel.svelte';
  import ValidationPanel from './ValidationPanel.svelte';

  interface Props {
    ctl: SheetController;
  }
  let { ctl }: Props = $props();

  function close(): void {
    ctl.panel = null;
    ctl.focusGrid();
  }
</script>

{#if ctl.panel?.kind === 'chart'}
  {#key ctl.panel.id}
    <ChartPanel {ctl} id={ctl.panel.id} onclose={close} />
  {/key}
{:else if ctl.panel?.kind === 'format'}
  <FormatPanel {ctl} onclose={close} />
{:else if ctl.panel?.kind === 'valid'}
  <ValidationPanel {ctl} start={ctl.panel.check} onclose={close} />
{:else if ctl.panel?.kind === 'names'}
  <NamesPanel {ctl} onclose={close} />
{:else if ctl.panel?.kind === 'comments'}
  <CommentsPanel {ctl} onclose={close} />
{/if}
