<script lang="ts">
  import help from '../../../docs/help.md?raw';
  import { renderMarkdownHtml } from '../../lib/markdown';

  let { onShortcuts }: { onShortcuts: () => void } = $props();
  const answers = renderMarkdownHtml(help);
</script>

<div class="max-w-prose space-y-6">
  <button type="button" onclick={onShortcuts}
    class="inline-flex min-h-10 items-center gap-2 rounded-full bg-surface-2 px-4 text-sm font-medium text-text-1 hover:bg-surface-3">
    <span aria-hidden="true" class="i-lucide-keyboard text-lg"></span>
    Keyboard shortcuts
  </button>
  {#await answers then html}
    <div class="text-sm leading-relaxed text-text-2 [&_h3]:mb-1 [&_h3]:mt-5 [&_h3]:font-semibold [&_h3]:text-text-1 [&_a]:text-accent [&_a]:underline">
      {@html html}
    </div>
  {/await}
</div>
