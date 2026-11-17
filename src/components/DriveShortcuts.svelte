<script lang="ts">
  let dialog: HTMLDialogElement;
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  const rows = [
    ['Search Drive', '/'],
    ['Show keyboard shortcuts', mod + ' + /'],
    ['Select a file', 'Arrow keys'],
    ['Extend selection', 'Shift + Arrow'],
    ['Move focus only', mod + ' + Arrow'],
    ['Toggle selection', 'Space'],
    ['Select all', mod + ' + A'],
    ['Open', 'Enter'],
    ['Open in new tab', mod + ' + Enter'],
    ['Rename', 'F2'],
    ['Copy', mod + ' + C'],
    ['Cut', mod + ' + X'],
    ['Paste', mod + ' + V'],
    ['Delete', 'Delete / Backspace'],
    ['More actions', 'Shift + F10'],
    ['Clear selection', 'Esc'],
  ];
  export function open() { if (!dialog.open) dialog.showModal(); }
</script>

<dialog bind:this={dialog} aria-labelledby="drive-shortcuts-title"
  class="m-auto w-[min(26rem,92vw)] max-h-[85dvh] rounded-2xl border-0 bg-surface-0 text-text-1 p-0 shadow-xl backdrop:bg-black/50">
  <div class="sticky top-0 bg-surface-0 px-5 pt-4 pb-2 flex items-center justify-between">
    <h2 id="drive-shortcuts-title" class="text-lg font-semibold">Keyboard shortcuts</h2>
    <button type="button" class="btn-circle" aria-label="Close" onclick={() => dialog.close()}><span class="i-lucide-x"></span></button>
  </div>
  <dl class="m-0 px-5 pb-4">
    {#each rows as [action, key] (action)}
      <div class="flex items-baseline justify-between gap-4 border-b border-surface-2 py-1.5 text-sm last:border-0">
        <dt>{action}</dt><dd class="m-0"><kbd class="text-text-2">{key}</kbd></dd>
      </div>
    {/each}
  </dl>
</dialog>
