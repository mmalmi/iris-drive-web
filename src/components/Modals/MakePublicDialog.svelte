<script lang="ts">
  let { name, item, onconfirm }: { name: string; item: string; onconfirm: () => void } = $props();
  let dialog: HTMLDialogElement;
  const id = $props.id();

  export function open() {
    if (!dialog.open) dialog.showModal();
  }

  function confirm() {
    dialog.close();
    onconfirm();
  }
</script>

<dialog
  bind:this={dialog}
  aria-labelledby="{id}-title"
  aria-describedby="{id}-detail"
  class="rounded-lg border border-surface-3 bg-surface-1 p-5 text-text-1 shadow-lg"
>
  <h2 id="{id}-title" class="break-words text-lg font-semibold">Make “{name}” public?</h2>
  <div id="{id}-detail" class="mt-2 space-y-2 text-sm text-text-2">
    <p>Anyone can find and view {item}. Future changes will be public too.</p>
    <p>If you stop sharing later, people can still access versions already published.</p>
  </div>
  <div class="mt-5 flex justify-end gap-2">
    <button type="button" class="btn-ghost focus-visible:ring-2 focus-visible:ring-accent" onclick={() => dialog.close()}>Cancel</button>
    <button type="button" class="btn-primary" onclick={confirm}>Make public</button>
  </div>
</dialog>

<style>
  dialog:modal {
    position: fixed;
    inset: 0;
    /* Keep the dialog centered even inside a sharing panel that spaces its children. */
    margin: auto;
    width: min(24rem, calc(100% - 2rem));
    height: fit-content;
    max-height: calc(100% - 2rem);
    overflow: auto;
  }
  dialog::backdrop { background: rgb(0 0 0 / 55%); }
</style>
