<script lang="ts">
  /**
   * Shown at the address of a Drive or shared folder this account has no
   * record of. Access comes only from an invite, so there is nothing to wait
   * for: say so at once, and offer signing in to someone signed out.
   */
  import { onMount } from 'svelte';
  import DriveSetup from './DriveSetup.svelte';
  import { nostrStore } from '../nostr';
  import { activeDriveRootPath } from '../drive/profileRoute';
  import { PENDING_OPEN_KEY } from '../drive/sharePeople';

  let signedIn = $derived($nostrStore.isLoggedIn);
  let homeHref = $derived(`#${activeDriveRootPath($nostrStore)}`);

  // Signing in from here comes back here, where the folder opens if it was shared with that account.
  onMount(() => {
    if (signedIn) return;
    try {
      sessionStorage.setItem(PENDING_OPEN_KEY, window.location.hash.replace(/^#/, ''));
    } catch {
      // The visitor can open the address again after signing in.
    }
  });
</script>

{#snippet notice()}
  <div class="flex flex-col items-center gap-2 text-center">
    <span class="i-lucide-lock text-3xl text-text-3"></span>
    <h1 class="text-xl font-semibold text-text-1">You need access</h1>
    <p class="text-sm text-text-2 max-w-80" data-testid="no-access-hint">
      {#if signedIn}
        Only invited people can open this. Open the invite link the owner sent you, or ask them for one.
      {:else}
        Only invited people can open this. Sign in if you were invited, or open the invite link the owner sent you.
      {/if}
    </p>
  </div>
{/snippet}

{#if signedIn}
  <div class="flex-1 flex-center p-6" data-testid="no-access">
    <div class="flex flex-col items-center gap-5">
      {@render notice()}
      <a class="btn-ghost text-sm no-underline" href={homeHref}>Go to My Drive</a>
    </div>
  </div>
{:else}
  <div class="flex-1 flex flex-col overflow-auto" data-testid="no-access">
    <DriveSetup>
      {@render notice()}
    </DriveSetup>
  </div>
{/if}
