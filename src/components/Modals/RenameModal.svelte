<script lang="ts" module>
  /**
   * Modal for renaming files and folders. A document, spreadsheet or
   * presentation is renamed by its title; it stays the kind it is.
   */
  import { documentFolderName, documentKind, documentTitle } from '../../lib/documentNames';

  let show = $state(false);
  let originalName = $state('');
  let modalInput = $state('');
  let selectUntil = $state(0);

  export function open(name: string, isFolder = false) {
    originalName = name;
    modalInput = documentTitle(name);
    const dot = modalInput.lastIndexOf('.');
    const hasExtension = !isFolder && modalInput === name && dot > 0 && dot < name.length - 1;
    selectUntil = hasExtension ? dot : modalInput.length;
    show = true;
  }

  export function close() {
    show = false;
    originalName = '';
    modalInput = '';
  }
</script>

<script lang="ts">
  import { renameEntry } from '../../actions';

  let inputRef = $state<HTMLInputElement | null>(null);

  // Focus input when modal opens
  $effect(() => {
    if (show && inputRef) {
      inputRef.focus();
      inputRef.setSelectionRange(0, selectUntil);
    }
  });

  async function handleSubmit(e: Event) {
    e.preventDefault();
    const kind = documentKind(originalName);
    const newName = kind ? documentFolderName(modalInput, kind) : modalInput.trim();
    if (!modalInput.trim() || newName === originalName) {
      close();
      return;
    }
    await renameEntry(originalName, newName);
    close();
  }
</script>

{#if show}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70" data-scroll-lock onclick={close}>
    <div class="bg-surface-1 rounded-lg shadow-lg p-6 w-full max-w-md mx-4" onclick={(e) => e.stopPropagation()}>
      <h2 class="text-lg font-semibold mb-4">Rename</h2>
      <form onsubmit={handleSubmit}>
        <input
          bind:this={inputRef}
          type="text"
          placeholder="New name..."
          bind:value={modalInput}
          class="input w-full mb-4"
        />
        <div class="flex justify-end gap-2">
          <button type="button" onclick={close} class="btn-ghost">Cancel</button>
          <button type="submit" class="btn-success">Rename</button>
        </div>
      </form>
    </div>
  </div>
{/if}
