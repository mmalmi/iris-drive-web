<script lang="ts">
  import { onMount } from 'svelte';

  onMount(() => {
    const expire = () => void import('../lib/driveTrash').then(({ expireTrash }) => expireTrash())
      .catch(error => console.warn('[Trash] Could not expire old items', error));
    const first = setTimeout(expire, 5000);
    const timer = setInterval(expire, 60 * 60 * 1000);
    return () => { clearTimeout(first); clearInterval(timer); };
  });
</script>
