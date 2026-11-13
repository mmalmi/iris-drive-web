/**
 * The state of one open spreadsheet on screen: which sheet is shown, what is
 * selected, what is being typed, and undo. The components read it and call
 * its methods; commands.ts holds the actions that change content.
 */
import * as Y from 'yjs';
import { normalizeRect, rectName, rectOf, type CellPos, type Rect } from './address';
import { editTextAt, writeInput } from './edit';
import { Engine } from './engine';
import { tokenize } from './formula';
import { formatKind } from './format';
import { Book, LOCAL_ORIGIN, type BookChange, type CellStyle, type Sheet, type SheetInfo } from './model';
import { jump, lastFilledCol, stepInside } from './navigate';
import { rectReference } from './refs';
import { REF_COLORS } from './render';
import { isError } from './values';

export type SelectionScope = 'cells' | 'rows' | 'cols' | 'all';

export interface EditState {
  /** The cell being typed into; it can be on another sheet than the one in view. */
  sheetId: string;
  row: number;
  col: number;
  text: string;
  /** What the cell held when typing began. */
  original: string;
  /** Where the typing happens: in the cell or in the bar above the grid. */
  source: 'cell' | 'bar';
  /** "enter": arrow keys finish and move on. "edit": arrow keys move within the text. */
  mode: 'enter' | 'edit';
  caret: [number, number];
  /** The part of the text that pointing at cells last inserted, to be replaced by the next pointing. */
  point: { start: number; end: number } | null;
}

interface SelectionMemo {
  anchor: CellPos;
  focus: CellPos;
  active: CellPos;
  scope: SelectionScope;
  scrollX: number;
  scrollY: number;
}

export interface CopiedCells {
  sheetId: string;
  rect: Rect;
  cut: boolean;
  /** The text placed on the clipboard, to recognise our own copy when pasting. */
  text: string;
  cells: Array<Array<{ raw: unknown; style: CellStyle | undefined }>>;
}

const POINT_AFTER = new Set(['=', '(', ',', ';', '+', '-', '*', '/', '^', '&', '<', '>', ':']);

export class SheetController {
  readonly book: Book;
  readonly engine: Engine;
  readonly undoManager: Y.UndoManager;

  canEdit = $state(false);
  /** The sheet in view. */
  sheetId = $state('');
  sheets = $state.raw<SheetInfo[]>([]);
  anchor = $state.raw<CellPos>({ row: 0, col: 0 });
  focus = $state.raw<CellPos>({ row: 0, col: 0 });
  active = $state.raw<CellPos>({ row: 0, col: 0 });
  scope = $state<SelectionScope>('cells');
  edit = $state.raw<EditState | null>(null);
  copied = $state.raw<CopiedCells | null>(null);
  fillTarget = $state.raw<Rect | null>(null);
  canUndo = $state(false);
  canRedo = $state(false);
  /** A short message for the person, such as why something could not be done. */
  notice = $state('');
  /** Goes up whenever the spreadsheet's content changes, so readers look again. */
  revision = $state(0);
  /** Goes up when rows, columns, sizes or wrapped text change, so positions are worked out again. */
  layoutRevision = $state(0);

  /** Set by the grid: scrolls a cell into view. */
  reveal: (row: number, col: number) => void = () => {};
  /** Set by the grid: reads and sets how far it is scrolled. */
  scrollPosition: () => { scrollX: number; scrollY: number } = () => ({ scrollX: 0, scrollY: 0 });
  restoreScroll: (scrollX: number, scrollY: number) => void = () => {};
  /** Set by the grid: puts the keyboard focus back on it. */
  focusGrid: () => void = () => {};

