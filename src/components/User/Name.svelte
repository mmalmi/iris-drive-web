<script lang="ts">
  import FavoriteStar from '@iris/svelte-ui/FavoriteStar.svelte';
  import { nostrStore } from '../../nostr';
  import { contactMemory, contactKey } from '../../stores/contactMemory';
  import SharedName from '@iris/svelte-ui/Name.svelte';
  import { coolName } from '@iris/svelte-ui/profile';
  import { createProfileStore, getProfileName } from '../../stores/profile';

  interface Props {
    pubkey: string;
    class?: string;
  }

  let { pubkey, class: className = '' }: Props = $props();

  let profileStore = $derived(pubkey ? createProfileStore(pubkey) : null);
  let profile = $derived(profileStore ? $profileStore : undefined);
  let memory = $derived.by(() => {
    $contactMemory;
    return contactMemory.get($nostrStore.pubkey || '', contactKey(pubkey));
  });
  $effect(() => {
    try { contactMemory.observeKnown($nostrStore.pubkey || '', contactKey(pubkey), getProfileName(profile ?? undefined, pubkey) ?? null); }
    catch { /* Explicit profile actions report storage failures. */ }
  });
  let profileName = $derived(memory?.accepted_name ?? getProfileName(profile ?? undefined, pubkey));
  let fallbackName = $derived(pubkey ? coolName(pubkey) : '');
</script>

<SharedName
  {pubkey}
  {profile}
  name={profileName}
  {fallbackName}
  class={`truncate ${className}`.trim()}
  fallbackClass="italic opacity-70"
/>

<FavoriteStar favorite={memory?.favorite ?? false} />
