<script lang="ts">
  /**
   * A panel for settings that stay open while working on the grid: at the
   * right on a wide screen, as a sheet from the bottom on a phone.
   */
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    onclose: () => void;
    testId?: string;
    children: Snippet;
  }
  let { title, onclose, testId, children }: Props = $props();

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onclose();
    }
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section class="panel" aria-label={title} data-testid={testId} {onkeydown}>
  <header>
    <h2>{title}</h2>
    <button class="btn-circle btn-ghost close" onclick={onclose} title="Close" aria-label="Close" data-testid="side-panel-close">
      <span class="i-lucide-x text-base"></span>
    </button>
  </header>
  <div class="body">
    {@render children()}
  </div>
</section>

<style>
  .panel {
    position: absolute;
    z-index: 30;
    top: 8px;
    right: 8px;
    bottom: 8px;
    width: 300px;
    display: flex;
    flex-direction: column;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 10px;
    background: rgb(var(--surface-1));
    box-shadow: 0 8px 28px rgb(0 0 0 / 0.22);
    color: rgb(var(--text-1));
    font-size: 0.85rem;
  }

  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 8px 4px 14px;
  }

  h2 {
    flex: 1;
    margin: 0;
    font-size: 0.95rem;
    font-weight: 600;
  }

  .close {
    width: 32px;
    height: 32px;
    min-width: 32px;
    min-height: 32px;
  }

  .body {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  /* A phone: a sheet from the bottom that leaves the top of the grid in view. */
  @media (max-width: 640px) {
    .panel {
      top: auto;
      left: 0;
      right: 0;
      bottom: 0;
      width: auto;
      max-height: 55%;
      border-radius: 14px 14px 0 0;
      border-bottom: none;
    }
  }

  .body :global(label.field) {
    display: flex;
    flex-direction: column;
    gap: 4px;
    color: rgb(var(--text-2));
    font-size: 0.8rem;
  }

  .body :global(input[type='text']),
  .body :global(input[type='number']),
  .body :global(input[type='date']),
  .body :global(select),
  .body :global(textarea) {
    width: 100%;
    min-height: 34px;
    padding: 6px 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: rgb(var(--surface-0));
    color: rgb(var(--text-1));
    font-size: 0.85rem;
    box-sizing: border-box;
  }

  .body :global(input:focus),
  .body :global(select:focus),
  .body :global(textarea:focus) {
    outline: 2px solid #916dfe;
    outline-offset: -1px;
  }

  .body :global(label.check) {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
  }

  .body :global(.choices) {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }

  .body :global(.choice) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 34px;
    padding: 0 10px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: transparent;
    color: rgb(var(--text-1));
    cursor: pointer;
  }

  .body :global(.choice.on) {
    border-color: #916dfe;
    background: rgb(145 109 254 / 0.15);
    color: #916dfe;
  }

  .body :global(.row) {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .body :global(.hint) {
    color: rgb(var(--text-3));
    font-size: 0.75rem;
  }
</style>
