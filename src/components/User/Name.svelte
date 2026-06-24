<script lang="ts">
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
  let profileName = $derived(getProfileName(profile ?? undefined, pubkey));
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
