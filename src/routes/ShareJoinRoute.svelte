<script lang="ts">
  /**
   * Where a join link lands: ask to be added to the shared folder, wait until
   * an admin's Drive has done it, then open the folder.
   */
  import DriveSetup from '../components/DriveSetup.svelte';
  import { nostrStore } from '../nostr';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { acceptedShares } from '../drive/shareLibrary';
  import { parseShareJoinLink, type ShareJoinLink } from '../drive/shareJoinLink';
  import { joinedShare, requestToJoin, waitUntilJoined } from '../drive/shareJoin';
  import { PENDING_JOIN_KEY } from '../drive/sharePeople';
  import { documentTitle } from '../lib/documentNames';

  interface Props {
    payload: string;
  }

  let { payload }: Props = $props();

  let link = $derived.by((): ShareJoinLink | null => {
    try {
      return parseShareJoinLink(payload);
    } catch {
      return null;
    }
  });
  let profileId = $derived(activeNostrIdentityRootScope($nostrStore));
  let name = $derived(link ? (link.doc ? documentTitle(link.doc) : link.name) : '');
  let waitingLong = $state(false);
  let error = $state('');

  function openFolder(target: ShareJoinLink) {
    const parts = [target.share_id, 'main', ...(target.doc ? [target.doc] : [])];
    window.location.replace(`#/${parts.map(encodeURIComponent).join('/')}`);
  }

  // Without an account yet: remember the link so creating one comes back here.
  $effect(() => {
    if (!link || profileId) return;
    try {
      sessionStorage.setItem(PENDING_JOIN_KEY, payload);
    } catch {
      // The visitor can still open the link again after signing in.
    }
  });

  $effect(() => {
    const target = link;
    if (!target || !profileId) return;
    if (joinedShare(target, $acceptedShares)) {
      openFolder(target);
      return;
    }
    error = '';
    waitingLong = false;
    const slow = setTimeout(() => { waitingLong = true; }, 12_000);
    const stop = waitUntilJoined(target, () => openFolder(target));
    void requestToJoin(target).catch((cause) => {
      error = cause instanceof Error ? cause.message : 'Could not ask to join';
    });
    return () => {
      clearTimeout(slow);
      stop();
    };
  });
</script>

{#if !link}
  <div class="flex-1 flex-center p-6" data-testid="share-join-invalid">
    <div class="flex items-center gap-3">
      <span class="i-lucide-circle-alert text-3xl text-warning"></span>
      <h1 class="text-xl font-semibold text-text-1">This link is not valid</h1>
    </div>
  </div>
{:else if !profileId}
  <div class="flex-1 flex flex-col overflow-auto">
    <p class="px-4 pt-8 text-center text-text-2" data-testid="share-join-signin">
      Create an account or sign in to open “{name}”.
    </p>
    <DriveSetup />
  </div>
{:else}
  <div class="flex-1 flex-center p-6" data-testid="share-join-waiting">
    <div class="max-w-sm text-center space-y-3">
      <span class="i-lucide-loader-2 animate-spin text-3xl text-text-3 inline-block"></span>
      <h1 class="text-xl font-semibold text-text-1">Opening “{name}”</h1>
      {#if error}
        <p class="text-sm text-danger" data-testid="share-join-error">{error}</p>
      {:else if waitingLong}
        <p class="text-sm text-text-3" data-testid="share-join-slow">
          You will be let in when the owner’s Drive is open. Keep this page open, or come back to this link later.
        </p>
      {/if}
    </div>
  </div>
{/if}
