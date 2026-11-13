<script lang="ts">
  /** A person's name from their profile as it arrives, until then the name already known. */
  import { coolName } from '@iris/svelte-ui/profile';
  import { createProfileStore, getProfileName } from '../../stores/profile';

  let { pubkey, known = '' }: { pubkey: string; known?: string } = $props();

  let profileStore = $derived(createProfileStore(pubkey));
  let name = $derived(getProfileName($profileStore ?? undefined) || known || coolName(pubkey));
</script>

{name}
