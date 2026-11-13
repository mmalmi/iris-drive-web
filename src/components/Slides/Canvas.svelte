<script lang="ts">
  /**
   * The slide being worked on, scaled to fit, with everything done by hand on
   * it: selecting, moving, resizing, rotating, and stepping into a box to type.
   * A drag is shown as it goes and stored once, when it ends.
   */
  import { SLIDE_HEIGHT, SLIDE_WIDTH, type ElementProps, type Frame, type SlideElement } from '../../lib/slides/model';
  import {
    angleFromCentre,
    boxFromPoints,
    boxesOverlap,
    constrainLineEnd,
    fitScale,
    frameBox,
    frameCentre,
    resizeFrame,
    roundFrame,
    snapAngle,
    snapLines,
    snapMove,
    snapPoint,
    unionBox,
    type Box,
    type Guide,
    type Handle,
    type Point,
  } from '../../lib/slides/geometry';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import SlideView from './SlideView.svelte';

  interface Props {
    editorState: SlidesEditorState;
    urls: Map<string, string>;
    onImageFiles: (files: File[], at: Point) => void;
  }
  let { editorState, urls, onImageFiles }: Props = $props();

  const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const DRAG_START = 4;
  const SNAP_DISTANCE = 7;

  type Drag =
    | { kind: 'move'; start: Point; frames: Record<string, Frame>; moved: boolean; clicked: string | null; wasSelected: boolean }
    | { kind: 'resize'; start: Point; id: string; frame: Frame; handle: Handle; moved: boolean }
    | { kind: 'rotate'; id: string; frame: Frame; moved: boolean }
    | { kind: 'line-end'; id: string; frame: Frame; end: 'start' | 'end'; moved: boolean }
    | { kind: 'marquee'; start: Point; added: string[]; moved: boolean };

  let stage: HTMLElement | undefined = $state();
  let stageWidth = $state(0);
  let stageHeight = $state(0);
  let drag = $state.raw<Drag | null>(null);
  let overrides = $state.raw<Record<string, Partial<Frame>>>({});
  let guides = $state.raw<Guide[]>([]);
  let marquee = $state.raw<Box | null>(null);
  let dropping = $state(false);
  // The pointer is captured while dragging, so double clicks are told apart here.
  let lastClick = { id: '', time: 0 };
  let swipe: Point | null = null;

  let slide = $derived(editorState.current);
  let canEdit = $derived(editorState.canEdit);
  let margin = $derived(stageWidth < 640 ? 10 : 28);
  let scale = $derived(Math.max(0.05, fitScale(stageWidth, stageHeight, SLIDE_WIDTH, SLIDE_HEIGHT, margin)));
  let width = $derived(SLIDE_WIDTH * scale);
  let height = $derived(SLIDE_HEIGHT * scale);
  let left = $derived(Math.max(0, (stageWidth - width) / 2));
  let top = $derived(Math.max(0, (stageHeight - height) / 2));

  /** Selected elements as they are drawn right now, drag included. */
  let shown = $derived(
    editorState.selected.map(element => (overrides[element.id] ? { ...element, ...overrides[element.id] } : element)),
  );
  let single = $derived(shown.length === 1 ? shown[0]! : null);
  let editing = $derived(editorState.editingId);

  function toSlide(event: { clientX: number; clientY: number }): Point {
    const rect = stage!.getBoundingClientRect();
    return { x: (event.clientX - rect.left - left) / scale, y: (event.clientY - rect.top - top) / scale };
  }

  function elementAt(target: EventTarget | null): string | null {
    return (target as Element | null)?.closest?.('[data-el]')?.getAttribute('data-el') ?? null;
  }

  function otherBoxes(): Box[] {
    return (slide?.elements ?? []).filter(element => !editorState.selection.includes(element.id)).map(frameBox);
  }

  function frameOf(element: SlideElement): Frame {
    return { x: element.x, y: element.y, w: element.w, h: element.h, rot: element.rot };
  }

  function onPointerDown(event: PointerEvent): void {
    if (!stage || !slide || event.button !== 0) return;
    const target = event.target as HTMLElement;
    const point = toSlide(event);
    const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle;
    const id = elementAt(target);

    if (!canEdit) {
      // Looking only: a swipe turns the page.
      swipe = event.pointerType === 'mouse' ? null : { x: event.clientX, y: event.clientY };
      return;
    }
    // Inside the box being typed in, the pointer places the cursor and selects words.
    if (!handle && id && id === editing) return;

    event.preventDefault();
    stage.focus({ preventScroll: true });
    editorState.area = 'canvas';

    if (handle && single) {
      if (handle === 'move') {
        beginMove(point, null, true);
      } else if (handle === 'rotate') {
        drag = { kind: 'rotate', id: single.id, frame: frameOf(single), moved: false };
      } else if (handle === 'start' || handle === 'end') {
        drag = { kind: 'line-end', id: single.id, frame: frameOf(single), end: handle, moved: false };
      } else {
        drag = { kind: 'resize', start: point, id: single.id, frame: frameOf(single), handle: handle as Handle, moved: false };
      }
      stage.setPointerCapture(event.pointerId);
      return;
    }

    if (id) {
      const wasSelected = editorState.selection.includes(id);
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        editorState.select(wasSelected ? editorState.selection.filter(other => other !== id) : [...editorState.selection, id]);
        return;
      }
      if (!wasSelected) editorState.select([id]);
      else if (editing) editorState.stopEditing();
      beginMove(point, id, wasSelected);
      stage.setPointerCapture(event.pointerId);
      return;
    }

    const keep = event.shiftKey ? editorState.selection : [];
    editorState.select(keep);
    drag = { kind: 'marquee', start: point, added: keep, moved: false };
    stage.setPointerCapture(event.pointerId);
  }

  function beginMove(point: Point, clicked: string | null, wasSelected: boolean): void {
    const frames: Record<string, Frame> = {};
    for (const element of editorState.selected) frames[element.id] = frameOf(element);
    drag = { kind: 'move', start: point, frames, moved: false, clicked, wasSelected };
  }

  function onPointerMove(event: PointerEvent): void {
    const current = drag;
    if (!current || !slide) return;
    const point = toSlide(event);
    const threshold = SNAP_DISTANCE / scale;
    const free = event.metaKey || event.ctrlKey;

    if (current.kind === 'move') {
      let dx = point.x - current.start.x;
      let dy = point.y - current.start.y;
      if (!current.moved && Math.hypot(dx, dy) * scale < DRAG_START) return;
      current.moved = true;
      if (editing) editorState.stopEditing();
      if (event.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      const box = unionBox(Object.values(current.frames).map(frameBox));
      guides = [];
      if (box && !free) {
        const moved = { left: box.left + dx, right: box.right + dx, top: box.top + dy, bottom: box.bottom + dy };
        const snap = snapMove(moved, snapLines(otherBoxes(), SLIDE_WIDTH, SLIDE_HEIGHT), threshold);
        dx += snap.dx;
        dy += snap.dy;
        guides = snap.guides;
      }
      const next: Record<string, Partial<Frame>> = {};
      for (const [id, frame] of Object.entries(current.frames)) next[id] = { x: frame.x + dx, y: frame.y + dy };
      overrides = next;
    } else if (current.kind === 'resize') {
      current.moved = true;
      let dx = point.x - current.start.x;
      let dy = point.y - current.start.y;
      const element = slide.elements.find(candidate => candidate.id === current.id);
      // Pictures keep their proportions unless Shift says otherwise; everything else the other way round.
      const corner = current.handle.length === 2;
      const keepRatio = element?.type === 'image' ? corner && !event.shiftKey : event.shiftKey;
      guides = [];
      if (!free && !keepRatio && !event.altKey && current.frame.rot % 360 === 0) {
        const frame = current.frame;
        const snap = snapPoint({
          x: current.handle.includes('e') ? frame.x + frame.w + dx : current.handle.includes('w') ? frame.x + dx : undefined,
          y: current.handle.includes('s') ? frame.y + frame.h + dy : current.handle.includes('n') ? frame.y + dy : undefined,
        }, snapLines(otherBoxes(), SLIDE_WIDTH, SLIDE_HEIGHT), threshold);
        dx += snap.dx;
        dy += snap.dy;
        guides = snap.guides;
      }
      overrides = { [current.id]: resizeFrame(current.frame, current.handle, dx, dy, { keepRatio, fromCentre: event.altKey, minSize: 12 }) };
    } else if (current.kind === 'rotate') {
      current.moved = true;
      const angle = angleFromCentre(frameCentre(current.frame), point);
      overrides = { [current.id]: { rot: snapAngle(angle, event.shiftKey ? 15 : null) } };
    } else if (current.kind === 'line-end') {
      current.moved = true;
      const frame = current.frame;
      const fixed = current.end === 'end' ? { x: frame.x, y: frame.y } : { x: frame.x + frame.w, y: frame.y + frame.h };
      let freeEnd = point;
      guides = [];
      if (event.shiftKey) {
        freeEnd = constrainLineEnd(fixed, point);
      } else if (!free) {
        const snap = snapPoint(point, snapLines(otherBoxes(), SLIDE_WIDTH, SLIDE_HEIGHT), threshold);
        freeEnd = { x: point.x + snap.dx, y: point.y + snap.dy };
        guides = snap.guides;
      }
      overrides = {
        [current.id]: current.end === 'end'
          ? { w: freeEnd.x - fixed.x, h: freeEnd.y - fixed.y }
          : { x: freeEnd.x, y: freeEnd.y, w: fixed.x - freeEnd.x, h: fixed.y - freeEnd.y },
      };
    } else {
      if (!current.moved && Math.hypot(point.x - current.start.x, point.y - current.start.y) * scale < DRAG_START) return;
      current.moved = true;
      const box = boxFromPoints(current.start, point);
      marquee = box;
      const inside = slide.elements.filter(element => boxesOverlap(box, frameBox(element))).map(element => element.id);
      editorState.select([...new Set([...current.added, ...inside])]);
    }
  }

  function onPointerUp(event: PointerEvent): void {
    if (swipe) {
      const dx = event.clientX - swipe.x;
      const dy = event.clientY - swipe.y;
      swipe = null;
      if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.5) editorState.goBy(dx < 0 ? 1 : -1);
      return;
    }
    const current = drag;
    if (!current) return;
    drag = null;
    if (stage?.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
    const pending = overrides;
    overrides = {};
    guides = [];
    marquee = null;

    if (current.moved && current.kind !== 'marquee') {
      const changes: Record<string, ElementProps> = {};
      for (const [id, frame] of Object.entries(pending)) changes[id] = roundFrame(frame);
      if (Object.keys(changes).length) editorState.updateElements(changes);
      return;
    }
    // A click that was not a drag: on text, start typing where it landed; on a shape, a second click does.
    if (current.kind === 'move' && current.clicked && editorState.selection.length === 1) {
      const element = slide?.elements.find(candidate => candidate.id === current.clicked);
      const double = lastClick.id === current.clicked && event.timeStamp - lastClick.time < 450;
      lastClick = { id: current.clicked, time: event.timeStamp };
      if (element?.content && (element.type === 'text' || double)) {
        editorState.startEditing(element.id, { point: { x: event.clientX, y: event.clientY } });
      }
    }
  }

  function hasFiles(event: DragEvent): boolean {
    return !!event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  }

  function onDragOver(event: DragEvent): void {
    if (!canEdit || !hasFiles(event)) return;
    event.preventDefault();
    dropping = true;
  }

  function onDrop(event: DragEvent): void {
    dropping = false;
    if (!canEdit || !hasFiles(event)) return;
    event.preventDefault();
    const files = [...(event.dataTransfer?.files ?? [])].filter(file => file.type.startsWith('image/'));
    if (files.length) onImageFiles(files, toSlide(event));
  }

  const CURSORS = ['ns-resize', 'nesw-resize', 'ew-resize', 'nwse-resize'];
  /** The resize cursor that points the way a handle moves, turned with its frame. */
  function cursorFor(handle: Handle, rotation: number): string {
    const base = { n: 0, ne: 45, e: 90, se: 135, s: 180, sw: 225, w: 270, nw: 315 }[handle];
    return CURSORS[Math.round((((base + rotation) % 180) + 180) % 180 / 45) % 4]!;
  }

  function handleStyle(handle: Handle, element: Frame): string {
    const x = handle.includes('w') ? 0 : handle.includes('e') ? 100 : 50;
    const y = handle.includes('n') ? 0 : handle.includes('s') ? 100 : 50;
    return `left:${x}%;top:${y}%;cursor:${cursorFor(handle, element.rot)}`;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="stage"
  class:stage-editable={canEdit}
  class:stage-dropping={dropping}
  bind:this={stage}
  bind:clientWidth={stageWidth}
  bind:clientHeight={stageHeight}
  tabindex="0"
  role="application"
  aria-label="Slide"
  data-testid="slide-canvas"
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  ondragover={onDragOver}
  ondragleave={() => (dropping = false)}
  ondrop={onDrop}
>
  {#if slide && stageWidth > 0}
    <div class="sheet" style:left="{left}px" style:top="{top}px" style:width="{width}px" style:height="{height}px" data-testid="slide-sheet">
      <SlideView {slide} theme={editorState.theme} {urls} {width} {overrides} editorState={canEdit ? editorState : undefined} />

      {#if canEdit}
        <div class="overlay">
          {#each guides as guide, index (index)}
            {#if guide.axis === 'x'}
              <div class="guide" style:left="{guide.pos * scale}px" style:top="{guide.from * scale}px" style:height="{(guide.to - guide.from) * scale}px" style:width="1px"></div>
            {:else}
              <div class="guide" style:top="{guide.pos * scale}px" style:left="{guide.from * scale}px" style:width="{(guide.to - guide.from) * scale}px" style:height="1px"></div>
            {/if}
          {/each}

          {#each shown as element (element.id)}
            {#if element.type === 'line'}
              {#if single}
                <div class="knob" data-handle="start" style:left="{element.x * scale}px" style:top="{element.y * scale}px"></div>
                <div class="knob" data-handle="end" style:left="{(element.x + element.w) * scale}px" style:top="{(element.y + element.h) * scale}px"></div>
              {:else}
                {@const box = frameBox(element)}
                <div class="frame" style:left="{box.left * scale}px" style:top="{box.top * scale}px" style:width="{(box.right - box.left) * scale}px" style:height="{(box.bottom - box.top) * scale}px"></div>
              {/if}
            {:else}
              <div
                class="frame"
                class:frame-editing={editing === element.id}
                style:left="{element.x * scale}px"
                style:top="{element.y * scale}px"
                style:width="{element.w * scale}px"
                style:height="{element.h * scale}px"
                style:transform={element.rot ? `rotate(${element.rot}deg)` : undefined}
                data-testid="selection-frame"
              >
                {#if single}
                  {#if editing === element.id}
                    <!-- While typing, the box is moved by its border. -->
                    <div class="edge edge-top" data-handle="move"></div>
                    <div class="edge edge-right" data-handle="move"></div>
                    <div class="edge edge-bottom" data-handle="move"></div>
                    <div class="edge edge-left" data-handle="move"></div>
                  {/if}
                  <div class="rotate-stem"></div>
                  <div class="knob knob-rotate" data-handle="rotate" title="Rotate"></div>
                  {#each HANDLES as handle (handle)}
                    <!-- On a box that is small on screen the middle handles would crowd the corners. -->
                    {#if handle.length === 2 || ((handle === 'n' || handle === 's') ? element.w : element.h) * scale >= 44}
                      <div class="knob knob-square" data-handle={handle} style={handleStyle(handle, element)}></div>
                    {/if}
                  {/each}
                {/if}
              </div>
            {/if}
          {/each}

          {#if marquee}
            <div class="marquee" style:left="{marquee.left * scale}px" style:top="{marquee.top * scale}px" style:width="{(marquee.right - marquee.left) * scale}px" style:height="{(marquee.bottom - marquee.top) * scale}px"></div>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .stage {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: clip;
    outline: none;
    background: rgb(var(--surface-0));
  }

  .stage {
    touch-action: pan-y;
  }

  .stage-editable {
    touch-action: none;
  }

  .stage-dropping .sheet {
    outline: 2px solid #916dfe;
    outline-offset: 2px;
  }

  .sheet {
    position: absolute;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.16), 0 8px 24px rgb(0 0 0 / 0.1);
  }

  .stage-editable :global([data-el]) {
    cursor: move;
  }

  .stage-editable :global([data-el][data-type='text']) {
    cursor: text;
  }

  .overlay {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }

  .frame {
    position: absolute;
    box-sizing: border-box;
    outline: 1.5px solid #916dfe;
  }

  .frame-editing {
    outline-style: dashed;
  }

  .edge {
    position: absolute;
    pointer-events: auto;
    cursor: move;
  }

  .edge-top,
  .edge-bottom {
    left: 0;
    right: 0;
    height: 10px;
  }

  .edge-left,
  .edge-right {
    top: 0;
    bottom: 0;
    width: 10px;
  }

  .edge-top {
    top: -8px;
  }

  .edge-bottom {
    bottom: -8px;
  }

  .edge-left {
    left: -8px;
  }

  .edge-right {
    right: -8px;
  }

  .knob {
    position: absolute;
    width: 11px;
    height: 11px;
    margin: -5.5px 0 0 -5.5px;
    border: 1.5px solid #916dfe;
    border-radius: 50%;
    background: #fff;
    pointer-events: auto;
    cursor: crosshair;
  }

  /* A larger area than the eye sees, so handles are easy to hit, most of all by finger. */
  .knob::after {
    content: '';
    position: absolute;
    inset: -7px;
  }

  @media (pointer: coarse) {
    .knob::after {
      inset: -14px;
    }
  }

  .knob-square {
    border-radius: 2px;
  }

  .knob-rotate {
    left: 50%;
    top: -26px;
    cursor: grab;
  }

  .rotate-stem {
    position: absolute;
    left: 50%;
    top: -22px;
    width: 1.5px;
    height: 22px;
    margin-left: -0.75px;
    background: #916dfe;
  }

  .guide {
    position: absolute;
    background: #f0389b;
  }

  .marquee {
    position: absolute;
    border: 1px solid #916dfe;
    background: rgb(145 109 254 / 0.12);
  }
</style>
