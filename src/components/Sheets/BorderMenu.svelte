<script lang="ts" module>
  import type { BorderKind } from '../../lib/sheets/borders';

  /** The line last chosen, kept while the app is open. */
  let lastKind: BorderKind = 's';
  let lastColor = '';
</script>

<script lang="ts">
  /** Where to draw lines around and between the selected cells, and how they look. */
  import { onMount } from 'svelte';
  import type { BorderPlace } from '../../lib/sheets/borders';

  interface Props {
    x: number;
    y: number;
    onpick: (where: BorderPlace, line: string) => void;
    onclose: () => void;
  }
  let { x, y, onpick, onclose }: Props = $props();

  type Edge = 'top' | 'bottom' | 'left' | 'right' | 'h' | 'v';
  const PLACES: Array<{ where: BorderPlace; label: string; edges: Edge[] }> = [
    { where: 'all', label: 'All borders', edges: ['top', 'bottom', 'left', 'right', 'h', 'v'] },
    { where: 'inner', label: 'Inner borders', edges: ['h', 'v'] },
    { where: 'horizontal', label: 'Horizontal borders', edges: ['h'] },
    { where: 'vertical', label: 'Vertical borders', edges: ['v'] },
    { where: 'outer', label: 'Outer borders', edges: ['top', 'bottom', 'left', 'right'] },
    { where: 'left', label: 'Left border', edges: ['left'] },
    { where: 'top', label: 'Top border', edges: ['top'] },
    { where: 'right', label: 'Right border', edges: ['right'] },
    { where: 'bottom', label: 'Bottom border', edges: ['bottom'] },
    { where: 'none', label: 'No borders', edges: [] },
  ];
  const KINDS: Array<{ kind: BorderKind; label: string; width: number; dash: string }> = [
    { kind: 's', label: 'Thin', width: 1, dash: '' },
    { kind: 'm', label: 'Medium', width: 2, dash: '' },
    { kind: 'k', label: 'Thick', width: 3, dash: '' },
    { kind: 'd', label: 'Dashed', width: 1.5, dash: '4 2' },
    { kind: 'o', label: 'Dotted', width: 1.5, dash: '1.5 2' },
  ];
  const COLORS = ['', '#666666', '#b7b7b7', '#e03131', '#f59f00', '#2f9e44', '#1c7ed6', '#7048e8'];
  const COLOR_NAMES = ['Automatic', 'Grey', 'Light grey', 'Red', 'Yellow', 'Green', 'Blue', 'Violet'];
  const LINES: Record<Edge, string> = {
    top: 'M3 3H21',
    bottom: 'M3 21H21',
    left: 'M3 3V21',
    right: 'M21 3V21',
    h: 'M3 12H21',
    v: 'M12 3V21',
  };

  let kind = $state<BorderKind>(lastKind);
  let color = $state(lastColor);
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

  function pick(where: BorderPlace): void {
    lastKind = kind;
    lastColor = color;
    onpick(where, `${kind}${color}`);
    onclose();
  }
</script>

<!-- Pressing a choice must not take the cursor out of the grid. -->
<div
  bind:this={element}
  class="panel"
  class:placed
  style="left: {left}px; top: {top}px"
  role="dialog"
  tabindex="-1"
  aria-label="Borders"
  data-testid="sheet-borders-menu"
  onmousedown={event => event.preventDefault()}
>
  <div class="places">
    {#each PLACES as place (place.where)}
      <button type="button" class="place" title={place.label} aria-label={place.label} data-testid="border-{place.where}" onclick={() => pick(place.where)}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          {#each Object.entries(LINES) as [edge, path] (edge)}
            {#if !place.edges.includes(edge as Edge)}
              <path d={path} class="faint" />
            {/if}
          {/each}
          {#each place.edges as edge (edge)}
            <path d={LINES[edge]} class="strong" />
          {/each}
        </svg>
      </button>
    {/each}
  </div>
  <div class="line"></div>
  <div class="row" role="radiogroup" aria-label="Line">
    {#each KINDS as option (option.kind)}
      <button
        type="button"
        role="radio"
        aria-checked={kind === option.kind}
        class="kind"
        class:current={kind === option.kind}
        title={option.label}
        aria-label={option.label}
        data-testid="border-kind-{option.kind}"
        onclick={() => { kind = option.kind; }}
      >
        <svg viewBox="0 0 28 12" width="28" height="12" aria-hidden="true">
          <path d="M2 6H26" stroke-width={option.width} stroke-dasharray={option.dash} />
        </svg>
      </button>
    {/each}
  </div>
  <div class="row" role="radiogroup" aria-label="Line colour">
    {#each COLORS as swatch, index (swatch)}
      <button
        type="button"
        role="radio"
        aria-checked={color === swatch}
        class="swatch"
        class:auto={swatch === ''}
        class:current={color === swatch}
        style={swatch ? `background: ${swatch}` : ''}
        title={COLOR_NAMES[index]}
        aria-label={COLOR_NAMES[index]}
        data-testid="border-color-{swatch || 'auto'}"
        onclick={() => { color = swatch; }}
      ></button>
    {/each}
  </div>
</div>

<style>
  .panel {
    position: fixed;
    z-index: 60;
    padding: 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 8px;
    background: rgb(var(--surface-1));
    box-shadow: 0 6px 24px rgb(0 0 0 / 0.22);
    visibility: hidden;
  }

  .panel.placed {
    visibility: visible;
  }

  .places {
    display: grid;
    grid-template-columns: repeat(5, 36px);
    gap: 2px;
  }

  .place,
  .kind {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 36px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: rgb(var(--text-1));
    cursor: pointer;
  }

  .place:hover,
  .kind:hover {
    background: rgb(var(--surface-2));
  }

  .place path {
    fill: none;
    stroke-linecap: square;
  }

  .faint {
    stroke: rgb(var(--text-3));
    stroke-width: 1;
    stroke-dasharray: 1.5 2.5;
  }

  .strong {
    stroke: currentColor;
    stroke-width: 2.25;
  }

  .kind {
    width: 36px;
    height: 30px;
  }

  .kind path {
    stroke: currentColor;
    fill: none;
  }

  .kind.current {
    background: rgb(145 109 254 / 0.18);
    color: #916dfe;
  }

  .row {
    display: flex;
    gap: 2px;
    justify-content: space-between;
    margin-top: 6px;
  }

  .swatch {
    width: 22px;
    height: 22px;
    margin: 0 2px;
    padding: 0;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 50%;
    cursor: pointer;
  }

  .swatch.auto {
    background: linear-gradient(135deg, rgb(var(--text-1)) 50%, rgb(var(--surface-0)) 50%);
  }

  .swatch.current {
    outline: 2px solid #916dfe;
    outline-offset: 1px;
  }

  .line {
    height: 1px;
    margin: 6px 2px;
    background: rgb(var(--surface-2));
  }

  @media (pointer: coarse) {
    .places {
      grid-template-columns: repeat(5, 44px);
    }

    .place {
      height: 44px;
    }

    .kind {
      width: 44px;
      height: 36px;
    }

    .swatch {
      width: 28px;
      height: 28px;
    }
  }
</style>
