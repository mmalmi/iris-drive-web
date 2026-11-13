<script lang="ts">
  import { coolName } from '@iris/svelte-ui/profile';
  import { createProfileStore, getProfileName } from '../../stores/profile';
  import Minidenticon from './Minidenticon.svelte';
  import ProxyImg from '../ProxyImg.svelte';

  interface Props {
    pubkey: string;
    size?: number;
    class?: string;
  }

  let { pubkey, size = 40, class: className = '' }: Props = $props();

  let profileStore = $derived(pubkey ? createProfileStore(pubkey) : null);
  let profile = $derived(profileStore ? $profileStore : undefined);
  let imgError = $state(false);

  // Reset error state when pubkey changes
  $effect(() => {
    pubkey; // depend on pubkey
    imgError = false;
  });

  let name = $derived(getProfileName(profile ?? undefined, pubkey) || (pubkey ? coolName(pubkey) : ''));
  let hasPicture = $derived(Boolean(profile?.picture && !imgError));
  // Request 2x size for retina displays
  let proxySize = $derived(size * 2);
</script>

{#if hasPicture}
  <ProxyImg
    src={profile?.picture || ''}
    alt={name}
    width={proxySize}
    height={proxySize}
    square={true}
    class="rounded-full object-cover {className}"
    onerror={() => (imgError = true)}
    style="width: {size}px; height: {size}px;"
  />
{:else}
  <div title={name}>
    <Minidenticon seed={pubkey} {size} class={className} />
  </div>
{/if}
