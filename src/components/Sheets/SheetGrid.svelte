<script lang="ts">
  /**
   * The grid of cells: a canvas that shows the part in view, inside a
   * scrolling area as large as the whole sheet, with the box for typing laid
   * over the cell being edited.
   */
  import { onMount, tick } from 'svelte';
  import type { CellPos } from '../../lib/sheets/address';
  import {
    autoFitColumn,
    fillDownToNeighbours,
    fillInto,
    moveSelectedTo,
    resizeFrom,
  } from '../../lib/sheets/commands';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { buildLayout, placeEditor, readTheme, type SizeOverride } from '../../lib/sheets/gridView';
  import {
    HEADER_HEIGHT,
    columnX,
    dropPosition,
    rowY,
    filterButtonAt,
    frozenHeight,
    frozenWidth,
    hitTest,
    overFillHandle,
    scrollToShow,
    stretchTo,
    type Hit,
    type Viewport,
  } from '../../lib/sheets/layout';
  import { MIN_COL_WIDTH, MIN_ROW_HEIGHT } from '../../lib/sheets/model';
  import { drawGrid, fontOf, lineHeightOf, type GridTheme } from '../../lib/sheets/render';
  import { filterRect } from '../../lib/sheets/filter';
  import AddRowsButton from './AddRowsButton.svelte';
  import FilterMenu from './FilterMenu.svelte';
  import FindBar from './FindBar.svelte';
  import FormulaHelp from './FormulaHelp.svelte';
  import PopupMenu, { type MenuItem } from './PopupMenu.svelte';
  import { handleEditingKey, handleGridKey } from './gridKeys';
  import { listenToTouch, watchKeyboard, type TouchHost } from './gridTouch';
  import { installTestHandle } from './testHandle';
  import { selectForMenu, selectionMenu } from './menus';
  import ObjectLayer from './ObjectLayer.svelte';
  import { copyCells, pasteInto, pastedFrom } from './gridClipboard';
  import { controlHit, listMenu, phoneMenuSheet } from './gridControls';
  import { cellExtras } from '../../lib/sheets/extras';
  import { toggleCheckboxes } from '../../lib/sheets/ruleCommands';
  import './grid.css';

  interface Props {
    ctl: SheetController;
  }
  let { ctl }: Props = $props();

  const BOTTOM_ROOM = 64;
  const RIGHT_ROOM = 40;

  let root: HTMLDivElement | undefined = $state();
  let scroller: HTMLDivElement | undefined = $state();
  let canvas: HTMLCanvasElement | undefined = $state();
  let editor: HTMLTextAreaElement | undefined = $state();

  let width = $state(0);
  let height = $state(0);
  let scrollX = $state(0);
  let scrollY = $state(0);
  let pixelRatio = $state(1);
  let theme = $state.raw<GridTheme | null>(null);
  let dark = $state(false);
  let focused = $state(false);
  let resizing = $state.raw<SizeOverride | null>(null);
  let cursor = $state('default');
  let menu = $state.raw<{ x: number; y: number; items: MenuItem[]; sheet?: { top: number; bottom: number; reveal: (pixels: number) => number } } | null>(null);
  let dropLine = $state.raw<{ axis: 'row' | 'col'; position: number } | null>(null);
  let shiftHeld = false;
  /** The last press came from a finger: handles are sized for one, a tap selects, dragging scrolls. */
  let touchMode = $state(false);
  /** How much of the grid's bottom an on-screen keyboard covers. */
  let keyboardInset = $state(0);

  let layout = $derived.by(() => {
    void ctl.layoutRevision;
    return ctl.hasSheet ? buildLayout(ctl.sheet, ctl.engine, resizing, ctl.visibility) : null;
  });

  let view = $derived.by((): Viewport | null => {
    if (!layout || !ctl.hasSheet) return null;
    void ctl.layoutRevision;
    return {
      rows: layout.rows,
      cols: layout.cols,
      width,
      height,
      scrollX,
      scrollY,
      freezeRows: ctl.sheet.freezeRows,
      freezeCols: ctl.sheet.freezeCols,
      headerWidth: layout.headerWidth,
    };
  });

  /** Where this person's filter has its header row, and which of its columns filter. */
  let filterHeader = $derived.by(() => {
    void ctl.layoutRevision;
    const filter = ctl.filter;
    const rect = filter && ctl.hasSheet ? filterRect(ctl.sheet, filter) : null;
    if (!filter || !rect) return null;
    const active = new Set([...filter.columns.keys()].map(colId => ctl.sheet.cols.indexOf(colId)));
    return { row: rect.r1, c1: rect.c1, c2: rect.c2, active };
  });
  let filterMenu = $state.raw<{ colId: string; x: number; y: number } | null>(null);
  /** Opens the filter's choices when a point is on the button in one of its header cells. */
  function openFilterAt(hit: Hit, x: number, y: number): boolean {
    const header = filterHeader;
    if (!view || !canvas || !header || hit.area !== 'cell' || hit.row !== header.row || hit.col < header.c1 || hit.col > header.c2) return false;
    const button = filterButtonAt(view, hit.row, hit.col, x, y);
    if (!button) return false;
    const bounds = canvas.getBoundingClientRect();
    if (ctl.edit) ctl.commitEdit();
    filterMenu = { colId: ctl.sheet.cols.ids[hit.col], x: bounds.left + button.x, y: bounds.top + button.y };
    return true;
  }

  /** Conditional formats, checkboxes, lists and comment marks. */
  let extras = $derived.by(() => {
    void ctl.revision;
    void ctl.layoutRevision;
    return ctl.hasSheet ? cellExtras(ctl.sheet, ctl.engine) : null;
  });

  /** A press on a checkbox ticks it; one on a list's arrow shows its choices. */
  function pressControl(hit: Hit, x: number, y: number): boolean {
    if (!view || ctl.edit) return false;
    const control = controlHit(ctl, view, extras, hit, x, y);
    if (!control) return false;
    ctl.select({ row: hit.row, col: hit.col });
    if (control === 'checkbox') toggleCheckboxes(ctl, { row: ctl.active.row, col: ctl.active.col });
    else if (ctl.canEdit) ctl.openList(ctl.active.row, ctl.active.col);
    return true;
  }

  let contentWidth = $derived(layout ? layout.headerWidth + layout.cols.total + RIGHT_ROOM : 0);
  let contentHeight = $derived(layout ? HEADER_HEIGHT + layout.rows.total + BOTTOM_ROOM + keyboardInset : 0);

  // --- Drawing ---

  let frame = 0;
  function draw(): void {
    frame = 0;
    const context = canvas?.getContext('2d');
    if (!context || !view || !theme || !canvas) return;
    const edit = ctl.edit;
    const copied = ctl.copied && ctl.copied.sheetId === ctl.sheetId ? ctl.copied.rect : null;
    drawGrid(context, {
      ...view,
      sheet: ctl.sheet,
      engine: ctl.engine,
      selection: ctl.selection,
      active: ctl.active,
      editing: edit && edit.sheetId === ctl.sheetId ? { row: edit.row, col: edit.col } : null,
      copied,
      fillTarget: ctl.fillTarget,
      references: ctl.editReferences,
      showHandle: ctl.canEdit && !edit,
      focused: focused || edit !== null,
      showSelection: !edit || edit.sheetId === ctl.sheetId,
      dropLine,
      marks: ctl.find ? ctl.findMatches : [],
      filterHeader,
      filtered: ctl.visibility.filtered.size > 0,
      touch: touchMode,
      extras,
    }, theme, pixelRatio);
  }

  $effect(() => {
    // Everything the picture depends on; any change asks for one redraw.
    void [view, theme, pixelRatio, focused, dropLine, filterHeader, touchMode, extras, ctl.find, ctl.revision, ctl.anchor, ctl.focus, ctl.active, ctl.edit, ctl.copied, ctl.fillTarget, ctl.canEdit];
    if (!frame) frame = requestAnimationFrame(draw);
  });

  $effect(() => {
    if (!canvas) return;
    const w = Math.max(1, Math.round(width * pixelRatio));
    const h = Math.max(1, Math.round(height * pixelRatio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      draw();
    }
  });

  onMount(() => {
    if (!scroller || !root) return undefined;
    const measure = () => {
      if (!scroller) return;
      width = scroller.clientWidth;
      height = scroller.clientHeight;
      pixelRatio = window.devicePixelRatio || 1;
    };
    measure();
    theme = readTheme(root);
    dark = matchMedia('(prefers-color-scheme: dark)').matches;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    const scheme = matchMedia('(prefers-color-scheme: dark)');
    const onScheme = () => {
      if (root) theme = readTheme(root);
      dark = scheme.matches;
    };
    scheme.addEventListener('change', onScheme);
    const trackShift = (event: KeyboardEvent) => {
      shiftHeld = event.shiftKey;
    };
    window.addEventListener('keydown', trackShift, true);
    window.addEventListener('keyup', trackShift, true);

    ctl.reveal = (row, col) => {
      void tick().then(() => {
        if (!view || !scroller) return;
        // Where the grid really is: the copy in `view` lags a frame behind fast key presses.
        // Above an on-screen keyboard, not under it.
        const room = Math.max(HEADER_HEIGHT + 30, view.height - keyboardInset);
        const target = scrollToShow({ ...view, height: room, scrollX: scroller.scrollLeft, scrollY: scroller.scrollTop }, row, col);
        if (target.scrollX !== scroller.scrollLeft || target.scrollY !== scroller.scrollTop) scroller.scrollTo(target.scrollX, target.scrollY);
      });
    };
    ctl.scrollPosition = () => ({ scrollX: scroller?.scrollLeft ?? 0, scrollY: scroller?.scrollTop ?? 0 });
    ctl.restoreScroll = (x, y) => {
      void tick().then(() => scroller?.scrollTo(x, y));
    };
    ctl.focusGrid = () => editor?.focus({ preventScroll: true });
    ctl.openList = (row, col) => {
      if (!view || !canvas || !ctl.canEdit) return;
      const items = listMenu(ctl, row, col);
      if (items.length === 0) return;
      const bounds = canvas.getBoundingClientRect();
      const block = ctl.sheet.mergeAt(row, col) ?? { r1: row, c1: col, r2: row, c2: col };
      menu = { x: bounds.left + columnX(view, block.c1), y: bounds.top + rowY(view, block.r2) + view.rows.size(block.r2) + 2, items };
    };
    if (!matchMedia('(pointer: coarse)').matches) ctl.focusGrid();

    // An on-screen keyboard shrinks what can be seen; the cell being typed into stays above it.
    const stopKeyboard = watchKeyboard(scroller, (inset) => {
      if (inset === keyboardInset) return;
      keyboardInset = inset;
      const edit = ctl.edit;
      if (edit && edit.sheetId === ctl.sheetId) ctl.reveal(edit.row, edit.col);
    });

    const stopTouch = canvas ? listenToTouch(canvas, touchHost) : () => {};

    return () => {
      stopKeyboard();
      stopTouch();
      observer.disconnect();
      scheme.removeEventListener('change', onScheme);
      window.removeEventListener('keydown', trackShift, true);
      window.removeEventListener('keyup', trackShift, true);
      if (frame) cancelAnimationFrame(frame);
      stopAutoScroll();
    };
  });

  function onScroll(): void {
    if (!scroller) return;
    scrollX = scroller.scrollLeft;
    scrollY = scroller.scrollTop;
    // A menu stays open when it scrolled the grid itself, to keep its cell in view.
    if (menu && scroller.dataset.keepMenu !== '1') menu = null;
    delete scroller.dataset.keepMenu;
  }

  // --- The box for typing ---

  let editorBox = $derived.by(() => {
    const edit = ctl.edit;
    if (!view) return null;
    const room = height - keyboardInset;
    if (edit && edit.sheetId === ctl.sheetId) {
      const rect = ctl.sheet.mergeAt(edit.row, edit.col) ?? { r1: edit.row, c1: edit.col, r2: edit.row, c2: edit.col };
      return placeEditor(view, rect, ctl.sheet.styleAt(edit.row, edit.col), edit.text, room);
    }
    return placeEditor(view, ctl.activeRect, ctl.activeStyle, null, room);
  });

  // The textarea shows what the controller holds, also when a click on a cell or the bar changed it.
  $effect(() => {
    const edit = ctl.edit;
    if (!editor) return;
    const text = edit ? edit.text : '';
    if (editor.value !== text) editor.value = text;
    if (edit && edit.source === 'cell' && document.activeElement === editor
      && (editor.selectionStart !== edit.caret[0] || editor.selectionEnd !== edit.caret[1])) {
      editor.setSelectionRange(edit.caret[0], edit.caret[1]);
    }
  });

  function readCaret(): [number, number] {
    return [editor?.selectionStart ?? 0, editor?.selectionEnd ?? 0];
  }

  function onEditorInput(): void {
    if (!editor) return;
    if (!ctl.edit) {
      // Typing on a selected cell replaces what it holds.
      if (!ctl.startEdit({ text: editor.value })) editor.value = '';
      return;
    }
    ctl.setEditText(editor.value, readCaret(), 'cell');
  }

  function onEditorSelect(): void {
    const edit = ctl.edit;
    if (!edit || !editor || edit.source !== 'cell') return;
    const caret = readCaret();
    if (caret[0] !== edit.caret[0] || caret[1] !== edit.caret[1]) ctl.setEditText(edit.text, caret, 'cell');
  }

  function insertNewline(): void {
    if (!editor || !ctl.edit) return;
    const [start, end] = readCaret();
    const text = `${editor.value.slice(0, start)}\n${editor.value.slice(end)}`;
    ctl.setEditText(text, [start + 1, start + 1], 'cell');
  }

  // --- Keyboard ---

  function pageRows(): number {
    if (!view) return 10;
    return Math.max(1, Math.floor((view.height - HEADER_HEIGHT - frozenHeight(view)) / 24) - 1);
  }

  function onkeydown(event: KeyboardEvent): void {
    if (menu) {
      if (event.key === 'Escape') closeMenu();
      return;
    }
    const handled = ctl.edit ? handleEditingKey(ctl, event, insertNewline) : handleGridKey(ctl, event, pageRows());
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }

  // --- Clipboard ---

  function oncopy(event: ClipboardEvent): void {
    if (ctl.edit) return;
    event.preventDefault();
    copyCells(ctl, event);
  }

  function onpaste(event: ClipboardEvent): void {
    if (ctl.edit) return;
    event.preventDefault();
    pasteInto(ctl, pastedFrom(event.clipboardData), shiftHeld);
  }

  // --- Pointer ---

  type Drag =
    | { kind: 'select'; scope: 'cells' | 'rows' | 'cols' }
    | { kind: 'extend'; fixed: CellPos }
    | { kind: 'point'; anchor: CellPos }
    | { kind: 'fill' }
    | { kind: 'move'; axis: 'row' | 'col'; origin: number; moved: boolean; hit: Hit }
    | { kind: 'resize'; axis: 'row' | 'col'; index: number; origin: number; startSize: number; moved: boolean };
  let drag: Drag | null = null;
  let lastPointer = { x: 0, y: 0 };
  let autoScrollTimer: ReturnType<typeof setInterval> | undefined;
  let lastTap = { time: 0, row: -1, col: -1 };

  function localPoint(event: { clientX: number; clientY: number }): { x: number; y: number } {
    const bounds = (canvas as HTMLCanvasElement).getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function onFillHandle(x: number, y: number): boolean {
    return !!view && ctl.canEdit && !ctl.edit && overFillHandle(view, ctl.selection, x, y);
  }

  /** Whether a header that was pressed belongs to whole rows or columns already selected, which a drag then moves. */
  function movable(hit: Hit): 'row' | 'col' | null {
    const rect = ctl.selection;
    if (!ctl.canEdit) return null;
    if (hit.area === 'colHeader' && ctl.scope === 'cols' && hit.col >= rect.c1 && hit.col <= rect.c2) return 'col';
    if (hit.area === 'rowHeader' && ctl.scope === 'rows' && hit.row >= rect.r1 && hit.row <= rect.r2) return 'row';
    return null;
  }

  function takeFocus(): void {
    if (ctl.edit?.source === 'bar') return;
    ctl.focusGrid();
  }

  function selectAt(hit: Hit, extend: boolean): Drag | null {
    if (hit.area === 'corner') {
      ctl.selectAll();
      return null;
    }
    if (hit.area === 'colHeader') {
      ctl.selectCols(extend && ctl.scope === 'cols' ? ctl.anchor.col : hit.col, hit.col);
      return { kind: 'select', scope: 'cols' };
    }
    if (hit.area === 'rowHeader') {
      ctl.selectRows(extend && ctl.scope === 'rows' ? ctl.anchor.row : hit.row, hit.row);
      return { kind: 'select', scope: 'rows' };
    }
    ctl.select({ row: hit.row, col: hit.col }, extend);
    return { kind: 'select', scope: 'cells' };
  }

  /** Where a formula being typed points to for a press on a cell: a merged block by its first cell. */
  function pointedCell(hit: Hit): CellPos {
    const merge = ctl.sheet.mergeAt(hit.row, hit.col);
    return merge ? { row: merge.r1, col: merge.c1 } : { row: hit.row, col: hit.col };
  }

  function onpointerdown(event: PointerEvent): void {
    if (!view || !canvas) return;
    touchMode = event.pointerType === 'touch';
    if (touchMode || event.button !== 0) return;
    event.preventDefault();
    menu = null;
    ctl.selectedObject = null;
    const { x, y } = localPoint(event);
    lastPointer = { x, y };
    const hit = hitTest(view, x, y);
    if (!(ctl.edit && ctl.pointing) && openFilterAt(hit, x, y)) return;
    if (pressControl(hit, x, y)) {
      takeFocus();
      return;
    }

    if (ctl.edit) {
      if (hit.area === 'cell' && ctl.pointing) {
        const cell = pointedCell(hit);
        ctl.pointDrag(cell, cell);
        drag = { kind: 'point', anchor: cell };
        canvas.setPointerCapture(event.pointerId);
        return;
      }
      ctl.commitEdit();
    }
    takeFocus();

    if (ctl.canEdit && (hit.colEdge !== null || hit.rowEdge !== null)) {
      const axis = hit.colEdge !== null ? 'col' : 'row';
      const index = (hit.colEdge ?? hit.rowEdge) as number;
      drag = {
        kind: 'resize',
        axis,
        index,
        origin: axis === 'col' ? x : y,
        startSize: axis === 'col' ? view.cols.size(index) : view.rows.size(index),
        moved: false,
      };
    } else if (hit.area === 'cell' && onFillHandle(x, y)) {
      drag = { kind: 'fill' };
    } else if (movable(hit) && !event.shiftKey) {
      const axis = movable(hit) as 'row' | 'col';
      drag = { kind: 'move', axis, origin: axis === 'col' ? x : y, moved: false, hit };
    } else {
      drag = selectAt(hit, event.shiftKey);
    }
    if (drag) canvas.setPointerCapture(event.pointerId);
  }

  function dragTo(x: number, y: number): void {
    if (!view || !drag) return;
    const hit = hitTest(view, Math.max(view.headerWidth + 1, x), Math.max(HEADER_HEIGHT + 1, y));
    if (drag.kind === 'resize') {
      const delta = (drag.axis === 'col' ? x : y) - drag.origin;
      if (Math.abs(delta) > 2) drag.moved = true;
      const least = drag.axis === 'col' ? MIN_COL_WIDTH : MIN_ROW_HEIGHT;
      if (drag.moved) resizing = { axis: drag.axis, index: drag.index, size: Math.max(least, Math.round(drag.startSize + delta)) };
    } else if (drag.kind === 'point') {
      ctl.pointDrag(drag.anchor, { row: hit.row, col: hit.col });
    } else if (drag.kind === 'extend') {
      ctl.setSelection(drag.fixed, { row: hit.row, col: hit.col }, ctl.active);
    } else if (drag.kind === 'fill') {
      ctl.fillTarget = stretchTo(ctl.selection, hit.row, hit.col);
    } else if (drag.kind === 'move') {
      if (Math.abs((drag.axis === 'col' ? x : y) - drag.origin) > 4) drag.moved = true;
      const rect = ctl.selection;
      const [from, to] = drag.axis === 'col' ? [rect.c1, rect.c2] : [rect.r1, rect.r2];
      const position = drag.moved ? dropPosition(view, drag.axis, from, to, x, y) : null;
      dropLine = position === null ? null : { axis: drag.axis, position };
      cursor = 'grabbing';
    } else if (drag.scope === 'cols') {
      ctl.selectCols(ctl.anchor.col, hit.col);
    } else if (drag.scope === 'rows') {
      ctl.selectRows(ctl.anchor.row, hit.row);
    } else {
      ctl.select({ row: hit.row, col: hit.col }, true);
    }
  }

  function stopAutoScroll(): void {
    if (autoScrollTimer) clearInterval(autoScrollTimer);
    autoScrollTimer = undefined;
  }

  /** Dragging past the edge of the grid scrolls it. */
  function autoScroll(): void {
    if (!view || !scroller || !drag || drag.kind === 'resize') {
      stopAutoScroll();
      return;
    }
    const alongRows = (drag.kind === 'select' && drag.scope === 'rows') || (drag.kind === 'move' && drag.axis === 'row');
    const alongCols = (drag.kind === 'select' && drag.scope === 'cols') || (drag.kind === 'move' && drag.axis === 'col');
    const { x, y } = lastPointer;
    const dx = x > view.width - 12 ? 28 : x < view.headerWidth + frozenWidth(view) + 12 && scrollX > 0 ? -28 : 0;
    const dy = y > view.height - 12 ? 24 : y < HEADER_HEIGHT + frozenHeight(view) + 12 && scrollY > 0 ? -24 : 0;
    if (dx === 0 && dy === 0) {
      stopAutoScroll();
      return;
    }
    scroller.scrollBy(alongRows ? 0 : dx, alongCols ? 0 : dy);
    scrollX = scroller.scrollLeft;
    scrollY = scroller.scrollTop;
    dragTo(x, y);
    if (!autoScrollTimer) autoScrollTimer = setInterval(autoScroll, 40);
  }

  function onpointermove(event: PointerEvent): void {
    if (!view || event.pointerType === 'touch') return;
    const { x, y } = localPoint(event);
    lastPointer = { x, y };
    if (drag) {
      dragTo(x, y);
      autoScroll();
      return;
    }
    const hit = hitTest(view, x, y);
    if (ctl.canEdit && hit.colEdge !== null) cursor = 'col-resize';
    else if (ctl.canEdit && hit.rowEdge !== null) cursor = 'row-resize';
    else if (hit.area === 'cell' && onFillHandle(x, y)) cursor = 'crosshair';
    else if (hit.area === 'cell') cursor = ctl.pointing ? 'cell' : 'default';
    else if (movable(hit)) cursor = 'grab';
    else cursor = hit.area === 'colHeader' ? 's-resize' : hit.area === 'rowHeader' ? 'e-resize' : 'default';
  }

  function onpointerup(event: PointerEvent): void {
    if (!drag) return;
    if (canvas?.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    finishDrag();
  }

  function finishDrag(): void {
    if (!drag) return;
    const finished = drag;
    drag = null;
    stopAutoScroll();
    if (finished.kind === 'resize') {
      const size = resizing?.size;
      resizing = null;
      if (size !== undefined && finished.moved) resizeFrom(ctl, finished.axis, finished.index, size);
    } else if (finished.kind === 'fill') {
      const target = ctl.fillTarget;
      ctl.fillTarget = null;
      if (target) fillInto(ctl, target);
    } else if (finished.kind === 'move') {
      const drop = dropLine;
      dropLine = null;
      cursor = 'default';
      // A press without a drag is a plain click on that header.
      if (!finished.moved) selectAt(finished.hit, false);
      else if (drop) moveSelectedTo(ctl, drop.axis, drop.position);
    }
  }

  function ondblclick(event: MouseEvent): void {
    if (!view) return;
    const { x, y } = localPoint(event);
    const hit = hitTest(view, x, y);
    if (hit.colEdge !== null) autoFitColumn(ctl, hit.colEdge);
    else if (hit.rowEdge !== null) ctl.sheet.setRowHeight(hit.rowEdge, hit.rowEdge, null);
    else if (hit.area === 'cell' && onFillHandle(x, y)) fillDownToNeighbours(ctl);
    else if (hit.area === 'cell' && !ctl.edit) {
      ctl.select({ row: hit.row, col: hit.col });
      if (ctl.startEdit()) ctl.focusGrid();
    }
  }

  /** A tap on a touch screen selects; a second tap on the same cell opens it for typing. */
  function onclick(event: MouseEvent): void {
    if (!view || !touchMode) return;
    const { x, y } = localPoint(event);
    tapAt(x, y);
  }

  function tapAt(x: number, y: number): void {
    if (!view) return;
    const hit = hitTest(view, x, y);
    menu = null;
    ctl.selectedObject = null;
    if (!(ctl.edit && ctl.pointing) && openFilterAt(hit, x, y)) return;
    if (pressControl(hit, x, y)) return;
    if (ctl.edit) {
      if (hit.area === 'cell' && ctl.pointing) {
        const cell = pointedCell(hit);
        ctl.pointDrag(cell, cell);
        return;
      }
      ctl.commitEdit();
    }
    const now = performance.now();
    const cell = pointedCell(hit);
    const again = hit.area === 'cell' && lastTap.row === cell.row && lastTap.col === cell.col && now - lastTap.time < 450;
    lastTap = { time: now, row: cell.row, col: cell.col };
    if (again && ctl.canEdit) {
      if (ctl.startEdit()) ctl.focusGrid();
      return;
    }
    selectAt(hit, false);
    // No keyboard pops up for looking around; a hardware keyboard still works.
    root?.focus({ preventScroll: true });
  }

  function oncontextmenu(event: MouseEvent): void {
    if (!view) return;
    event.preventDefault();
    // A long press brings its own menu up (see gridTouch.ts).
    if (touchMode) return;
    const { x, y } = localPoint(event);
    openMenuAt(hitTest(view, x, y), event.clientX, event.clientY);
  }

  /** Selects what a right click or long press is on, unless it is already selected, and shows what can be done with it. */
  function openMenuAt(hit: Hit, clientX: number, clientY: number): void {
    if (ctl.edit) ctl.commitEdit();
    const items = selectionMenu(ctl, selectForMenu(ctl, hit), touchMode);
    // On a phone the menu is a sheet from the bottom that keeps the pressed cell in view.
    const sheet = touchMode && view && canvas && scroller ? phoneMenuSheet(view, canvas, scroller, hit) : null;
    menu = { x: clientX, y: clientY, items, sheet: sheet ?? undefined };
  }

  // --- Touch (see gridTouch.ts) ---

  const touchHost: TouchHost = {
    get ctl() { return ctl; },
    view: () => view,
    local: localPoint,
    touched: (x, y) => {
      touchMode = true;
      lastPointer = { x, y };
    },
    grab: (what) => {
      menu = null;
      drag = what.kind === 'resize' ? { ...what, moved: false } : what;
    },
    dragging: () => drag !== null,
    dragTo: (x, y) => {
      lastPointer = { x, y };
      dragTo(x, y);
      autoScroll();
    },
    release: finishDrag,
    letGo: () => {
      drag = null;
      resizing = null;
    },
    tap: tapAt,
    longPress: (x, y, clientX, clientY) => {
      if (view) openMenuAt(hitTest(view, x, y), clientX, clientY);
    },
  };

  function closeMenu(): void {
    menu = null;
    if (!matchMedia('(pointer: coarse)').matches) ctl.focusGrid();
  }

  /** Keys reach the grid itself when a touch left the typing box unfocused. */
  function onRootKeydown(event: KeyboardEvent): void {
    if (event.target !== root) return;
    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && ctl.canEdit) {
      ctl.focusGrid();
      return;
    }
    onkeydown(event);
  }

  let addRowsTop = $derived(layout ? HEADER_HEIGHT + layout.rows.total + 14 : 0);
  let activeText = $derived.by(() => {
    void ctl.revision;
    return ctl.hasSheet ? ctl.engine.textAt(ctl.sheet, ctl.active.row, ctl.active.col) : '';
  });

  if (import.meta.env.VITE_TEST_MODE) {
    installTestHandle(() => ctl, () => (view && canvas && scroller ? { view: { ...view, scrollX: scroller.scrollLeft, scrollY: scroller.scrollTop }, canvas } : null));
  }
</script>

<div
  bind:this={root}
  class="grid-root"
  tabindex="-1"
  data-testid="sheet-grid"
  role="grid"
  aria-label="Cells"
  aria-rowcount={layout?.rows.count}
  aria-colcount={layout?.cols.count}
  onkeydown={onRootKeydown}
  onfocus={() => { focused = true; }}
  onblur={() => { focused = false; }}
  oncopy={oncopy}
  oncut={oncopy}
  onpaste={onpaste}
>
  <div bind:this={scroller} class="scroller" onscroll={onScroll} data-scrollable>
    <div class="sizer" style="width: {contentWidth}px; height: {contentHeight}px">
      <canvas
        bind:this={canvas}
        style="width: {width}px; height: {height}px; cursor: {cursor}"
        {onpointerdown}
        {onpointermove}
        {onpointerup}
        onpointercancel={onpointerup}
        {ondblclick}
        {onclick}
        {oncontextmenu}
      ></canvas>
      {#if ctl.canEdit && layout}
        <AddRowsButton {ctl} top={addRowsTop} left={layout.headerWidth + 8} />
      {/if}
      {#if view && theme}
        <ObjectLayer
          {ctl}
          view={{ ...view, scrollX, scrollY }}
          background={theme.sheet}
          {dark}
          touch={touchMode}
          onmenu={(x, y, items) => { menu = { x, y, items }; }}
          oneditchart={(id) => { ctl.panel = { kind: 'chart', id }; }}
        />
      {/if}
    </div>
  </div>

  <textarea
    bind:this={editor}
    class="cell-editor"
    class:visible={editorBox?.visible}
    style="left: {editorBox?.x ?? 0}px; top: {editorBox?.y ?? 0}px; width: {editorBox?.visible ? editorBox.width : 1}px; height: {editorBox?.visible ? editorBox.height : 1}px; font: {fontOf(editorBox?.style ?? {})}; color: {editorBox?.style.c || 'inherit'}; text-align: {editorBox?.style.a === 'r' ? 'right' : editorBox?.style.a === 'c' ? 'center' : 'left'}; line-height: {lineHeightOf(editorBox?.style ?? {})}px"
    rows="1"
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    aria-label="Cell content"
    data-testid="sheet-cell-editor"
    readonly={!ctl.canEdit}
    {onkeydown}
    oninput={onEditorInput}
    onselect={onEditorSelect}
    onkeyup={onEditorSelect}
    onpointerup={onEditorSelect}
    onfocus={() => { focused = true; ctl.selectedObject = null; }}
    onblur={() => { focused = false; }}
  ></textarea>

  {#if editorBox?.visible && ctl.edit?.source === 'cell'}
    <FormulaHelp
      {ctl}
      place={editorBox.y + editorBox.height + 150 > height - keyboardInset
        ? `left: ${Math.min(editorBox.x, Math.max(0, width - 300))}px; bottom: ${height - editorBox.y + 4}px`
        : `left: ${Math.min(editorBox.x, Math.max(0, width - 300))}px; top: ${editorBox.y + editorBox.height + 4}px`}
    />
  {/if}

  <FindBar {ctl} />

  {#if ctl.panel && ctl.canEdit}
    {#await import('./SheetPanels.svelte') then { default: SheetPanels }}
      <SheetPanels {ctl} />
    {/await}
  {/if}

  <div class="sr-only" aria-live="polite" data-testid="sheet-active-cell" data-cell={ctl.selectionName}>{ctl.selectionName} {activeText}</div>
</div>

{#if menu}
  <PopupMenu x={menu.x} y={menu.y} items={menu.items} sheet={menu.sheet ?? null} onclose={closeMenu} />
{/if}

{#if filterMenu}
  <FilterMenu {ctl} colId={filterMenu.colId} x={filterMenu.x} y={filterMenu.y} onclose={() => { filterMenu = null; closeMenu(); }} />
{/if}
