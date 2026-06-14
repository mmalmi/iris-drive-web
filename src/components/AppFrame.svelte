<script lang="ts">
  interface Props {
    appUrl: string;
  }

  let { appUrl }: Props = $props();
</script>

<!-- Sandboxed iframe for app content -->
<iframe
  src={appUrl}
  class="flex-1 w-full border-0"
  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
  title="App"
  referrerpolicy="no-referrer"
></iframe>
