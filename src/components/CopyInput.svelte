<script lang="ts">
  /**
   * CopyInput - GitHub-style readonly input with copy button
   */
  interface Props {
    text: string;
    class?: string;
    multiline?: boolean;
    rows?: number;
  }

  let {
    text,
    class: className = '',
    multiline = false,
    rows = 3,
  }: Props = $props();

  let copied = $state(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  }
</script>

<div class="flex items-stretch gap-2 rounded-xl bg-surface-0 b-1 b-solid b-surface-3 p-1.5 shadow-sm {className}">
  {#if multiline}
    <textarea
      readonly
      value={text}
      rows={rows}
      class="flex-1 min-w-0 textarea bg-transparent! b-0! p-2.5 text-xs font-mono leading-5 resize-none"
      onclick={(e) => (e.target as HTMLTextAreaElement).select()}
    ></textarea>
  {:else}
    <input
      type="text"
      readonly
      value={text}
      class="flex-1 min-w-0 input bg-transparent! b-0! rounded-lg! px-2.5 py-2 text-xs font-mono"
      onclick={(e) => (e.target as HTMLInputElement).select()}
    />
  {/if}
  <button
    onclick={handleCopy}
    class="w-10 shrink-0 rounded-lg bg-surface-2 text-text-2 hover:bg-surface-3 hover:text-text-1 transition-colors duration-100 flex items-center justify-center"
    title="Copy"
  >
    {#if copied}
      <span class="i-lucide-check text-success"></span>
    {:else}
      <span class="i-lucide-copy"></span>
    {/if}
  </button>
</div>
