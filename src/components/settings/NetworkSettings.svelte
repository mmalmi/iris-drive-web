<script lang="ts">
  import ServersSettings from './ServersSettings.svelte';
  import P2PSettings from './P2PSettings.svelte';
  import TransportUsageSettings from './TransportUsageSettings.svelte';
</script>

<div class="space-y-6">
  <TransportUsageSettings embedded={true} />
  <ServersSettings embedded={true} />
  <P2PSettings embedded={true} />
</div>
