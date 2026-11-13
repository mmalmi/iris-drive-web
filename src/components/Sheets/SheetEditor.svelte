<script lang="ts">
  /**
   * A spreadsheet opened from a Drive folder. The spreadsheet itself lives one
   * level down, so that it can be opened afresh from what is stored.
   */
  import SheetDocument from './SheetDocument.svelte';

  interface Props {
    dirName: string;
  }
  let { dirName }: Props = $props();

  let opened = $state(0);
</script>

{#key opened}
  <SheetDocument
    {dirName}
    notice={opened > 0 ? 'This spreadsheet was changed, so it is shown as stored again, without your sorting.' : ''}
    onreset={() => { opened += 1; }}
  />
{/key}
