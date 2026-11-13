<script lang="ts">
  /**
   * Pictures and charts floating over the grid. They sit in the scrolling
   * area, so they scroll with the cells, and are cut off where frozen rows,
   * frozen columns and the headers cover them. A selected one can be moved,
   * resized, copied and deleted; someone who may only read can select and copy.
   */
  import { tick } from 'svelte';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { HEADER_HEIGHT, columnX, frozenHeight, frozenWidth, hitTest, rowY, type Viewport } from '../../lib/sheets/layout';
  import { MIN_OBJECT_SIZE, listObjects, placeObject, raiseObject, removeObject, type SheetObject } from '../../lib/sheets/objects';
  import type { MenuItem } from './PopupMenu.svelte';
  import { chartsNow, loadCharts } from './chartLoader';
  import { copyObject } from './objectClipboard';

  interface Props {
    ctl: SheetController;
    view: Viewport;
    /** The colour behind the cells, for charts to sit on. */
    background: string;
    dark: boolean;
    touch: boolean;
    onmenu: (x: number, y: number, items: MenuItem[]) => void;
    oneditchart: (id: string) => void;
  }
  let { ctl, view, background, dark, touch, onmenu, oneditchart }: Props = $props();

  type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
  const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  let objects = $derived.by(() => {
    void ctl.revision;
    void ctl.layoutRevision;
    return ctl.hasSheet ? listObjects(ctl.sheet) : [];
  });
  let chartsReady = $state(chartsNow() !== null);
  $effect(() => {
    if (!chartsReady && objects.some(object => object.content.kind === 'chart')) void loadCharts().then(() => { chartsReady = true; });
  });

  // One selected by pasting or inserting takes the keyboard, so Delete and copying act on it.
  $effect(() => {
    const id = ctl.selectedObject;
    if (!id) return;
    void tick().then(() => {
      const element = document.querySelector<HTMLElement>(`[data-object-id="${id}"]`);
      const active = document.activeElement;
      if (element && !element.contains(active) && !active?.closest('section[aria-label]')) element.focus({ preventScroll: true });
    });
  });

  /** An object being moved or resized: where it is shown until let go, in content pixels. */
  let drag = $state.raw<{ id: string; handle: Handle; pointer: number; startX: number; startY: number; scrollX: number; scrollY: number; box: Box; now: Box; moved: boolean } | null>(null);

  interface Box {
    x: number;
    y: number;
    width: number;
    height: number;
  }

  /** Where an object is in the scrolling area. Ones anchored in frozen rows or columns stay put. */
  function boxOf(object: SheetObject): Box {
    const { dx, dy, width, height } = object.placement;
    return {
      x: columnX(view, object.col) + view.scrollX + dx,
      y: rowY(view, object.row) + view.scrollY + dy,
      width,
      height,
    };
  }

  /** The part hidden under the headers or under frozen panes, as a CSS clip. */
  function clipOf(object: SheetObject, box: Box): string {
    const left = view.scrollX + view.headerWidth + (object.col >= view.freezeCols ? frozenWidth(view) : 0);
    const top = view.scrollY + HEADER_HEIGHT + (object.row >= view.freezeRows ? frozenHeight(view) : 0);
    const cutTop = Math.max(0, top - box.y);
    const cutLeft = Math.max(0, left - box.x);
    return cutTop > 0 || cutLeft > 0 ? `clip-path: inset(${cutTop}px 0 0 ${cutLeft}px)` : '';
  }

  function chartMarkup(object: SheetObject, box: Box): string {
    // Read first, so the drawing is made again once the chart code has loaded.
    void ctl.revision;
    if (!chartsReady) return '';
    const charts = chartsNow();
    if (!charts || object.content.kind !== 'chart') return '';
    const chart = object.content;
    const dataSheet = chart.sheet && ctl.book.nameOf(chart.sheet) !== undefined ? ctl.book.sheet(chart.sheet) : ctl.sheet;
    const theme = { ...(dark ? charts.DARK_CHART : charts.LIGHT_CHART), background };
    return charts.chartSvg(chart, charts.chartData(dataSheet, ctl.engine, chart), { width: Math.round(box.width), height: Math.round(box.height), theme, locale: ctl.engine.locale });
  }

  function select(object: SheetObject, element: HTMLElement): void {
    if (ctl.edit) ctl.commitEdit();
    ctl.selectedObject = object.id;
    element.focus({ preventScroll: true });
  }

  function onpointerdown(event: PointerEvent, object: SheetObject, handle: Handle): void {
    if (event.button !== 0) return;
    const element = (event.currentTarget as HTMLElement).closest('[data-object-id]') as HTMLElement;
    const wasSelected = ctl.selectedObject === object.id;
    select(object, element);
    event.stopPropagation();
    // A finger on a picture that is not selected yet only selects it, and can still scroll.
    if (!ctl.canEdit || (event.pointerType === 'touch' && !wasSelected)) return;
    event.preventDefault();
    const box = boxOf(object);
    drag = { id: object.id, handle, pointer: event.pointerId, startX: event.clientX, startY: event.clientY, scrollX: view.scrollX, scrollY: view.scrollY, box, now: box, moved: false };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }

  function onpointermove(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dx = event.clientX - drag.startX + (view.scrollX - drag.scrollX);
    const dy = event.clientY - drag.startY + (view.scrollY - drag.scrollY);
    if (!drag.moved && Math.hypot(dx, dy) < 3) return;
    const { box, handle } = drag;
    const object = objects.find(item => item.id === drag?.id);
    let { x, y, width, height } = box;
    if (handle === 'move') {
      x += dx;
      y += dy;
    } else {
      if (handle.includes('e')) width = box.width + dx;
      if (handle.includes('w')) width = box.width - dx;
      if (handle.includes('s')) height = box.height + dy;
      if (handle.includes('n')) height = box.height - dy;
      width = Math.max(MIN_OBJECT_SIZE, width);
      height = Math.max(MIN_OBJECT_SIZE, height);
      // A picture keeps its shape when pulled by a corner.
      if (object?.content.kind === 'picture' && handle.length === 2 && !event.shiftKey) {
        const ratio = box.width / box.height;
        if (width / height > ratio) height = width / ratio;
        else width = height * ratio;
      }
      if (handle.includes('w')) x = box.x + box.width - width;
      if (handle.includes('n')) y = box.y + box.height - height;
    }
    // Not past the first row and column.
    x = Math.max(view.headerWidth, x);
    y = Math.max(HEADER_HEIGHT, y);
    drag = { ...drag, moved: true, now: { x, y, width, height } };
  }

  function onpointerup(event: PointerEvent): void {
    if (!drag || event.pointerId !== drag.pointer) return;
    const finished = drag;
    drag = null;
    if (!finished.moved) return;
    const object = objects.find(item => item.id === finished.id);
    if (!object) return;
    const { x, y, width, height } = finished.now;
    // The cell the corner is now over, and how far into it.
    const screenX = x - view.scrollX;
    const screenY = y - view.scrollY;
    const frozenCol = object.col < view.freezeCols && finished.handle !== 'move';
    const frozenRow = object.row < view.freezeRows && finished.handle !== 'move';
    const hit = hitTest(view, Math.max(view.headerWidth, screenX), Math.max(HEADER_HEIGHT, screenY));
    const col = frozenCol ? object.col : hit.col;
    const row = frozenRow ? object.row : hit.row;
    const sheet = ctl.sheet;
    placeObject(sheet, object.id, {
      ...object.placement,
      row: sheet.rows.ids[row],
      col: sheet.cols.ids[col],
      dx: Math.max(0, screenX - columnX(view, col)),
      dy: Math.max(0, screenY - rowY(view, row)),
      width,
      height,
    });
  }

  function remove(object: SheetObject): void {
    if (!ctl.canEdit) return;
    removeObject(ctl.sheet, object.id);
    ctl.selectedObject = null;
    ctl.focusGrid();
  }

  function onkeydown(event: KeyboardEvent, object: SheetObject): void {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();
    if (key === 'escape') {
      ctl.selectedObject = null;
      ctl.focusGrid();
    } else if ((key === 'delete' || key === 'backspace') && ctl.canEdit) {
      remove(object);
    } else if (mod && (key === 'c' || key === 'x')) {
      void copyObject(ctl, object, key === 'x');
    } else if (mod && key === 'v') {
      // The paste lands in the grid, at the selected cell.
      ctl.selectedObject = null;
      ctl.focusGrid();
      return;
    } else if (mod && key === 'z') {
      if (event.shiftKey) ctl.redo();
      else ctl.undo();
    } else if (mod && key === 'y') {
      ctl.redo();
    } else if (key.startsWith('arrow') && ctl.canEdit) {
      const step = event.shiftKey ? 10 : 1;
      const box = boxOf(object);
      const moveX = key === 'arrowleft' ? -step : key === 'arrowright' ? step : 0;
      const moveY = key === 'arrowup' ? -step : key === 'arrowdown' ? step : 0;
      const screenX = Math.max(view.headerWidth, box.x - view.scrollX + moveX);
      const screenY = Math.max(HEADER_HEIGHT, box.y - view.scrollY + moveY);
      const hit = hitTest(view, screenX, screenY);
      const sheet = ctl.sheet;
      placeObject(sheet, object.id, {
        ...object.placement,
        row: sheet.rows.ids[hit.row],
        col: sheet.cols.ids[hit.col],
        dx: Math.max(0, screenX - columnX(view, hit.col)),
        dy: Math.max(0, screenY - rowY(view, hit.row)),
      });
    } else if (key === 'enter' && object.content.kind === 'chart' && ctl.canEdit) {
      oneditchart(object.id);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  function oncontextmenu(event: MouseEvent, object: SheetObject): void {
    event.preventDefault();
    event.stopPropagation();
    select(object, (event.currentTarget as HTMLElement));
    openMenu(object, event.clientX, event.clientY);
  }

  function openMenu(object: SheetObject, x: number, y: number): void {
    const items: MenuItem[] = [];
    if (object.content.kind === 'chart' && ctl.canEdit) items.push({ label: 'Edit chart', icon: 'i-lucide-chart-column', action: () => oneditchart(object.id), testId: 'object-edit-chart' });
    items.push({ label: 'Copy', icon: 'i-lucide-copy', action: () => void copyObject(ctl, object), testId: 'object-copy' });
    if (ctl.canEdit) {
      items.push({ label: 'Cut', icon: 'i-lucide-scissors', action: () => void copyObject(ctl, object, true), testId: 'object-cut' });
      if (object.content.kind === 'picture') {
        const { width, height } = object.content;
        items.push({
          label: 'Original size',
          icon: 'i-lucide-scaling',
          action: () => placeObject(ctl.sheet, object.id, { ...object.placement, width, height }),
          testId: 'object-original-size',
        });
      }
      items.push({ label: 'Bring to front', icon: 'i-lucide-bring-to-front', action: () => raiseObject(ctl.sheet, object.id), testId: 'object-front' });
      items.push({ label: 'Delete', icon: 'i-lucide-trash-2', divider: true, action: () => remove(object), testId: 'object-delete' });
    }
    onmenu(x, y, items);
  }

  /** A long press on a phone opens the same menu. */
  let pressTimer: ReturnType<typeof setTimeout> | undefined;
  function onTouchStart(event: TouchEvent, object: SheetObject): void {
    const point = event.touches[0];
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => {
      if (!drag?.moved) {
        drag = null;
        openMenu(object, point.clientX, point.clientY);
      }
    }, 550);
  }
</script>

{#each objects as object (object.id)}
  {@const shown = drag?.id === object.id ? drag.now : boxOf(object)}
  {@const selected = ctl.selectedObject === object.id}
  <div
    class="object"
    class:selected
    class:chart={object.content.kind === 'chart'}
    style="left: {shown.x}px; top: {shown.y}px; width: {shown.width}px; height: {shown.height}px; z-index: {selected ? 1000 : 1 + (object.placement.z ?? 0)}; touch-action: {selected && ctl.canEdit ? 'none' : 'pan-x pan-y'}; {clipOf(object, shown)}"
    data-object-id={object.id}
    data-testid={object.content.kind === 'chart' ? 'sheet-chart' : 'sheet-picture'}
    tabindex="0"
    role="button"
    aria-roledescription={object.content.kind}
    aria-label={object.content.kind === 'chart' ? `Chart${object.content.title ? `: ${object.content.title}` : ''}` : 'Picture'}
    onpointerdown={(event) => onpointerdown(event, object, 'move')}
    {onpointermove}
    {onpointerup}
    onpointercancel={onpointerup}
    ondblclick={() => { if (object.content.kind === 'chart' && ctl.canEdit) oneditchart(object.id); }}
    oncontextmenu={(event) => oncontextmenu(event, object)}
    ontouchstart={(event) => onTouchStart(event, object)}
    ontouchmove={() => clearTimeout(pressTimer)}
    ontouchend={() => clearTimeout(pressTimer)}
    onkeydown={(event) => onkeydown(event, object)}
  >
    {#if object.content.kind === 'picture'}
      {@const url = ctl.media?.urlOf(object.content.file)}
      {#if url}
        <img src={url} alt="" draggable="false" />
      {:else}
        <div class="placeholder"><span class="i-lucide-image text-2xl"></span></div>
      {/if}
    {:else}
      <!-- The drawing is made here from the cells, with every piece of text escaped. -->
      <!-- eslint-disable-next-line svelte/no-at-html-tags -->
      <div class="chart-body">{@html chartMarkup(object, shown)}</div>
    {/if}
    {#if selected && ctl.canEdit}
      {#each HANDLES as handle (handle)}
        <!-- Handles are for a pointer; the arrow keys move a selected one. -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <span
          class="handle {handle}"
          class:large={touch}
          data-handle={handle}
          onpointerdown={(event) => onpointerdown(event, object, handle)}
          {onpointermove}
          {onpointerup}
          onpointercancel={onpointerup}
        ></span>
      {/each}
    {/if}
  </div>
{/each}

<style>
  .object {
    position: absolute;
    outline: none;
    cursor: default;
    user-select: none;
    -webkit-user-select: none;
    -webkit-touch-callout: none;
  }

  .object img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: fill;
    pointer-events: none;
  }

  .object.chart {
    border-radius: 6px;
    box-shadow: 0 0 0 1px rgb(var(--surface-3) / 0.9);
    overflow: hidden;
  }

  .chart-body,
  .chart-body :global(svg) {
    display: block;
    width: 100%;
    height: 100%;
  }

  .placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 100%;
    background: rgb(var(--surface-2));
    color: rgb(var(--text-3));
  }

  .object.selected {
    box-shadow: 0 0 0 2px #916dfe;
    overflow: visible;
    cursor: move;
  }

  .object.selected .chart-body {
    border-radius: 6px;
    overflow: hidden;
  }

  .handle {
    position: absolute;
    width: 10px;
    height: 10px;
    margin: -5px 0 0 -5px;
    border-radius: 2px;
    background: #fff;
    border: 2px solid #916dfe;
    box-sizing: border-box;
    touch-action: none;
  }

  .handle.large {
    width: 20px;
    height: 20px;
    margin: -10px 0 0 -10px;
    border-radius: 50%;
  }

  .handle.nw { left: 0; top: 0; cursor: nwse-resize; }
  .handle.n { left: 50%; top: 0; cursor: ns-resize; }
  .handle.ne { left: 100%; top: 0; cursor: nesw-resize; }
  .handle.e { left: 100%; top: 50%; cursor: ew-resize; }
  .handle.se { left: 100%; top: 100%; cursor: nwse-resize; }
  .handle.s { left: 50%; top: 100%; cursor: ns-resize; }
  .handle.sw { left: 0; top: 100%; cursor: nesw-resize; }
  .handle.w { left: 0; top: 50%; cursor: ew-resize; }
</style>
