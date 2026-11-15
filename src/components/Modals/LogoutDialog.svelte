<script lang="ts">
  import { logout } from '../../nostr';
  import { navigate } from '../../utils/navigate';

  let dialog: HTMLDialogElement;
  let modalOpen = $state(false);
  const id = $props.id();

  export function open() {
    if (!dialog.open) {
      dialog.showModal();
      modalOpen = true;
    }
  }

  function confirmLogout() {
    dialog.close();
    logout();
    navigate('/');
  }
</script>

<dialog
  bind:this={dialog}
  aria-modal={modalOpen || undefined}
  aria-labelledby="{id}-title"
  aria-describedby="{id}-detail"
  onkeydown={(event) => event.stopPropagation()}
  onclose={() => { modalOpen = dialog.open; }}
  class="fixed inset-0 m-auto w-96 max-w-[calc(100%-2rem)] rounded-lg border border-surface-3 bg-surface-1 p-5 text-text-1 shadow-lg"
>
  <h2 id="{id}-title" class="text-lg font-semibold">Log out of Drive?</h2>
  <p id="{id}-detail" class="mt-2 text-sm text-text-2">This removes your saved sign-in for this account from this device.</p>
  <div class="mt-5 flex justify-end gap-2">
    <button type="button" class="btn-ghost focus-visible:ring-2 focus-visible:ring-accent" onclick={() => dialog.close()}>Cancel</button>
    <button type="button" class="btn-danger" onclick={confirmLogout}>Log out</button>
  </div>
</dialog>

<style>
  dialog::backdrop { background: rgb(0 0 0 / 55%); }
</style>
