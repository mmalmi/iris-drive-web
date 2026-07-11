<script lang="ts">
  import { createIdentityProfileNameStore } from '../../stores/identityProfile';

  interface Props {
    profileId?: string;
    appKeyPubkey?: string;
    class?: string;
  }

  let { profileId = undefined, appKeyPubkey = '', class: className = '' }: Props = $props();

  let nameStore = $derived(createIdentityProfileNameStore(profileId, appKeyPubkey));
  let nameState = $derived($nameStore);
</script>

<span
  class={`truncate ${nameState.name === nameState.fallbackName ? 'italic opacity-70' : ''} ${className}`.trim()}
  title={nameState.name}
>
  {nameState.name}
</span>
