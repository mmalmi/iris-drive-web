<script lang="ts">
  /** Under a cell that links somewhere: where it goes, to open in a new tab, as Google Sheets shows it. */
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { HEADER_HEIGHT, rectOnScreen, type Viewport } from '../../lib/sheets/layout';
  import { shownAddress } from '../../lib/sheets/links';

  interface Props {
    ctl: SheetController;
    view: Viewport;
    /** How far down the grid shows, above an on-screen keyboard. */
    room: number;
  }
  let { ctl, view, room }: Props = $props();

  let chip = $derived.by(() => {
    void ctl.revision;
    if (!ctl.hasSheet || ctl.edit || ctl.selectedObject || ctl.commentFor) return null;
    const cell = ctl.activeRect;
    const selection = ctl.selection;
    if (selection.r1 !== cell.r1 || selection.r2 !== cell.r2 || selection.c1 !== cell.c1 || selection.c2 !== cell.c2) return null;
    const href = ctl.engine.linkAt(ctl.sheet, ctl.active.row, ctl.active.col);
    if (!href) return null;
    const box = rectOnScreen(view, cell);
    if (box.y + box.height <= HEADER_HEIGHT || box.y >= room || box.x + box.width <= view.headerWidth || box.x >= view.width) return null;
    const below = box.y + box.height + 40 <= room;
    return {
      href,
      left: Math.max(view.headerWidth + 4, Math.min(box.x, view.width - 300)),
      top: below ? box.y + box.height + 4 : Math.max(HEADER_HEIGHT, box.y - 36),
    };
  });
</script>

{#if chip}
  <!-- A press keeps the keyboard in the grid; the click still opens the link. -->
  <a
    class="link-chip"
    href={chip.href}
    target="_blank"
    rel="noopener noreferrer"
    style:left="{chip.left}px"
    style:top="{chip.top}px"
    title={chip.href}
    data-testid="sheet-link-chip"
    onmousedown={event => event.preventDefault()}
  >
    <span class="i-lucide-link shrink-0"></span><span class="address">{shownAddress(chip.href)}</span>
  </a>
{/if}

<style>
  .link-chip {
    position: absolute;
    z-index: 3;
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: 296px;
    height: 32px;
    padding: 0 12px;
    border-radius: 8px;
    background: rgb(var(--surface-0));
    box-shadow: 0 2px 10px rgb(0 0 0 / 0.22);
    color: #1155cc;
    font-size: 0.85rem;
    text-decoration: none;
  }

  .address {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .link-chip:hover .address {
    text-decoration: underline;
  }

  @media (prefers-color-scheme: dark) {
    .link-chip {
      background: rgb(var(--surface-2));
      color: #8ab4f8;
    }
  }
</style>
