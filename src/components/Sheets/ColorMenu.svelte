<script lang="ts">
  /** A small palette to pick a text or fill colour from. */
  import { onMount } from 'svelte';

  interface Props {
    x: number;
    y: number;
    value: string | undefined;
    /** What the choice without a colour is called: "Default" for text, "No fill" for cells. */
    noneLabel: string;
    onpick: (color: string | null) => void;
    onclose: () => void;
  }
  let { x, y, value, noneLabel, onpick, onclose }: Props = $props();

  const COLORS = [
    '#000000', '#434343', '#666666', '#999999', '#b7b7b7', '#d9d9d9', '#f3f3f3', '#ffffff',
    '#e03131', '#f76707', '#f59f00', '#2f9e44', '#1098ad', '#1c7ed6', '#7048e8', '#c2255c',
    '#ffc9c9', '#ffd8a8', '#ffec99', '#b2f2bb', '#99e9f2', '#a5d8ff', '#d0bfff', '#fcc2d7',
    '#a51111', '#a84400', '#8f5d00', '#1b6b2c', '#0b6777', '#124f8c', '#4527a0', '#8a1741',
  ];
  const NAMES = [
    'Black', 'Dark grey', 'Grey', 'Mid grey', 'Light grey', 'Pale grey', 'Off-white', 'White',
    'Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Violet', 'Pink',
    'Light red', 'Light orange', 'Light yellow', 'Light green', 'Light teal', 'Light blue', 'Light violet', 'Light pink',
    'Dark red', 'Dark orange', 'Dark yellow', 'Dark green', 'Dark teal', 'Dark blue', 'Dark violet', 'Dark pink',
  ];

  let element: HTMLDivElement | undefined = $state();
  let left = $state(0);
  let top = $state(0);
  let placed = $state(false);

  onMount(() => {
    if (!element) return undefined;
    const { width, height } = element.getBoundingClientRect();
    left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
    top = Math.max(4, y + height > window.innerHeight - 4 ? y - height - 40 : y);
    placed = true;
    const outside = (event: Event) => {
      if (!element?.contains(event.target as Node)) onclose();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onclose();
    };
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('resize', onclose);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('resize', onclose);
    };
  });

  function pick(color: string | null): void {
    onclose();
    onpick(color);
  }
</script>

<!-- Pressing a colour must not take the cursor out of the grid. -->
<div
  bind:this={element}
  class="palette"
  class:placed
  style="left: {left}px; top: {top}px"
  role="dialog"
  tabindex="-1"
  aria-label="Colours"
  data-testid="sheet-colors"
  onmousedown={event => { if (!(event.target as HTMLElement).closest('input')) event.preventDefault(); }}
>
  <button type="button" class="none" onclick={() => pick(null)} data-testid="sheet-color-none">
    <span class="i-lucide-droplet-off"></span>
    {noneLabel}
  </button>
  <div class="swatches">
    {#each COLORS as color, index (color)}
      <button
        type="button"
        class="swatch"
        class:current={value?.toLowerCase() === color}
        style="background: {color}"
        title={NAMES[index]}
        aria-label={NAMES[index]}
        data-color={color}
        onclick={() => pick(color)}
      ></button>
    {/each}
  </div>
  <label class="custom">
    <span class="i-lucide-pipette"></span>
    Other colour
    <input type="color" value={value ?? '#916dfe'} onchange={event => pick(event.currentTarget.value)} />
  </label>
</div>

<style>
  .palette {
    position: fixed;
    z-index: 60;
    padding: 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 8px;
    background: rgb(var(--surface-1));
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.22);
    visibility: hidden;
  }

  .palette.placed {
    visibility: visible;
  }

  .swatches {
    display: grid;
    grid-template-columns: repeat(8, 24px);
    gap: 4px;
    margin: 8px 0;
  }

  .swatch {
    width: 24px;
    height: 24px;
    padding: 0;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 50%;
    cursor: pointer;
  }

  .swatch:hover {
    transform: scale(1.15);
  }

  .swatch.current {
    outline: 2px solid #916dfe;
    outline-offset: 1px;
  }

  .none,
  .custom {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 30px;
    padding: 0 6px;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: rgb(var(--text-1));
    font-size: 0.82rem;
    cursor: pointer;
  }

  .none:hover,
  .custom:hover {
    background: rgb(var(--surface-2));
  }

  .custom input {
    margin-left: auto;
    width: 28px;
    height: 22px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
  }
</style>
