<script lang="ts" module>
  import type { PresenceState } from '../../lib/yjs/presence.svelte';

  /** What a copy says about where it is in a deck: its slide and the elements selected on it. */
  export interface SlidePlace {
    id: string;
    els: string[];
  }

  export function slidePlace(state: PresenceState): SlidePlace | null {
    const place = state.slide as SlidePlace | null | undefined;
    return place && typeof place.id === 'string' && Array.isArray(place.els) ? place : null;
  }

  /** The others on a slide. */
  export function onSlide(others: PresenceState[], slideId: string): PresenceState[] {
    return others.filter(state => slidePlace(state)?.id === slideId);
  }
</script>

<script lang="ts">
  /**
   * The elements others have selected on the slide being shown, outlined in
   * their colour and named. They never take a click.
   */
  import type { Slide } from '../../lib/slides/model';
  import FollowBadge from '../User/FollowBadge.svelte';

  interface Props {
    slide: Slide;
    others: PresenceState[];
    scale: number;
  }
  let { slide, others, scale }: Props = $props();

  let outlines = $derived(onSlide(others, slide.id).flatMap((state) => {
    const chosen = new Set(slidePlace(state)?.els ?? []);
    return slide.elements.filter(element => chosen.has(element.id)).map(element => ({
      key: `${state.clientId}:${element.id}`,
      clientId: state.clientId,
      element,
      name: state.user.name.trim() || 'Someone',
      color: state.user.color,
      npub: state.user.npub,
    }));
  }));
</script>

{#each outlines as outline (outline.key)}
  {@const element = outline.element}
  <div
    class="remote-outline"
    style:left="{element.x * scale}px"
    style:top="{element.y * scale}px"
    style:width="{element.w * scale}px"
    style:height="{element.h * scale}px"
    style:transform={element.rot ? `rotate(${element.rot}deg)` : undefined}
    style:border-color={outline.color}
    data-testid="slide-presence"
    data-name={outline.name}
    data-client={outline.clientId}
    data-element={element.id}
  >
    <span class="tag" style:background-color={outline.color} data-label={outline.name} aria-hidden="true">{#if outline.npub}<FollowBadge pubkey={outline.npub} size={10} />{/if}</span>
  </div>
{/each}

<style>
  .remote-outline {
    position: absolute;
    box-sizing: border-box;
    border: 2px solid;
    border-radius: 2px;
    /* Seen on dark slides and light ones alike. */
    box-shadow: 0 0 0 1px rgb(255 255 255 / 0.7);
    pointer-events: none;
  }

  .tag {
    position: absolute;
    bottom: 100%;
    left: -2px;
    padding: 0 4px;
    border-radius: 3px 3px 3px 0;
    color: #fff;
    font-size: 10px;
    font-weight: 600;
    line-height: 15px;
    white-space: nowrap;
    display: inline-flex;
    align-items: center;
    gap: 3px;
  }

  /* The name is not text of the slide. */
  .tag::before {
    content: attr(data-label);
  }
</style>
