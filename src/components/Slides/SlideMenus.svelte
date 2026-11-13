<script lang="ts">
  /** The menus that change whole slides: layouts for a new slide or this one, the background, and the deck's theme. */
  import { SLIDE_HEIGHT, SLIDE_WIDTH } from '../../lib/slides/model';
  import { LAYOUTS } from '../../lib/slides/layouts';
  import { THEMES, type Palette } from '../../lib/slides/themes';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import Popover from './Popover.svelte';
  import ColourPanel from './ColourPanel.svelte';
  import { TRANSITIONS } from '../../lib/slides/motion';

  interface Props {
    editorState: SlidesEditorState;
    palette: Palette;
    anchors: { layout?: HTMLElement; relayout?: HTMLElement; background?: HTMLElement; theme?: HTMLElement; motion?: HTMLElement };
    layoutOpen: boolean;
    relayoutOpen: boolean;
    backgroundOpen: boolean;
    themeOpen: boolean;
    motionOpen: boolean;
    /** Closes these and every other menu of the toolbar. */
    onDone: () => void;
  }
  let {
    editorState,
    palette,
    anchors,
    layoutOpen = $bindable(),
    relayoutOpen = $bindable(),
    backgroundOpen = $bindable(),
    themeOpen = $bindable(),
    motionOpen = $bindable(),
    onDone,
  }: Props = $props();

  let current = $derived(editorState.current);
  let several = $derived(editorState.pickedSlides.length > 1);

  function pick(action: () => void): void {
    onDone();
    action();
  }
</script>

{#snippet layoutChoices(prefix: string, current: string | undefined, choose: (id: string) => void)}
  <div class="layouts">
    {#each LAYOUTS as layout (layout.id)}
      <button class="layout" class:on={layout.id === current} onclick={() => pick(() => choose(layout.id))} data-testid="{prefix}-{layout.id}">
        <span class="layout-preview">
          {#each layout.elements as element, index (index)}
            <span
              class="layout-box"
              class:layout-title={element.role === 'title'}
              style:left="{(element.x ?? 0) / SLIDE_WIDTH * 100}%"
              style:top="{(element.y ?? 0) / SLIDE_HEIGHT * 100}%"
              style:width="{(element.w ?? 0) / SLIDE_WIDTH * 100}%"
              style:height="{(element.h ?? 0) / SLIDE_HEIGHT * 100}%"
            ></span>
          {/each}
        </span>
        <span class="layout-name">{layout.name}</span>
      </button>
    {/each}
  </div>
{/snippet}

<Popover bind:open={layoutOpen} anchor={anchors.layout} label="New slide">
  {@render layoutChoices('layout', undefined, id => editorState.addSlide(id))}
</Popover>

<Popover bind:open={relayoutOpen} anchor={anchors.relayout} label="Slide layout">
  {@render layoutChoices('relayout', editorState.current?.layout, id => editorState.setLayout(id))}
</Popover>

<Popover bind:open={backgroundOpen} anchor={anchors.background} label="Slide background">
  <ColourPanel
    value={editorState.current?.background}
    {palette}
    themeChoice="Theme background"
    themeColours={false}
    onPick={colour => pick(() => editorState.setBackground(colour))}
  />
</Popover>

<Popover bind:open={themeOpen} anchor={anchors.theme} label="Themes">
  <div class="themes">
    {#each THEMES as theme (theme.id)}
      <button class="theme" class:on={editorState.themeId === theme.id} onclick={() => pick(() => editorState.setTheme(theme.id))} data-testid="theme-{theme.id}">
        <span class="theme-preview" style:background={theme.base.background} style:color={theme.base.text} style:font-family={theme.titleFont}>
          <span class="theme-cover" style:background={theme.cover.background}></span>
          <span class="theme-sample" style:font-weight={theme.titleWeight}>Aa</span>
          <span class="theme-dot" style:background={theme.base.accent}></span>
        </span>
        <span class="layout-name">{theme.name}</span>
      </button>
    {/each}
  </div>
</Popover>

<Popover bind:open={motionOpen} anchor={anchors.motion} label="Transition">
  <div class="menu-label">{several ? 'How these slides come on screen' : 'How this slide comes on screen'}</div>
  {#each TRANSITIONS as choice (choice.id)}
    <button class="menu-item" onclick={() => editorState.setMotion({ transition: choice.id })} aria-pressed={(current?.transition ?? 'none') === choice.id} data-testid="transition-{choice.id}">
      <span class={choice.id === 'none' ? 'i-lucide-square' : choice.id === 'fade' ? 'i-lucide-blend' : 'i-lucide-move-right'}></span>{choice.label}
      {#if (current?.transition ?? 'none') === choice.id}<span class="i-lucide-check ml-auto"></span>{/if}
    </button>
  {/each}
  <div class="menu-divider"></div>
  <button class="menu-item" onclick={() => editorState.setMotion({ build: !current?.build })} aria-pressed={!!current?.build} data-testid="slide-build">
    <span class="i-lucide-list-start"></span>Show points one at a time
    {#if current?.build}<span class="i-lucide-check ml-auto"></span>{/if}
  </button>
  <div class="menu-divider"></div>
  <button
    class="menu-item"
    onclick={() => pick(() => editorState.setMotion({ transition: current?.transition ?? 'none', build: !!current?.build }, true))}
    data-testid="motion-everywhere"
  >
    <span class="i-lucide-copy-check"></span>Use for every slide
  </button>
</Popover>

<style>
  .layouts,
  .themes {
    display: grid;
    grid-template-columns: repeat(3, 104px);
    gap: 6px;
    padding: 4px;
  }

  .layout,
  .theme {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 5px;
    padding: 6px;
    border-radius: 8px;
  }

  .layout:hover,
  .theme:hover {
    background: rgb(var(--surface-2));
  }

  .theme.on,
  .layout.on {
    background: rgb(145 109 254 / 0.16);
  }

  .layout-preview,
  .theme-preview {
    position: relative;
    display: block;
    aspect-ratio: 16 / 9;
    border-radius: 4px;
    border: 1px solid rgb(128 128 128 / 0.35);
    background: #fff;
    overflow: hidden;
  }

  .layout-box {
    position: absolute;
    border-radius: 1.5px;
    background: #d5d6dc;
  }

  .layout-title {
    background: #8d8f9b;
  }

  .layout-name {
    font-size: 0.75rem;
    text-align: center;
    color: rgb(var(--text-1));
  }

  .theme-cover {
    position: absolute;
    left: 0;
    top: 0;
    bottom: 0;
    width: 34%;
  }

  .theme-sample {
    position: absolute;
    left: 44%;
    top: 50%;
    transform: translateY(-50%);
    font-size: 1.15rem;
    line-height: 1;
  }

  .theme-dot {
    position: absolute;
    right: 8px;
    bottom: 8px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
  }

  @media (max-width: 639px) {
    .layouts,
    .themes {
      grid-template-columns: repeat(2, 104px);
    }
  }
</style>
