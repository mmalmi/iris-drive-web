<script lang="ts">
  import ContactMemoryPanel from '@iris/svelte-ui/ContactMemoryPanel.svelte';
  import { nostrStore } from '../../nostr';
  import { createProfileStore, getProfileName, getProfileSync } from '../../stores/profile';
  import { contactMemory, contactKey } from '../../stores/contactMemory';

  let { pubkey }: { pubkey: string } = $props();
  let key = $derived(contactKey(pubkey));
  let viewer = $derived($nostrStore.pubkey || '');
  let profileStore = $derived(createProfileStore(key));
  let currentName = $derived(getProfileName($profileStore, key) ?? null);
  let memory = $derived.by(() => { $contactMemory; return contactMemory.get(viewer, key); });

  $effect(() => {
    try { contactMemory.observeKnown(viewer, key, currentName); }
    catch { /* A later explicit action can show the storage failure. */ }
  });
</script>

{#if viewer && key && viewer !== key}
  <ContactMemoryPanel
    {memory}
    {currentName}
    onFavoriteChange={favorite => contactMemory.setFavorite(viewer, key, favorite, currentName)}
    onApproveName={expected => {
      const latest = getProfileName(getProfileSync(key), key) ?? null;
      if (!contactMemory.approve(viewer, key, expected, latest, Math.floor(Date.now() / 1000))) {
        throw new Error('The profile name changed.');
      }
    }}
  />
{/if}
