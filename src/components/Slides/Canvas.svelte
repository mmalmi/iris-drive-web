<script lang="ts">
  /**
   * The slide being worked on, scaled to fit, with everything done by hand on
   * it: drawing new things, selecting, moving, resizing, rotating, and
   * stepping into a box to type. A drag is shown as it goes and stored once,
   * when it ends.
   */
  import { SLIDE_HEIGHT, SLIDE_WIDTH, type ElementOverride, type ElementProps, type Frame, type SlideElement } from '../../lib/slides/model';
  import { lineEdges } from '../../lib/slides/table';
  import { pickCells, resizeLine } from '../../lib/slides/tableEditing';
  import {
    angleFromCentre,
    boxFromPoints,
    boxesOverlap,
    constrainLineEnd,
    fitScale,
    frameBox,
    frameCentre,
    frameFromDrag,
    resizeFrame,
    rotateFrames,
    roundFrame,
    scaleFrames,
    snapAngle,
    snapLines,
    snapMove,
    snapPoint,
    unionBox,
    type Box,
    type GroupFrame,
    type Guide,
    type Handle,
    type Point,
  } from '../../lib/slides/geometry';
  import { TEXT_PAD_Y } from '../../lib/slides/fitText';
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import SlideView from './SlideView.svelte';
  import Overlay from './Overlay.svelte';
  import PresenceOutlines from './PresenceOutlines.svelte';
  import type { PresenceState } from '../../lib/yjs/presence.svelte';
  import { writePng } from '../../lib/pictures';

  interface Props {
    editorState: SlidesEditorState;
    urls: Map<string, string>;
    onImageFiles: (files: File[], at: Point) => void;
    /** Copies the selection; takes it off the slide too when `cut`. */
    onCopy: (cut: boolean) => void;
    onPaste: () => void;
    /** Others who have the deck open: what they selected on this slide is outlined. */
    others?: PresenceState[];
  }
  let { editorState, urls, onImageFiles, onCopy, onPaste, others = [] }: Props = $props();

  const DRAG_START = 4;
  const SNAP_DISTANCE = 7;

  /** "Copy image": the selected picture as itself, other selections or the whole slide as drawn. */
  function copyImage(): void {
    const png = import('./clipboardCopy').then(copy => copy.pngOfSelection(editorState, stage, urls));
    writePng(png).catch((error: unknown) => {
      console.error('[Slides] Could not copy the image:', error);
      editorState.notice = 'The image could not be copied.';
    });
  }

  type Drag =
    | { kind: 'move'; start: Point; frames: Record<string, Frame>; moved: boolean; clicked: string | null; wasSelected: boolean; cell: string | null }
    | { kind: 'resize'; start: Point; id: string; frame: Frame; handle: Handle; moved: boolean }
    | { kind: 'rotate'; id: string; frame: Frame; moved: boolean }
    | { kind: 'line-end'; id: string; frame: Frame; end: 'start' | 'end'; moved: boolean }
    | { kind: 'group-resize'; start: Point; frames: Record<string, GroupFrame>; box: Box; handle: Handle; moved: boolean }
    | { kind: 'group-rotate'; frames: Record<string, GroupFrame>; box: Box; from: number; moved: boolean }
    | { kind: 'draw'; start: Point; moved: boolean }
    | { kind: 'marquee'; start: Point; added: string[]; moved: boolean }
    /** The line between two columns or rows of a table, or its right or bottom edge: `index` counts lines from the first. */
    | { kind: 'table-line'; id: string; axis: 'cols' | 'rows'; index: number; start: Point; lengths: number[] | null; moved: boolean }
    /** Picking cells of a table by dragging across them. */
    | { kind: 'cells'; id: string; anchor: string; focus: string; moved: boolean; captured: boolean };

  let stage: HTMLElement | undefined = $state();
  let stageWidth = $state(0);
  let stageHeight = $state(0);
  let drag = $state.raw<Drag | null>(null);
  let overrides = $state.raw<Record<string, ElementOverride>>({});
  let guides = $state.raw<Guide[]>([]);
  let marquee = $state.raw<Box | null>(null);
  /** What is being drawn with a tool: a box, or for a line its two ends. */
  let sketch = $state.raw<Frame | null>(null);
  /** While a group is being turned: the box it had and how far it has turned. */
  let turning = $state.raw<{ box: Box; degrees: number } | null>(null);
  let dropping = $state(false);
  let menuAt = $state<Point | undefined>();
  let menuOpen = $state(false);
  // The pointer is captured while dragging, so double clicks are told apart here.
  let lastClick = { id: '', time: 0 };
  let swipe: Point | null = null;

  let slide = $derived(editorState.current);
  let canEdit = $derived(editorState.canEdit);
  let tool = $derived(canEdit ? editorState.tool : null);
  let margin = $derived(stageWidth < 640 ? 10 : 28);
  let scale = $derived(Math.max(0.05, fitScale(stageWidth, stageHeight, SLIDE_WIDTH, SLIDE_HEIGHT, margin)));
  let width = $derived(SLIDE_WIDTH * scale);
  let height = $derived(SLIDE_HEIGHT * scale);
  let left = $derived(Math.max(0, (stageWidth - width) / 2));
  let top = $derived(Math.max(0, (stageHeight - height) / 2));
  let editing = $derived(editorState.editingId);

  /** Frames drawn in place of the stored ones: what is being dragged, and the box being typed in as it grows with its text. */
  let drawn = $derived.by(() => {
    const growing = editing ? editorState.editingFrame : null;
    return editing && growing ? { ...overrides, [editing]: { ...growing, ...overrides[editing] } } : overrides;
  });
  /** Selected elements as they are drawn right now. */
  let shown = $derived(
    editorState.selected.map(element => (drawn[element.id] ? { ...element, ...drawn[element.id] } : element)),
  );
  let single = $derived(shown.length === 1 ? shown[0]! : null);
  /** The box around everything selected, when that is more than one thing. */
  let groupBox = $derived(shown.length > 1 ? unionBox(shown.map(frameBox)) : null);

  // The editor asks how tall a box's text is, to give it room after its width or its text's size changed.
  $effect(() => {
    editorState.measureText = (id) => {
      const inner = stage?.querySelector<HTMLElement>(`[data-el="${id}"] .el-text-inner`);
      return inner ? inner.offsetHeight + TEXT_PAD_Y * 2 : null;
    };
    return () => {
      editorState.measureText = undefined;
    };
  });

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

  function groupFrames(): Record<string, GroupFrame> {
    const frames: Record<string, GroupFrame> = {};
    for (const element of editorState.selected) frames[element.id] = { ...frameOf(element), line: element.type === 'line' };
    return frames;
  }

  function onPointerDown(event: PointerEvent): void {
    if (!stage || !slide || event.button !== 0) return;
    const target = event.target as HTMLElement;
    const point = toSlide(event);

    if (!canEdit) {
      // Looking only: a swipe turns the page.
      swipe = event.pointerType === 'mouse' ? null : { x: event.clientX, y: event.clientY };
      return;
    }
    const handle = target.closest<HTMLElement>('[data-handle]')?.dataset.handle;
    const groupHandle = target.closest<HTMLElement>('[data-group-handle]')?.dataset.groupHandle;
    const id = elementAt(target);
    const cell = target.closest('[data-cell]')?.getAttribute('data-cell') ?? null;
    // Inside the box being typed in, the pointer places the cursor and selects words; in a table, another cell is typed in instead.
    if (!tool && !handle && id && id === editing) {
      if (cell && event.shiftKey && editorState.editingCell) {
        // Shift and a click picks the cells from the one being typed in to this one.
        event.preventDefault();
        pickCells(editorState, id, editorState.editingCell, cell);
        return;
      }
      if (cell && cell !== editorState.editingCell) {
        event.preventDefault();
        editorState.startEditing(id, { cell, point: { x: event.clientX, y: event.clientY } });
      }
      // Dragging on from here into another cell picks cells instead of words.
      if (cell) drag = { kind: 'cells', id, anchor: cell, focus: cell, moved: false, captured: false };
      return;
    }

    event.preventDefault();
    stage.focus({ preventScroll: true });
    editorState.area = 'canvas';
    stage.setPointerCapture(event.pointerId);

    if (tool) {
      editorState.select([]);
      const snap = event.metaKey || event.ctrlKey ? null : snapPoint(point, snapLines(otherBoxes(), SLIDE_WIDTH, SLIDE_HEIGHT), SNAP_DISTANCE / scale);
      drag = { kind: 'draw', start: snap ? { x: point.x + snap.dx, y: point.y + snap.dy } : point, moved: false };
      return;
    }

    if (groupHandle && groupBox) {
      const frames = groupFrames();
      const box = unionBox(Object.values(frames).map(frameBox))!;
      if (groupHandle === 'rotate') {
        const centre = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
        drag = { kind: 'group-rotate', frames, box, from: angleFromCentre(centre, point), moved: false };
      } else {
        drag = { kind: 'group-resize', start: point, frames, box, handle: groupHandle as Handle, moved: false };
      }
      return;
    }

    if (handle && single && (handle.startsWith('col:') || handle.startsWith('row:'))) {
      drag = { kind: 'table-line', id: single.id, axis: handle.startsWith('col:') ? 'cols' : 'rows', index: Number(handle.slice(4)), start: point, lengths: null, moved: false };
      return;
    }

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
      return;
    }

    if (id) {
      const wasSelected = editorState.selection.includes(id);
      if (cell && single?.id === id && single.table) {
        // In a table already selected, a drag picks cells and Shift and a click picks up to the cell clicked.
        if (event.shiftKey) {
          pickCells(editorState, id, editorState.cellRange?.anchor ?? editorState.tableCell ?? cell, cell);
          stage.releasePointerCapture(event.pointerId);
          return;
        }
        drag = { kind: 'cells', id, anchor: cell, focus: cell, moved: false, captured: true };
        return;
      }
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        editorState.select(wasSelected ? editorState.selection.filter(other => other !== id) : [...editorState.selection, id]);
        stage.releasePointerCapture(event.pointerId);
        return;
      }
      if (!wasSelected) editorState.select([id]);
      else if (editing) editorState.stopEditing();
      beginMove(point, id, wasSelected, cell);
      return;
    }

    const keep = event.shiftKey ? editorState.selection : [];
    editorState.select(keep);
    drag = { kind: 'marquee', start: point, added: keep, moved: false };
  }

  function beginMove(point: Point, clicked: string | null, wasSelected: boolean, cell: string | null = null): void {
    const frames: Record<string, Frame> = {};
    for (const element of editorState.selected) frames[element.id] = frameOf(element);
    drag = { kind: 'move', start: point, frames, moved: false, clicked, wasSelected, cell };
  }

  function onPointerMove(event: PointerEvent): void {
    const current = drag;
    if (!current || !slide) return;
    const point = toSlide(event);
    const threshold = SNAP_DISTANCE / scale;
    const free = event.metaKey || event.ctrlKey;
    const far = (from: Point) => Math.hypot(point.x - from.x, point.y - from.y) * scale >= DRAG_START;

    if (current.kind === 'cells') {
      const under = document.elementFromPoint(event.clientX, event.clientY);
      const key = under?.closest('[data-cell]')?.getAttribute('data-cell');
      if (!key || under?.closest('[data-el]')?.getAttribute('data-el') !== current.id) return;
      if (!current.moved && key === current.anchor) return;
      if (!current.moved) {
        current.moved = true;
        if (!current.captured) {
          stage?.setPointerCapture(event.pointerId);
          current.captured = true;
        }
        window.getSelection()?.removeAllRanges();
      }
      if (key !== current.focus || !editorState.cellRange) {
        current.focus = key;
        pickCells(editorState, current.id, current.anchor, key);
      }
      return;
    }
    if (current.kind === 'table-line') {
      const element = slide.elements.find(candidate => candidate.id === current.id);
      const table = element?.table;
      if (!element || !table) return;
      current.moved = true;
      const cols = current.axis === 'cols';
      const { xs, ys } = lineEdges(table, element.w, element.h);
      const edges = cols ? xs : ys;
      const list = cols ? table.cols : table.rows;
      const lengths = list.map((_line, index) => edges[index + 1]! - edges[index]!);
      const least = cols ? 24 : 20;
      const delta = cols ? point.x - current.start.x : point.y - current.start.y;
      const at = current.index;
      // Between two columns the width is traded; a row border, like the table's own edges, makes the table bigger.
      const trade = cols && at < list.length;
      if (trade) {
        const pair = lengths[at - 1]! + lengths[at]!;
        const before = Math.min(pair - least, Math.max(least, lengths[at - 1]! + delta));
        lengths[at - 1] = before;
        lengths[at] = pair - before;
      } else {
        lengths[at - 1] = Math.max(least, lengths[at - 1]! + delta);
      }
      current.lengths = lengths;
      const sum = lengths.reduce((total, length) => total + length, 0);
      const sized = list.map((line, index) => ({ ...line, size: lengths[index]! }));
      const edge = lengths.slice(0, at).reduce((total, length) => total + length, 0);
      guides = [cols
        ? { axis: 'x', pos: element.x + edge, from: element.y - 12, to: element.y + element.h + 12 }
        : { axis: 'y', pos: element.y + edge, from: element.x - 12, to: element.x + element.w + 12 }];
      overrides = { [current.id]: { table: { ...table, [current.axis]: sized }, ...(trade ? {} : cols ? { w: sum } : { h: sum }) } };
      return;
    }
    if (current.kind === 'move') {
      let dx = point.x - current.start.x;
      let dy = point.y - current.start.y;
      if (!current.moved && !far(current.start)) return;
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
      const freeEnd = lineEnd(fixed, point, event);
      overrides = {
        [current.id]: current.end === 'end'
          ? { w: freeEnd.x - fixed.x, h: freeEnd.y - fixed.y }
          : { x: freeEnd.x, y: freeEnd.y, w: fixed.x - freeEnd.x, h: fixed.y - freeEnd.y },
      };
    } else if (current.kind === 'group-resize') {
      current.moved = true;
      overrides = scaleFrames(current.frames, current.box, current.handle, point.x - current.start.x, point.y - current.start.y, {
        keepRatio: event.shiftKey,
        fromCentre: event.altKey,
      });
    } else if (current.kind === 'group-rotate') {
      current.moved = true;
      const box = current.box;
      const centre = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
      const degrees = snapAngle(angleFromCentre(centre, point) - current.from, event.shiftKey ? 15 : null);
      overrides = rotateFrames(current.frames, centre, degrees);
      turning = { box, degrees };
    } else if (current.kind === 'draw') {
      if (!current.moved && !far(current.start)) return;
      current.moved = true;
      if (tool?.kind === 'line') {
        const end = lineEnd(current.start, point, event);
        sketch = { x: current.start.x, y: current.start.y, w: end.x - current.start.x, h: end.y - current.start.y, rot: 0 };
      } else {
        guides = [];
        let corner = point;
        if (!free && !event.shiftKey) {
          const snap = snapPoint(point, snapLines(otherBoxes(), SLIDE_WIDTH, SLIDE_HEIGHT), threshold);
          corner = { x: point.x + snap.dx, y: point.y + snap.dy };
          guides = snap.guides;
        }
        sketch = frameFromDrag(current.start, corner, event.shiftKey && tool?.kind === 'shape');
      }
    } else {
      if (!current.moved && !far(current.start)) return;
      current.moved = true;
      const box = boxFromPoints(current.start, point);
      marquee = box;
      const inside = slide.elements.filter(element => boxesOverlap(box, frameBox(element))).map(element => element.id);
      editorState.select([...new Set([...current.added, ...inside])]);
    }
  }

  /**
   * Where the free end of a line goes: held to 15° steps with Shift;
   * otherwise level or upright when it nearly is, and drawn to nearby lines.
   */
  function lineEnd(fixed: Point, point: Point, event: PointerEvent): Point {
    guides = [];
    if (event.shiftKey) return constrainLineEnd(fixed, point);
    if (event.metaKey || event.ctrlKey) return point;
    const threshold = SNAP_DISTANCE / scale;
    const level = Math.abs(point.y - fixed.y) <= threshold;
    const upright = !level && Math.abs(point.x - fixed.x) <= threshold;
    const snap = snapPoint(
      { x: upright ? undefined : point.x, y: level ? undefined : point.y },
      snapLines(otherBoxes(), SLIDE_WIDTH, SLIDE_HEIGHT),
      threshold,
    );
    guides = snap.guides;
    return { x: upright ? fixed.x : point.x + snap.dx, y: level ? fixed.y : point.y + snap.dy };
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
    const drew = sketch;
    overrides = {};
    guides = [];
    marquee = null;
    sketch = null;
    turning = null;

    if (current.kind === 'cells') {
      // A click without a drag types in the cell clicked.
      if (!current.moved && current.captured && event.type !== 'pointercancel') {
        editorState.startEditing(current.id, { cell: current.anchor, point: { x: event.clientX, y: event.clientY } });
      }
      return;
    }
    if (current.kind === 'table-line') {
      const element = slide?.elements.find(candidate => candidate.id === current.id);
      const list = current.axis === 'cols' ? element?.table?.cols : element?.table?.rows;
      const lengths = current.lengths;
      if (!list || !lengths || event.type === 'pointercancel') return;
      const at = current.index;
      const next = current.axis === 'cols' && at < list.length ? { id: list[at]!.id, length: lengths[at]! } : undefined;
      resizeLine(editorState, current.id, current.axis, list[at - 1]!.id, lengths[at - 1]!, next);
      return;
    }
    if (current.kind === 'draw') {
      if (event.type === 'pointercancel') return;
      if (current.moved && drew) editorState.useTool({ frame: drew });
      else editorState.useTool({ at: current.start });
      return;
    }
    if (current.moved && current.kind !== 'marquee') {
      const changes: Record<string, ElementProps> = {};
      for (const [id, frame] of Object.entries(pending)) {
        // A table's grid is stored by its own steps, never as a frame.
        changes[id] = roundFrame(Object.fromEntries(Object.entries(frame).filter(([key]) => key !== 'table')) as ElementProps);
      }
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
      } else if (element?.table && current.cell) {
        // A click in a table types in the cell it landed in.
        editorState.startEditing(element.id, { cell: current.cell, point: { x: event.clientX, y: event.clientY } });
      }
    }
  }

  function onContextMenu(event: MouseEvent): void {
    if (!canEdit) return;
    const id = elementAt(event.target);
    // The box being typed in keeps the browser's own menu, with its spelling and paste.
    if (id && id === editing) return;
    event.preventDefault();
    if (tool) editorState.armTool(null);
    if (id && !editorState.selection.includes(id)) editorState.select([id]);
    else if (!id) editorState.select([]);
    editorState.area = 'canvas';
    menuAt = { x: event.clientX, y: event.clientY };
    menuOpen = true;
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

</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  class="stage"
  class:stage-editable={canEdit}
  class:stage-dropping={dropping}
  class:stage-tool={!!tool}
  bind:this={stage}
  bind:clientWidth={stageWidth}
  bind:clientHeight={stageHeight}
  tabindex="0"
  role="application"
  aria-label="Slide"
  data-testid="slide-canvas"
  data-tool={tool?.kind}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  oncontextmenu={onContextMenu}
  ondragover={onDragOver}
  ondragleave={() => (dropping = false)}
  ondrop={onDrop}
>
  {#if slide && stageWidth > 0}
    <div class="sheet" style:left="{left}px" style:top="{top}px" style:width="{width}px" style:height="{height}px" data-testid="slide-sheet">
      <SlideView {slide} theme={editorState.theme} {urls} {width} overrides={drawn} editorState={canEdit ? editorState : undefined} />
      {#if others.length > 0}
        <PresenceOutlines {slide} {others} {scale} />
      {/if}

      {#if canEdit}
        <Overlay {shown} {single} {groupBox} {turning} {guides} {sketch} {tool} {marquee} {scale} {width} {height} {editing} />
      {/if}
    </div>
  {/if}
</div>

<!-- The menu of the slide is loaded apart, the first time it is opened. -->
{#if menuOpen}
  {#await import('./ElementMenu.svelte') then { default: ElementMenu }}
    <ElementMenu {editorState} bind:open={menuOpen} at={menuAt} {onCopy} {onPaste} onCopyImage={copyImage} onDone={() => stage?.focus({ preventScroll: true })} />
  {/await}
{/if}

<style>
  .stage {
    position: relative;
    flex: 1;
    min-width: 0;
    min-height: 0;
    overflow: clip;
    outline: none;
    background: rgb(var(--surface-0));
    touch-action: pan-y;
  }

  .stage-editable {
    touch-action: none;
  }

  /* On a phone held upright the slide sits at the top, as tall as it needs, and the notes take the room below. */
  @media (max-width: 639px) {
    .stage {
      flex: none;
      height: calc((100vw - 20px) * 9 / 16 + 20px);
    }
  }

  /* Reached by keyboard, the slide shows that keys now act on it. */
  .stage:focus-visible .sheet {
    outline: 2px solid rgb(145 109 254 / 0.6);
    outline-offset: 3px;
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

  .stage-editable :global([data-el][data-type='text']),
  .stage-editable :global([data-el][data-type='table']) {
    cursor: text;
  }

  /* With a tool in hand the whole slide is somewhere to draw. */
  .stage-tool,
  .stage-tool :global([data-el]),
  .stage-tool :global(.knob) {
    cursor: crosshair !important;
  }
</style>
