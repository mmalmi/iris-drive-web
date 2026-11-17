<script lang="ts">
  import { onMount } from 'svelte';
  import { nostrStore } from '../nostr';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { forgetDeletionHistory, setDeletionHistoryOwner } from '../actions/deletionHistory';

  $effect(() => {
    setDeletionHistoryOwner($nostrStore.isLoggedIn ? activeNostrIdentityRootScope($nostrStore) ?? $nostrStore.npub : null);
  });

  onMount(() => {
    let closed = false;
    let unsubscribe: (() => void) | undefined;
    const expire = () => void import('../lib/driveTrash').then(({ expireTrash, watchTrash }) => {
      if (closed) return;
      unsubscribe ??= watchTrash(forgetDeletionHistory);
      return expireTrash();
    })
      .catch(error => console.warn('[Trash] Could not expire old items', error));
    const first = setTimeout(expire, 5000);
    const timer = setInterval(expire, 60 * 60 * 1000);
    return () => { closed = true; clearTimeout(first); clearInterval(timer); unsubscribe?.(); };
  });
</script>
