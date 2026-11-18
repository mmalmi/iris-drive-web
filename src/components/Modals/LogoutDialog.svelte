<script lang="ts">
  import { logout } from '../../nostr';
  import { navigate } from '../../utils/navigate';

  let visible = $state(false);
  const id = $props.id();

  export function open() {
    visible = true;
  }

  function showDialog(dialog: HTMLDialogElement) {
    dialog.showModal();
  }

  function confirmLogout() {
    logout();
    navigate('/');
  }
</script>

{#if visible}
  <dialog
    use:showDialog
    aria-modal="true"
    aria-labelledby="{id}-title"
    aria-describedby="{id}-detail"
    onkeydown={(event) => event.stopPropagation()}
    onclose={() => { visible = false; }}
    class="fixed inset-0 m-auto w-96 max-w-[calc(100%-2rem)] rounded-lg border border-surface-3 bg-surface-1 p-5 text-text-1 shadow-lg"
  >
    <h2 id="{id}-title" class="text-lg font-semibold">Log out of Drive?</h2>
    <p id="{id}-detail" class="mt-2 text-sm text-text-2">This removes the saved sign-in for this profile from this device.</p>
    <form method="dialog" class="mt-5 flex justify-end gap-2">
      <button class="btn-ghost focus-visible:ring-2 focus-visible:ring-accent">Cancel</button>
      <button type="button" class="btn-danger" onclick={confirmLogout}>Log out</button>
    </form>
  </dialog>
{/if}

<style>
  dialog::backdrop { background: rgb(0 0 0 / 55%); }
</style>
