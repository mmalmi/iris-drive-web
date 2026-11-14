<script lang="ts">
  /**
   * The cells others who have the spreadsheet open have selected, outlined in
   * their colour with their name. It lies over the grid in the scrolling
   * area with the pictures, and never takes a click.
   */
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { rectOf } from '../../lib/sheets/address';
  import { HEADER_HEIGHT, rectOnScreen, type Viewport } from '../../lib/sheets/layout';
  import FollowBadge from '../User/FollowBadge.svelte';

  interface Props {
    ctl: SheetController;
    view: Viewport;
  }
  let { ctl, view }: Props = $props();

  /** What a copy says about its selection: the sheet, and the row and column ids of both corners. */
  interface SheetPlace {
    id: string;
    a: [string, string];
    f: [string, string];
  }

  function isPlace(value: unknown): value is SheetPlace {
    const place = value as SheetPlace | null;
    return !!place && typeof place.id === 'string' && Array.isArray(place.a) && Array.isArray(place.f);
  }

  let boxes = $derived.by(() => {
    void ctl.revision;
    void ctl.layoutRevision;
    const others = ctl.others();
    if (!ctl.hasSheet || others.length === 0) return [];
    const sheet = ctl.sheet;
    return others.flatMap((state) => {
      const place = state.sheet;
      if (!isPlace(place) || place.id !== ctl.sheetId) return [];
      const anchor = { row: sheet.rows.indexOf(place.a[0]), col: sheet.cols.indexOf(place.a[1]) };
      const focus = { row: sheet.rows.indexOf(place.f[0]), col: sheet.cols.indexOf(place.f[1]) };
      if (anchor.row < 0 || anchor.col < 0 || focus.row < 0 || focus.col < 0) return [];
      const box = rectOnScreen(view, rectOf(anchor, focus));
      const x = box.x + view.scrollX;
      const y = box.y + view.scrollY;
      // The part under the headers is not shown.
      const cutTop = Math.max(0, view.scrollY + HEADER_HEIGHT - y);
      const cutLeft = Math.max(0, view.scrollX + view.headerWidth - x);
      if (cutTop >= box.height || cutLeft >= box.width) return [];
      return [{
        clientId: state.clientId,
        name: state.user.name.trim() || 'Someone',
        color: state.user.color,
        npub: state.user.npub,
        x: x + cutLeft,
        y: y + cutTop,
        width: box.width - cutLeft,
        height: box.height - cutTop,
        tag: cutTop === 0,
      }];
    });
  });
</script>

{#each boxes as box (box.clientId)}
  <div
    class="remote-selection"
    style:left="{box.x}px"
    style:top="{box.y}px"
    style:width="{box.width}px"
    style:height="{box.height}px"
    style:border-color={box.color}
    data-testid="sheet-presence"
    data-name={box.name}
  >
    {#if box.tag}
      <span class="tag" style:background-color={box.color} data-label={box.name} aria-hidden="true">{#if box.npub}<FollowBadge pubkey={box.npub} size={10} />{/if}</span>
    {/if}
  </div>
{/each}

<style>
  .remote-selection {
    position: absolute;
    z-index: 1;
    box-sizing: border-box;
    border: 2px solid;
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

  /* The name is not text of the grid. */
  .tag::before {
    content: attr(data-label);
  }
</style>
