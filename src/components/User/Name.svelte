<script lang="ts">
  import SharedName from '@iris/svelte-ui/Name.svelte';
  import { createProfileStore, getProfileName } from '../../stores/profile';
  import { animalName } from '../../utils/animalName';

  interface Props {
    pubkey: string;
    class?: string;
  }

  let { pubkey, class: className = '' }: Props = $props();

  let profileStore = $derived(pubkey ? createProfileStore(pubkey) : null);
  let profile = $derived(profileStore ? $profileStore : undefined);
  let profileName = $derived(getProfileName(profile ?? undefined, pubkey));
  let animal = $derived(pubkey ? animalName(pubkey) : '');
</script>

<SharedName
  {pubkey}
  {profile}
  name={profileName}
  fallbackName={animal}
  class={`truncate ${className}`.trim()}
  fallbackClass="italic opacity-70"
/>
