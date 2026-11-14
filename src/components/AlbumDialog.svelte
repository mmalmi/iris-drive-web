<script lang="ts">
  import Modal from './ui/Modal.svelte';
  import { validAlbumName } from '../lib/photos';

  let { mode, name, onsave, onclose }: {
    mode: 'create' | 'rename' | 'delete';
    name: string;
    onsave: (name: string) => Promise<void>;
    onclose: () => void;
  } = $props();
  let draft = $state('');
  let busy = $state(false);
  let error = $state('');
  let input: HTMLInputElement | undefined = $state();
  let cancel: HTMLButtonElement | undefined = $state();
  let heading = $derived(mode === 'delete' ? `Delete “${name}”?` : mode === 'rename' ? 'Rename album' : 'New album');
  let invalid = $derived(!!draft.trim() && !validAlbumName(draft.trim()));

  $effect(() => {
    if (mode === 'delete') cancel?.focus();
    else if (input) { draft = name; input.focus(); input.select(); }
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || (mode !== 'delete' && (!draft.trim() || invalid))) return;
    busy = true;
    error = '';
    try {
      await onsave(draft.trim());
      onclose();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not save the change.';
    } finally {
      busy = false;
    }
  }
</script>

<Modal open label={heading} onClose={() => { if (!busy) onclose(); }} panelClass="mx-4 w-full max-w-sm rounded-lg bg-surface-1 p-5 shadow-lg">
  <h2 class="break-words text-lg font-semibold">{heading}</h2>
  <form class="mt-3 space-y-3" onsubmit={save}>
    {#if mode === 'delete'}
      <p class="text-sm text-text-2">This deletes the Drive folder and everything inside it, including photos, videos and other files. Copies in other folders stay there.</p>
    {:else}
      <input bind:this={input} bind:value={draft} class="input w-full" aria-label="Album name" placeholder="Album name" aria-invalid={invalid} disabled={busy} />
      {#if invalid}<p class="text-sm text-danger">Choose another album name.</p>{/if}
    {/if}
    {#if error}<p role="alert" class="text-sm text-danger">{error}</p>{/if}
    <div class="flex justify-end gap-2">
      <button type="button" bind:this={cancel} class="btn-ghost" disabled={busy} onclick={onclose}>Cancel</button>
      <button type="submit" class={mode === 'delete' ? 'btn-ghost text-danger' : 'btn-primary'}
        disabled={busy || (mode !== 'delete' && (!draft.trim() || invalid))}>
        {mode === 'delete' ? 'Delete album' : mode === 'rename' ? 'Save' : 'Create'}
      </button>
    </div>
  </form>
</Modal>
