<script lang="ts">
  /**
   * The checkmark Iris apps put beside a person this account follows, or whom
   * people it follows follow. Shown only when the follow graph this device
   * already holds says so; nothing is loaded for it.
   */
  import SocialDistanceBadge from '@iris/svelte-ui/SocialDistanceBadge.svelte';
  import { followDistance } from '../../lib/followDistance';
  import { npubPubkey } from '../../drive/people';

  interface Props {
    /** The person's key, as hex or as an npub. */
    pubkey?: string | null;
    size?: number;
  }
  let { pubkey = null, size = 14 }: Props = $props();

  let hex = $derived(pubkey?.startsWith('npub1') ? npubPubkey(pubkey) : pubkey);
  let distance = $derived(followDistance(hex));
</script>

<SocialDistanceBadge distance={$distance} {size} />