  private readonly memos = new Map<string, SelectionMemo>();
  private selectionIds = { anchorRow: '', anchorCol: '', focusRow: '', focusCol: '', activeRow: '', activeCol: '' };
  private pointAnchor: CellPos | null = null;
  private pointFocus: CellPos | null = null;
  /** The column Tab started from, so Enter returns under it as when filling in a table. */
  private tabOrigin: number | null = null;
  private readonly unsubscribe: () => void;
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(doc: Y.Doc) {
    this.book = new Book(doc);
    this.engine = new Engine(this.book);
    this.undoManager = new Y.UndoManager(doc, { trackedOrigins: new Set([LOCAL_ORIGIN]), captureTimeout: 0 });
    this.undoManager.on('stack-item-added', (event: { stackItem: { meta: Map<string, unknown> } }) => {
      event.stackItem.meta.set('selection', this.selectionMemo());
      event.stackItem.meta.set('sheet', this.edit?.sheetId ?? this.sheetId);
      this.refreshUndo();
    });
    this.undoManager.on('stack-item-popped', (event: { stackItem: { meta: Map<string, unknown> }; type: 'undo' | 'redo' }) => {
      const memo = event.stackItem.meta.get('selection') as SelectionMemo | undefined;
      const sheetId = event.stackItem.meta.get('sheet') as string | undefined;
      // The step that undoes this one should bring the selection back here too.
      const opposite = event.type === 'undo' ? this.undoManager.redoStack : this.undoManager.undoStack;
      const twin = opposite[opposite.length - 1];
      if (twin && memo) {
        twin.meta.set('selection', memo);
        twin.meta.set('sheet', sheetId);
      }
      if (sheetId && this.book.nameOf(sheetId) !== undefined && sheetId !== this.sheetId) this.showSheet(sheetId);
      if (memo) {
        this.setSelection(memo.anchor, memo.focus, memo.active, memo.scope);
        this.reveal(memo.active.row, memo.active.col);
      }
      this.refreshUndo();
    });
    this.unsubscribe = this.book.onChange(change => this.afterChange(change));
    this.sheets = this.book.sheets;
    this.sheetId = this.book.sheets[0]?.id ?? '';
    this.rememberIds();
  }

  destroy(): void {
    this.unsubscribe();
    this.undoManager.destroy();
    this.engine.destroy();
    this.book.destroy();
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
  }

  /** Called once the stored document is loaded. */
  start(canEdit: boolean): void {
    this.canEdit = canEdit && !this.book.tooNew;
    if (this.canEdit) this.book.initialize();
    this.sheets = this.book.sheets;
    if (this.book.nameOf(this.sheetId) === undefined) this.sheetId = this.book.sheets[0]?.id ?? '';
    this.undoManager.clear();
    this.refreshUndo();
    this.revision += 1;
    this.layoutRevision += 1;
  }

  get sheet(): Sheet {
    return this.book.sheet(this.sheetId);
  }

  get hasSheet(): boolean {
    return this.sheetId !== '' && this.sheets.length > 0;
  }

  get selection(): Rect {
    return rectOf(this.anchor, this.focus);
  }

