<script lang="ts">
  /** Colours to pick from: the theme's own, which follow it when the theme changes, a set of others, and any colour at all. */
  import { SWATCHES, THEME_COLOURS, resolveColour, type Palette } from '../../lib/slides/themes';

  interface Props {
    /** The stored colour, or undefined when the theme decides. */
    value: string | undefined;
    palette: Palette;
    /** Label of the choice that hands the colour back to the theme. */
    themeChoice?: string;
    allowNone?: boolean;
    allowOpacity?: boolean;
    /** Whether the theme's named colours are offered. */
    themeColours?: boolean;
    onPick: (colour: string | null) => void;
  }
  let { value, palette, themeChoice, allowNone = false, allowOpacity = false, themeColours = true, onPick }: Props = $props();

  let custom = $derived(resolveColour(value, palette) ?? palette.accent);
  let rgb = $derived(custom.length === 4 ? '#' + [...custom.slice(1)].map(channel => channel + channel).join('') : custom.slice(0, 7));
  let opacity = $derived(custom.length === 9 ? Math.round(parseInt(custom.slice(7), 16) / 255 * 100) : 100);

  function withOpacity(colour: string, percent: number): string {
    return percent === 100 ? colour : colour + Math.round(percent / 100 * 255).toString(16).padStart(2, '0');
  }
</script>

<div class="panel" data-testid="colour-panel">
  {#if themeChoice}
    <button class="menu-item" onclick={() => onPick(null)} data-testid="colour-theme">
      <span class="i-lucide-palette"></span>{themeChoice}
      {#if value === undefined}<span class="i-lucide-check ml-auto"></span>{/if}
    </button>
  {/if}
  {#if allowNone}
    <button class="menu-item" onclick={() => onPick('none')} data-testid="colour-none">
      <span class="i-lucide-ban"></span>None
      {#if value === 'none'}<span class="i-lucide-check ml-auto"></span>{/if}
    </button>
  {/if}
  {#if themeColours}
    <div class="row">
      {#each THEME_COLOURS as colour (colour.value)}
        <button
          class="swatch"
          class:on={value === colour.value}
          style:background={palette[colour.value]}
          title={colour.label}
          aria-label={colour.label}
          onclick={() => onPick(colour.value)}
        ></button>
      {/each}
    </div>
  {/if}
  <div class="grid">
    {#each SWATCHES as colour (colour)}
      <button
        class="swatch"
        class:on={value?.toLowerCase() === colour}
        style:background={colour}
        title={colour}
        aria-label={colour}
        data-colour={colour}
        onclick={() => onPick(colour)}
      ></button>
    {/each}
  </div>
  <label class="menu-item custom">
    <span class="i-lucide-pipette"></span>Other colour
    <input type="color" value={rgb} onchange={event => onPick(withOpacity(event.currentTarget.value, allowOpacity ? opacity : 100))} />
  </label>
  {#if allowOpacity && value !== 'none'}
    <label class="opacity-control">
      <span>Opacity</span>
      <input type="range" min="0" max="100" value={opacity} aria-label="Fill opacity" aria-valuetext={`${opacity}%`}
        onchange={event => onPick(withOpacity(rgb, event.currentTarget.valueAsNumber))} />
      <span>{opacity}%</span>
    </label>
  {/if}
</div>

<style>
  .panel {
    width: 196px;
  }

  .row,
  .grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    padding: 8px 10px;
  }

  .row {
    border-bottom: 1px solid rgb(var(--surface-3));
    margin-bottom: 2px;
  }

  .swatch {
    aspect-ratio: 1;
    border-radius: 50%;
    border: 1px solid rgb(128 128 128 / 0.45);
  }

  .swatch:hover {
    transform: scale(1.1);
  }

  .swatch.on {
    outline: 2px solid #916dfe;
    outline-offset: 2px;
  }

  .opacity-control {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    font-size: 12px;
  }

  .opacity-control input { min-width: 0; flex: 1; }

  .custom {
    position: relative;
    cursor: pointer;
  }

  .custom input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: pointer;
  }
</style>