  say(message: string): void {
    this.notice = message;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.notice = '';
    }, 4000);
  }

  // --- Following changes ---

  private afterChange(change: BookChange): void {
    if (change.sheets) {
      this.sheets = this.book.sheets;
      if (this.book.nameOf(this.sheetId) === undefined) {
        this.sheetId = this.book.sheets[0]?.id ?? '';
        this.restoreMemo();
      }
      if (this.edit && this.book.nameOf(this.edit.sheetId) === undefined) this.edit = null;
    }
    const mine = change.bySheet.get(this.sheetId);
    if (mine?.axes) this.followIds();
    if (mine && (mine.axes || mine.props || mine.styles || mine.cells.size > 0)) this.layoutRevision += 1;
    this.revision += 1;
  }

  private rememberIds(): void {
    if (!this.hasSheet) return;
    const { rows, cols } = this.sheet;
    this.selectionIds = {
      anchorRow: rows.ids[this.anchor.row] ?? '',
      anchorCol: cols.ids[this.anchor.col] ?? '',
      focusRow: rows.ids[this.focus.row] ?? '',
      focusCol: cols.ids[this.focus.col] ?? '',
      activeRow: rows.ids[this.active.row] ?? '',
      activeCol: cols.ids[this.active.col] ?? '',
    };
  }

  /** Keeps the selection on the same cells after rows or columns moved under it. */
  private followIds(): void {
    const { rows, cols } = this.sheet;
    const ids = this.selectionIds;
    const place = (axis: typeof rows, id: string, fallback: number) => {
      const index = axis.indexOf(id);
      return index >= 0 ? index : Math.min(fallback, Math.max(0, axis.length - 1));
    };
    this.setSelection(
      { row: place(rows, ids.anchorRow, this.anchor.row), col: place(cols, ids.anchorCol, this.anchor.col) },
      { row: place(rows, ids.focusRow, this.focus.row), col: place(cols, ids.focusCol, this.focus.col) },
      { row: place(rows, ids.activeRow, this.active.row), col: place(cols, ids.activeCol, this.active.col) },
      this.scope,
    );
    const edit = this.edit;
    if (edit && edit.sheetId === this.sheetId) {
      // The cell being typed into moved along with its row and column.
      this.edit = { ...edit, row: this.active.row, col: this.active.col };
    }
  }

  // --- Selection ---

  private clampPos(pos: CellPos): CellPos {
    const sheet = this.sheet;
    return {
      row: Math.max(0, Math.min(pos.row, sheet.rows.length - 1)),
      col: Math.max(0, Math.min(pos.col, sheet.cols.length - 1)),
    };
  }

  setSelection(anchor: CellPos, focus: CellPos = anchor, active: CellPos = anchor, scope: SelectionScope = 'cells'): void {
    if (!this.hasSheet) return;
    const sheet = this.sheet;
    let a = this.clampPos(anchor);
    let f = this.clampPos(focus);
    // Whole rows and columns stay whole when the sheet grows.
    if (scope === 'rows' || scope === 'all') {
      a = { row: a.row, col: 0 };
      f = { row: f.row, col: sheet.cols.length - 1 };
    }
    if (scope === 'cols' || scope === 'all') {
      a = { row: 0, col: a.col };
      f = { row: sheet.rows.length - 1, col: f.col };
    }
    this.anchor = a;
    this.focus = f;
    const rect = rectOf(a, f);
    const wanted = this.clampPos(active);
    this.active = {
      row: Math.max(rect.r1, Math.min(wanted.row, rect.r2)),
      col: Math.max(rect.c1, Math.min(wanted.col, rect.c2)),
    };
    this.scope = scope;
    this.rememberIds();
  }

  /** Selects one cell, or with `extend` stretches the selection to it. */
  select(pos: CellPos, extend = false): void {
    this.tabOrigin = null;
    if (extend) this.setSelection(this.active, pos, this.active);
    else this.setSelection(pos);
  }

  selectRows(from: number, to: number): void {
    this.setSelection({ row: from, col: 0 }, { row: to, col: 0 }, { row: from, col: 0 }, 'rows');
  }

  selectCols(from: number, to: number): void {
    this.setSelection({ row: 0, col: from }, { row: 0, col: to }, { row: 0, col: from }, 'cols');
  }

  selectAll(): void {
    this.setSelection({ row: 0, col: 0 }, { row: 0, col: 0 }, this.active, 'all');
  }

  /** Arrow keys: move by one cell, or with `far` to the edge of the filled cells. */
  move(dRow: number, dCol: number, options: { extend?: boolean; far?: boolean } = {}): void {
    const from = options.extend ? this.focus : this.active;
    const to = options.far
      ? jump(this.sheet, from, dRow, dCol)
      : this.clampPos({ row: from.row + dRow, col: from.col + dCol });
    this.tabOrigin = null;
    if (options.extend) this.setSelection(this.active, to, this.active);
    else this.setSelection(to);
    this.reveal(to.row, to.col);
  }

  /** Tab and Enter: the next cell, staying inside a selected range. */
  step(dRow: number, dCol: number): void {
    const rect = this.selection;
    const many = rect.r1 !== rect.r2 || rect.c1 !== rect.c2;
    if (many) {
      this.active = stepInside(rect, this.active, dRow, dCol);
      this.rememberIds();
      this.reveal(this.active.row, this.active.col);
      return;
    }
    if (dCol !== 0) {
      if (this.tabOrigin === null) this.tabOrigin = this.active.col;
      const to = this.clampPos({ row: this.active.row, col: this.active.col + dCol });
      this.setSelection(to);
    } else {
      // After tabbing along a row, Enter starts the next row under where the tabbing began.
      const col = dRow > 0 && this.tabOrigin !== null ? this.tabOrigin : this.active.col;
      this.tabOrigin = null;
      this.setSelection(this.clampPos({ row: this.active.row + dRow, col }));
    }
    this.reveal(this.active.row, this.active.col);
  }

  goHome(wholeSheet: boolean, extend: boolean): void {
    const to = wholeSheet ? { row: 0, col: 0 } : { row: (extend ? this.focus : this.active).row, col: 0 };
    this.select(to, extend);
    this.reveal(to.row, to.col);
  }

  goEnd(wholeSheet: boolean, extend: boolean): void {
    const used = this.sheet.usedRect();
    const row = (extend ? this.focus : this.active).row;
    const to = wholeSheet
      ? { row: used?.r2 ?? 0, col: used?.c2 ?? 0 }
      : { row, col: lastFilledCol(this.sheet, row) };
    this.select(to, extend);
    this.reveal(to.row, to.col);
  }

  /** Jumps to a cell or range typed as "B7" or "A1:C9". */
  goTo(rect: Rect): boolean {
    const sheet = this.sheet;
    if (rect.r2 >= sheet.rows.length || rect.c2 >= sheet.cols.length) return false;
    this.setSelection({ row: rect.r1, col: rect.c1 }, { row: rect.r2, col: rect.c2 });
    this.reveal(rect.r1, rect.c1);
    return true;
  }

  // --- Sheets ---

  private selectionMemo(): SelectionMemo {
    return { anchor: this.anchor, focus: this.focus, active: this.active, scope: this.scope, ...this.scrollPosition() };
  }

  private restoreMemo(): void {
    const memo = this.memos.get(this.sheetId);
    if (memo) {
      this.setSelection(memo.anchor, memo.focus, memo.active, memo.scope);
      this.restoreScroll(memo.scrollX, memo.scrollY);
    } else {
      this.setSelection({ row: 0, col: 0 });
      this.restoreScroll(0, 0);
    }
  }

  /** Shows another sheet. A formula being typed stays open, so it can point at cells there. */
  showSheet(id: string): void {
    if (id === this.sheetId || this.book.nameOf(id) === undefined) return;
    const edit = this.edit;
    if (edit && !edit.text.startsWith('=')) this.commitEdit();
    this.memos.set(this.sheetId, this.selectionMemo());
    this.sheetId = id;
    this.pointAnchor = null;
    this.pointFocus = null;
    this.restoreMemo();
    this.layoutRevision += 1;
    this.revision += 1;
  }

  // --- Typing ---

  /** The text the bar above the grid shows. */
  get barText(): string {
    void this.revision;
    if (this.edit) return this.edit.text;
    if (!this.hasSheet) return '';
    return editTextAt(this.book, this.sheet, this.active.row, this.active.col);
  }

  /** "B7" or "A1:C9" for the selection. */
  get selectionName(): string {
    const rect = this.selection;
    if (this.scope === 'cells' || this.edit) return rectName(this.edit ? rectOf(this.active) : rect);
    return rectName(rect);
  }

  get activeStyle(): CellStyle {
    void this.revision;
    return this.hasSheet ? this.sheet.styleAt(this.active.row, this.active.col) : {};
  }

  get activeFormat(): string | undefined {
    void this.revision;
    return this.hasSheet ? this.engine.formatAt(this.sheet, this.active.row, this.active.col) : undefined;
  }

  /** Why the active cell shows an error, in a sentence. */
  get activeMessage(): string {
    void this.revision;
    if (!this.hasSheet || this.edit) return '';
    const value = this.engine.valueAt(this.sheet, this.active.row, this.active.col);
    return isError(value) ? value.message : '';
  }

  /**
   * Starts typing into the active cell. With `text` the cell's content is
   * replaced by it; without, the content is opened for changing.
   */
  startEdit(options: { text?: string; source?: 'cell' | 'bar' } = {}): boolean {
    if (!this.canEdit || !this.hasSheet) return false;
    if (this.edit) return true;
    const { row, col } = this.active;
    const original = editTextAt(this.book, this.sheet, row, col);
    let text = options.text ?? original;
    // Typing a number into a percentage keeps it a percentage.
    if (options.text !== undefined && /^\d$/.test(options.text) && formatKind(this.sheet.styleAt(row, col).nf) === 'percent') {
      text = `${options.text}%`;
    }
    const caret = options.text !== undefined ? options.text.length : text.length;
    this.setSelection(this.active);
    this.edit = {
      sheetId: this.sheetId,
      row,
      col,
      text,
      original,
      source: options.source ?? 'cell',
      mode: options.text !== undefined ? 'enter' : 'edit',
      caret: [caret, caret],
      point: null,
    };
    this.pointAnchor = null;
    this.pointFocus = null;
    this.copied = this.copied?.cut ? this.copied : null;
    this.reveal(row, col);
    return true;
  }

  /** The inputs call this as the person types or moves the caret. */
  setEditText(text: string, caret: [number, number], source?: 'cell' | 'bar'): void {
    const edit = this.edit;
    if (!edit) return;
    const typed = text !== edit.text;
    this.edit = { ...edit, text, caret, source: source ?? edit.source, point: typed ? null : edit.point };
    if (typed) {
      this.pointAnchor = null;
      this.pointFocus = null;
    }
  }

  setEditMode(mode: 'enter' | 'edit'): void {
    if (this.edit) this.edit = { ...this.edit, mode };
  }

  /** Whether clicking a cell now would put its address into the formula being typed. */
  get pointing(): boolean {
    const edit = this.edit;
    if (!edit || !edit.text.startsWith('=')) return false;
    if (edit.point && edit.caret[0] === edit.point.end) return true;
    if (edit.caret[0] !== edit.caret[1]) return false;
    const before = edit.text.slice(0, edit.caret[0]).trimEnd();
    return POINT_AFTER.has(before[before.length - 1] ?? '');
  }

  /** Puts the address of cells into the formula being typed, replacing the one pointed at before. */
  pointAt(rect: Rect): void {
    const edit = this.edit;
    if (!edit) return;
    const home = this.book.sheet(edit.sheetId);
    const reference = rectReference(normalizeRect(rect), this.sheet, home, this.book);
    const start = edit.point ? edit.point.start : edit.caret[0];
    const end = edit.point ? edit.point.end : edit.caret[1];
    const text = edit.text.slice(0, start) + reference + edit.text.slice(end);
    const caret = start + reference.length;
    this.edit = { ...edit, text, caret: [caret, caret], point: { start, end: caret } };
  }

  /** Arrow keys while a formula waits for an address: move the pointed-at cell. */
  pointMove(dRow: number, dCol: number, extend: boolean): void {
    const edit = this.edit;
    if (!edit) return;
    const start = this.pointFocus ?? (edit.sheetId === this.sheetId ? { row: edit.row, col: edit.col } : this.active);
    const to = this.clampPos({ row: start.row + dRow, col: start.col + dCol });
    if (!extend || !this.pointAnchor) this.pointAnchor = to;
    this.pointFocus = to;
    this.pointAt(rectOf(this.pointAnchor, to));
    this.reveal(to.row, to.col);
  }

  /** Mouse pointing: `anchor` is where the press began. */
  pointDrag(anchor: CellPos, focus: CellPos): void {
    this.pointAnchor = anchor;
    this.pointFocus = focus;
    this.pointAt(rectOf(anchor, focus));
  }

  /** F4: cycles the address at the caret through A1, $A$1, A$1, $A1. */
  cycleAbsolute(): void {
    const edit = this.edit;
    if (!edit || !edit.text.startsWith('=')) return;
    const caret = edit.caret[0] - 1;
    for (const token of tokenize(edit.text.slice(1), 'a1')) {
      if (token.type !== 'ref' || !token.ref || caret < token.start || caret > token.end) continue;
      const bang = token.text.lastIndexOf('!');
      const prefix = token.text.slice(0, bang + 1);
      const body = token.text.slice(bang + 1);
      const cycle = (part: string) => {
        const match = /^(\$?)([A-Za-z]*)(\$?)(\d*)$/.exec(part);
        if (!match) return part;
        const [, absCol, col, absRow, row] = match;
        const state = (absCol ? 2 : 0) + (absRow ? 1 : 0);
        const next = [3, 2, 0, 1][state];
        return `${next & 2 && col ? '$' : ''}${col}${next & 1 && row ? '$' : ''}${row}`;
      };
      const replaced = prefix + body.split(':').map(cycle).join(':');
      const text = `=${edit.text.slice(1, token.start + 1)}${replaced}${edit.text.slice(token.end + 1)}`;
      const end = token.start + 1 + replaced.length;
      this.edit = { ...edit, text, caret: [end, end], point: null };
      return;
    }
  }

  /** The cells the formula being typed mentions on the sheet in view, each with its colour. */
  get editReferences(): Array<{ rect: Rect; color: string }> {
    const edit = this.edit;
    if (!edit || !edit.text.startsWith('=') || !this.hasSheet) return [];
    const viewed = this.sheet;
    const viewedName = this.book.nameOf(this.sheetId)?.toLowerCase();
    const out: Array<{ rect: Rect; color: string }> = [];
    let count = 0;
    for (const token of tokenize(edit.text.slice(1), 'a1')) {
      const ref = token.ref;
      if (token.type !== 'ref' || !ref) continue;
      const color = REF_COLORS[count % REF_COLORS.length];
      count += 1;
      const onViewed = ref.sheet === null ? edit.sheetId === this.sheetId : ref.sheet.toLowerCase() === viewedName;
      if (!onViewed) continue;
      const end = ref.b ?? ref.a;
      const column = (letters: string) => [...letters.toUpperCase()].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0) - 1;
      const rect = normalizeRect({
        r1: ref.a.row === null ? 0 : Number(ref.a.row) - 1,
        c1: ref.a.col === null ? 0 : column(ref.a.col),
        r2: end.row === null ? viewed.rows.length - 1 : Number(end.row) - 1,
        c2: end.col === null ? viewed.cols.length - 1 : column(end.col),
      });
      if (rect.r1 >= viewed.rows.length || rect.c1 >= viewed.cols.length) continue;
      rect.r2 = Math.min(rect.r2, viewed.rows.length - 1);
      rect.c2 = Math.min(rect.c2, viewed.cols.length - 1);
      out.push({ rect, color });
    }
    return out;
  }

  /** Stores what was typed. `move` says where the selection goes next. */
  commitEdit(move: 'down' | 'up' | 'right' | 'left' | null = null): void {
    const edit = this.edit;
    if (!edit) return;
    this.edit = null;
    if (edit.sheetId !== this.sheetId && this.book.nameOf(edit.sheetId) !== undefined) {
      this.memos.set(this.sheetId, this.selectionMemo());
      this.sheetId = edit.sheetId;
      this.layoutRevision += 1;
    }
    this.setSelection({ row: edit.row, col: edit.col });
    if (edit.text !== edit.original) {
      writeInput(this.book, this.sheet, edit.row, edit.col, edit.text);
    }
    this.revision += 1;
    if (move === 'down') this.step(1, 0);
    else if (move === 'up') this.step(-1, 0);
    else if (move === 'right') this.step(0, 1);
    else if (move === 'left') this.step(0, -1);
    else this.reveal(edit.row, edit.col);
  }

  cancelEdit(): void {
    const edit = this.edit;
    if (!edit) return;
    this.edit = null;
    if (edit.sheetId !== this.sheetId && this.book.nameOf(edit.sheetId) !== undefined) {
      this.sheetId = edit.sheetId;
      this.layoutRevision += 1;
    }
    this.setSelection({ row: edit.row, col: edit.col });
    this.revision += 1;
  }

  // --- Undo ---

  private refreshUndo(): void {
    this.canUndo = this.undoManager.undoStack.length > 0;
    this.canRedo = this.undoManager.redoStack.length > 0;
  }

  undo(): void {
    if (!this.canEdit) return;
    this.cancelEdit();
    this.undoManager.undo();
    this.refreshUndo();
  }

  redo(): void {
    if (!this.canEdit) return;
    this.cancelEdit();
    this.undoManager.redo();
    this.refreshUndo();
  }
}
