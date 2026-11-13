/**
 * What the presentation editor shows and what the person in front of it is
 * doing: the deck as plain data that follows the Yjs document, the slide and
 * elements that are selected, the text box being typed in, and undo.
 * Selection and the like are this screen's own and are never stored.
 */
import * as Y from 'yjs';
import { PluginKey } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';
import {
  Deck,
  LOCAL_ORIGIN,
  SLIDE_HEIGHT,
  SLIDE_WIDTH,
  elementToJson,
  richTextIsEmpty,
  richTextToPlain,
  type ElementInit,
  type ElementJson,
  type ElementProps,
  type ShapeKind,
  type Slide,
  type SlideElement,
  type TextAlign,
  type VerticalAlign,
} from './model';
import { DEFAULT_LAYOUT, layoutById } from './layouts';
import { DEFAULT_THEME, paletteFor, textStyle, themeById, type Palette, type Theme } from './themes';
import { MAX_FONT_SIZE, MIN_FONT_SIZE } from './richText';
import { comparePositions } from './order';

export const CLIPBOARD_TYPE = 'application/x-iris-slides';

interface ClipboardSlide {
  layout: string;
  background?: string;
  notes: string;
  elements: ElementJson[];
}

export interface ClipboardPayload {
  kind: 'iris-slides';
  version: 1;
  elements?: ElementJson[];
  slides?: ClipboardSlide[];
}

export interface StartEditingOptions {
  /** Where on the screen the cursor should go. */
  point?: { x: number; y: number };
  selectAll?: boolean;
  /** Text to type as editing begins. */
  insert?: string;
  /** Something to do with the editor once it is there. */
  then?: (editor: Editor) => void;
}

export type TextMark = 'bold' | 'italic' | 'underline' | 'strike';

function shallowEqual(left: object, right: object): boolean {
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    if ((left as Record<string, unknown>)[key] !== (right as Record<string, unknown>)[key]) return false;
  }
  return true;
}

/** Keeps the objects of the previous reading where nothing changed, so only what changed is redrawn. */
function reuse(previous: Slide | undefined, next: Slide): Slide {
  if (!previous) return next;
  const before = new Map(previous.elements.map(element => [element.id, element]));
  const elements = next.elements.map((element) => {
    const old = before.get(element.id);
    return old && shallowEqual(old, element) ? old : element;
  });
  const same = elements.length === previous.elements.length
    && elements.every((element, index) => element === previous.elements[index])
    && previous.pos === next.pos && previous.layout === next.layout
    && previous.background === next.background && previous.notes === next.notes;
  return same ? previous : { ...next, elements };
}

export interface SlidesEditorOptions {
  /** Stores an image beside the deck and returns the name to refer to it by. */
  addAttachment: (file: File) => Promise<string>;
  canEdit: () => boolean;
}

export class SlidesEditorState {
  readonly deck: Deck;
  readonly #options: SlidesEditorOptions;
  readonly #undo: Y.UndoManager;
  #lastAction = '';
  #pendingEdit: StartEditingOptions | null = null;
  #pasteCount = 0;

  slides = $state.raw<Slide[]>([]);
  themeId = $state(DEFAULT_THEME);
  /** Goes up with every change to the deck, for values worked out from the Yjs document directly. */
  revision = $state(0);
  canUndo = $state(false);
  canRedo = $state(false);

  /** The slide on the canvas. */
  currentId = $state<string | null>(null);
  /** Slides picked in the strip; always includes the current one. */
  pickedSlides = $state.raw<string[]>([]);
  /** Elements selected on the current slide. */
  selection = $state.raw<string[]>([]);
  /** The text box or shape being typed in. */
  editingId = $state<string | null>(null);
  textEditor = $state.raw<Editor | null>(null);
  /** Goes up whenever the text editor's cursor or content changes. */
  editorTick = $state(0);
  /** Whether keys act on the slide strip or on the canvas. */
  area = $state<'strip' | 'canvas'>('canvas');
  presenting = $state(false);
  notice = $state('');

  readonly theme: Theme = $derived(themeById(this.themeId));
  readonly current: Slide | null = $derived(this.slides.find(slide => slide.id === this.currentId) ?? this.slides[0] ?? null);
  readonly currentIndex: number = $derived(this.current ? this.slides.indexOf(this.current) : -1);
  readonly palette: Palette = $derived(paletteFor(this.theme, this.current?.layout ?? 'blank'));
  readonly selected: SlideElement[] = $derived(
    this.current ? this.current.elements.filter(element => this.selection.includes(element.id)) : [],
  );
  readonly editing: SlideElement | null = $derived(
    this.current?.elements.find(element => element.id === this.editingId) ?? null,
  );
  /** Selected elements that hold text. */
  readonly selectedText: SlideElement[] = $derived(this.selected.filter(element => element.type === 'text' || element.type === 'shape'));

  constructor(ydoc: Y.Doc, options: SlidesEditorOptions) {
    this.deck = new Deck(ydoc);
    this.#options = options;
    this.#undo = new Y.UndoManager([this.deck.slides, this.deck.meta], {
      // This editor's own changes and what is typed into its text boxes, never
      // what was loaded from storage or arrived from another tab.
      trackedOrigins: new Set<unknown>([LOCAL_ORIGIN, PluginKey]),
      captureTimeout: 600,
    });
    const stacks = () => {
      this.canUndo = this.#undo.undoStack.length > 0;
      this.canRedo = this.#undo.redoStack.length > 0;
    };
    this.#undo.on('stack-item-added', stacks);
    this.#undo.on('stack-item-popped', stacks);
    this.#undo.on('stack-cleared', stacks);
    this.deck.slides.observeDeep(this.#onSlidesChanged);
    this.deck.meta.observe(this.#onMetaChanged);
    this.#onMetaChanged();
    this.#read(null);
  }

  destroy(): void {
    this.deck.slides.unobserveDeep(this.#onSlidesChanged);
    this.deck.meta.unobserve(this.#onMetaChanged);
    this.#undo.destroy();
  }

  get canEdit(): boolean {
    return this.#options.canEdit() && !this.deck.isNewer;
  }

  readonly #onMetaChanged = (): void => {
    this.themeId = themeById(this.deck.theme || DEFAULT_THEME).id;
  };

  readonly #onSlidesChanged = (events: Array<Y.YEvent<Y.AbstractType<unknown>>>, transaction: Y.Transaction): void => {
    const changed = new Set<string>();
    for (const event of events) {
      if (event.target === this.deck.slides) {
        for (const key of event.changes.keys.keys()) changed.add(key);
      } else if (typeof event.path[0] === 'string') {
        changed.add(event.path[0]);
      }
    }
    this.#read(changed);
    // Undoing something on another slide shows that slide.
    if (transaction.origin === this.#undo && changed.size > 0 && !(this.currentId && changed.has(this.currentId))) {
      const target = this.slides.find(slide => changed.has(slide.id));
      if (target) this.goTo(target.id);
    }
  };

  /** Reads the slides named in `changed` again (all of them when null) and keeps the rest. */
  #read(changed: Set<string> | null): void {
    const previous = new Map(this.slides.map(slide => [slide.id, slide]));
    let next: Slide[];
    if (changed === null) {
      next = this.deck.readSlides().map(slide => reuse(previous.get(slide.id), slide));
    } else {
      next = [];
      for (const [id, slide] of previous) {
        if (!changed.has(id)) next.push(slide);
      }
      for (const id of changed) {
        const slide = this.deck.readSlide(id);
        if (slide) next.push(reuse(previous.get(id), slide));
      }
      next.sort(comparePositions);
    }
    const oldIndex = this.currentIndex;
    if (next.length !== this.slides.length || next.some((slide, index) => slide !== this.slides[index])) this.slides = next;
    this.revision += 1;

    // Keep pointing at things that still exist.
    if (!this.currentId || !next.some(slide => slide.id === this.currentId)) {
      this.currentId = next[Math.min(Math.max(oldIndex, 0), next.length - 1)]?.id ?? null;
      this.pickedSlides = this.currentId ? [this.currentId] : [];
      this.selection = [];
      this.editingId = null;
    } else {
      const picked = this.pickedSlides.filter(id => next.some(slide => slide.id === id));
      if (picked.length !== this.pickedSlides.length) this.pickedSlides = picked.length ? picked : [this.currentId];
      const elements = next.find(slide => slide.id === this.currentId)?.elements ?? [];
      const selection = this.selection.filter(id => elements.some(element => element.id === id));
      if (selection.length !== this.selection.length) this.selection = selection;
      if (this.editingId && !elements.some(element => element.id === this.editingId)) this.editingId = null;
    }
  }

  /** Gives an empty deck its first slide. Not something to undo. */
  startDeck(): void {
    if (!this.canEdit) return;
    this.deck.start(DEFAULT_THEME);
    if (this.deck.slides.size === 0) this.deck.addSlide('title', layoutById('title').elements);
    this.#undo.clear();
  }

  /** Runs one step of editing. Steps of the same `merge` kind made in quick succession undo together. */
  #act<T>(change: () => T, merge = ''): T {
    if (!merge || merge !== this.#lastAction) this.#undo.stopCapturing();
    this.#lastAction = merge;
    const result = change();
    if (!merge) this.#undo.stopCapturing();
    return result;
  }

  undo(): void {
    if (!this.canEdit) return;
    this.#lastAction = '';
    this.#undo.undo();
  }

  redo(): void {
    if (!this.canEdit) return;
    this.#lastAction = '';
    this.#undo.redo();
  }

  // Slides

  goTo(id: string, keepPicked = false): void {
    if (!this.slides.some(slide => slide.id === id)) return;
    if (id !== this.currentId) {
      this.stopEditing();
      this.selection = [];
    }
    this.currentId = id;
    if (!keepPicked) this.pickedSlides = [id];
  }

  goBy(step: number): void {
    const target = this.slides[Math.min(this.slides.length - 1, Math.max(0, this.currentIndex + step))];
    if (target) this.goTo(target.id);
  }

  /** Picks a slide in the strip: alone, added to the picked ones, or as the end of a range. */
  pickSlide(id: string, mode: 'only' | 'toggle' | 'range'): void {
    if (mode === 'toggle' && this.pickedSlides.length > 0) {
      if (this.pickedSlides.includes(id)) {
        const rest = this.pickedSlides.filter(picked => picked !== id);
        if (rest.length === 0) return;
        this.pickedSlides = rest;
        if (this.currentId === id) this.goTo(rest[rest.length - 1]!, true);
      } else {
        this.pickedSlides = [...this.pickedSlides, id];
        this.goTo(id, true);
      }
    } else if (mode === 'range' && this.currentId) {
      const from = this.currentIndex;
      const to = this.slides.findIndex(slide => slide.id === id);
      const range = this.slides.slice(Math.min(from, to), Math.max(from, to) + 1).map(slide => slide.id);
      this.pickedSlides = [...new Set([...this.pickedSlides, ...range])];
    } else {
      this.goTo(id);
    }
  }

  addSlide(layoutId?: string): void {
    if (!this.canEdit) return;
    // After a title slide comes content; otherwise more of the same.
    const from = this.current?.layout;
    const layout = layoutById(layoutId ?? (from && from !== 'title' && from !== 'section' ? from : DEFAULT_LAYOUT));
    this.stopEditing();
    const id = this.#act(() => this.deck.addSlide(layout.id, layout.elements, this.currentId));
    this.goTo(id);
  }

  duplicateSlides(): void {
    if (!this.canEdit || this.pickedSlides.length === 0) return;
    this.stopEditing();
    const copies = this.#act(() => this.deck.duplicateSlides(this.pickedSlides));
    if (copies.length) {
      this.goTo(copies[copies.length - 1]!);
      this.pickedSlides = copies;
    }
  }

  deleteSlides(): void {
    if (!this.canEdit || this.pickedSlides.length === 0) return;
    this.stopEditing();
    this.#act(() => this.deck.deleteSlides(this.pickedSlides));
  }

  /** Moves the picked slides to just before `beforeId` (the end when null). */
  moveSlides(ids: string[], beforeId: string | null): void {
    if (!this.canEdit) return;
    this.#act(() => this.deck.moveSlides(ids, beforeId));
  }

  /** Moves the picked slides one place up or down. */
  shiftSlides(step: -1 | 1): void {
    const picked = this.slides.filter(slide => this.pickedSlides.includes(slide.id));
    const staying = this.slides.filter(slide => !this.pickedSlides.includes(slide.id));
    if (picked.length === 0 || staying.length === 0) return;
    const first = this.slides.indexOf(picked[0]!);
    const before = this.slides.slice(0, first).filter(slide => staying.includes(slide)).length;
    const index = Math.min(staying.length, Math.max(0, before + step));
    this.moveSlides(picked.map(slide => slide.id), staying[index]?.id ?? null);
  }

  setBackground(colour: string | null): void {
    if (!this.canEdit) return;
    const ids = this.pickedSlides.length ? this.pickedSlides : this.currentId ? [this.currentId] : [];
    this.#act(() => this.deck.transact(() => {
      for (const id of ids) this.deck.setSlideBackground(id, colour);
    }), 'background');
  }

  setTheme(id: string): void {
    if (!this.canEdit) return;
    this.#act(() => this.deck.setTheme(id));
  }

  setNotes(value: string): void {
    if (!this.canEdit || !this.currentId) return;
    this.#act(() => this.deck.setNotes(this.currentId!, value), 'notes');
  }

  // Elements

  select(ids: string[]): void {
    if (this.editingId && !(ids.length === 1 && ids[0] === this.editingId)) this.stopEditing();
    this.selection = ids;
    this.area = 'canvas';
  }

  selectAll(): void {
    this.select(this.current?.elements.map(element => element.id) ?? []);
  }

  /** Where a new thing of this size goes: the middle, stepped aside while that spot is taken. */
  #place(w: number, h: number): { x: number; y: number } {
    let x = Math.round((SLIDE_WIDTH - w) / 2);
    let y = Math.round((SLIDE_HEIGHT - h) / 2);
    const taken = (px: number, py: number) => this.current?.elements.some(element => Math.abs(element.x - px) < 4 && Math.abs(element.y - py) < 4);
    for (let tries = 0; tries < 12 && taken(x, y); tries += 1) {
      x += 24;
      y += 24;
    }
    return { x, y };
  }

  #add(inits: Array<ElementJson & { text?: string }>): string[] {
    if (!this.canEdit || !this.currentId) return [];
    this.stopEditing();
    const ids = this.#act(() => this.deck.addElements(this.currentId!, inits));
    this.select(ids);
    return ids;
  }

  addText(): void {
    const [id] = this.#add([{ type: 'text', ...this.#place(520, 60), w: 520, h: 60, rot: 0 }]);
    if (id) this.startEditing(id);
  }

  addShape(shape: ShapeKind): void {
    const w = shape === 'ellipse' ? 220 : 280;
    const h = shape === 'ellipse' ? 220 : 170;
    this.#add([{ type: 'shape', shape, ...this.#place(w, h), w, h, rot: 0 }]);
  }

  addLine(arrow: boolean): void {
    const init: ElementInit = { type: 'line', ...this.#place(320, 0), w: 320, h: 0, rot: 0 };
    if (arrow) init.arrow = true;
    this.#add([init]);
  }

  /** Stores an image with the deck and puts it on the slide, centred on `at` when given. */
  async addImage(file: File, at?: { x: number; y: number }): Promise<void> {
    if (!this.canEdit || !this.currentId || !file.type.startsWith('image/')) return;
    if (file.size > 20 * 1024 * 1024) {
      this.notice = 'Images can be up to 20 MB.';
      return;
    }
    this.notice = '';
    const slideId = this.currentId;
    try {
      const [src, size] = await Promise.all([this.#options.addAttachment(file), imageSize(file)]);
      const scale = Math.min(1, 760 / size.width, 520 / size.height);
      const w = Math.max(24, Math.round(size.width * scale));
      const h = Math.max(24, Math.round(size.height * scale));
      const spot = at ? { x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2) } : this.#place(w, h);
      const ids = this.#act(() => this.deck.addElements(slideId, [{ type: 'image', src, ...spot, w, h, rot: 0 }]));
      if (this.currentId === slideId) this.select(ids);
    } catch (error) {
      console.error('[Slides] Could not add image:', error);
      this.notice = 'Could not add the image.';
    }
  }

  /** Writes the same properties to every selected element. */
  updateSelected(props: ElementProps, merge = ''): void {
    if (!this.canEdit || !this.currentId || this.selection.length === 0) return;
    const changes: Record<string, ElementProps> = {};
    for (const id of this.selection) changes[id] = props;
    this.#act(() => this.deck.updateElements(this.currentId!, changes), merge);
  }

  /** Writes a different change to each element, as one step. */
  updateElements(changes: Record<string, ElementProps>, merge = ''): void {
    if (!this.canEdit || !this.currentId) return;
    this.#act(() => this.deck.updateElements(this.currentId!, changes), merge);
  }

  nudge(dx: number, dy: number): void {
    const changes: Record<string, ElementProps> = {};
    for (const element of this.selected) changes[element.id] = { x: element.x + dx, y: element.y + dy };
    this.updateElements(changes, 'nudge');
  }

  deleteSelected(): void {
    if (!this.canEdit || !this.currentId || this.selection.length === 0) return;
    this.stopEditing();
    this.#act(() => this.deck.deleteElements(this.currentId!, this.selection));
  }

  duplicateSelected(): void {
    if (!this.canEdit || !this.currentId || this.selection.length === 0) return;
    this.stopEditing();
    const ids = this.#act(() => this.deck.duplicateElements(this.currentId!, this.selection));
    this.select(ids);
  }

  arrange(where: 'front' | 'back' | 'forward' | 'backward'): void {
    if (!this.canEdit || !this.currentId || this.selection.length === 0) return;
    this.#act(() => this.deck.arrange(this.currentId!, this.selection, where));
  }

  /** Lines the selected elements up with the slide. */
  alignToSlide(where: 'left' | 'centre' | 'right' | 'top' | 'middle' | 'bottom'): void {
    const changes: Record<string, ElementProps> = {};
    for (const element of this.selected) {
      const left = Math.min(element.x, element.x + element.w);
      const top = Math.min(element.y, element.y + element.h);
      const width = Math.abs(element.w);
      const height = Math.abs(element.h);
      if (where === 'left') changes[element.id] = { x: element.x - left };
      else if (where === 'centre') changes[element.id] = { x: element.x + (SLIDE_WIDTH - width) / 2 - left };
      else if (where === 'right') changes[element.id] = { x: element.x + SLIDE_WIDTH - width - left };
      else if (where === 'top') changes[element.id] = { y: element.y - top };
      else if (where === 'middle') changes[element.id] = { y: element.y + (SLIDE_HEIGHT - height) / 2 - top };
      else changes[element.id] = { y: element.y + SLIDE_HEIGHT - height - top };
    }
    this.updateElements(changes);
  }

  // Text

  startEditing(id: string, options: StartEditingOptions = {}): void {
    if (!this.canEdit) return;
    const element = this.current?.elements.find(candidate => candidate.id === id);
    if (!element?.content) return;
    if (this.editingId && this.editingId !== id) this.stopEditing();
    this.#undo.stopCapturing();
    this.#lastAction = '';
    this.selection = [id];
    this.area = 'canvas';
    if (this.editingId === id && this.textEditor) {
      this.#applyEditOptions(this.textEditor, options);
      return;
    }
    this.#pendingEdit = options;
    this.editingId = id;
  }

  /** Called by the text box once its editor exists. */
  attachEditor(editor: Editor): void {
    this.textEditor = editor;
    const bump = () => {
      // The editor reports changes while the page is being redrawn; count them afterwards.
      queueMicrotask(() => {
        if (this.textEditor === editor) this.editorTick += 1;
      });
    };
    editor.on('transaction', bump);
    const element = this.editing;
    // A body box starts as a list, the way most slides are written.
    if (element?.role === 'body' && richTextIsEmpty(element.content) && !editor.isActive('bulletList')) {
      editor.chain().toggleBulletList().run();
    }
    this.#applyEditOptions(editor, this.#pendingEdit ?? {});
    this.#pendingEdit = null;
  }

  #applyEditOptions(editor: Editor, options: StartEditingOptions): void {
    // Focus now, not a frame later: keys pressed straight after a click belong to the text.
    editor.view.focus();
    const position = options.point ? editor.view.posAtCoords({ left: options.point.x, top: options.point.y }) : null;
    if (options.selectAll) editor.commands.selectAll();
    else if (position) editor.commands.setTextSelection(position.pos);
    else editor.commands.setTextSelection(editor.state.doc.content.size);
    if (options.insert) editor.commands.insertContent(options.insert);
    options.then?.(editor);
  }

  detachEditor(editor: Editor): void {
    if (this.textEditor === editor) this.textEditor = null;
  }

  /**
   * Leaves the text box. `contentHeight` is how tall its text turned out: a
   * text box grows to hold what was typed, and one left empty is removed.
   */
  stopEditing(contentHeight?: number): void {
    const element = this.editing;
    const slideId = this.currentId;
    this.editingId = null;
    this.#pendingEdit = null;
    this.#undo.stopCapturing();
    this.#lastAction = '';
    if (!element || !slideId || !this.canEdit || element.type !== 'text') return;
    const measured = contentHeight ?? this.measureEditing?.();
    if (richTextIsEmpty(element.content) && !element.role) {
      this.deck.deleteElements(slideId, [element.id]);
      this.selection = this.selection.filter(id => id !== element.id);
    } else if (measured && measured > element.h + 1) {
      this.deck.updateElements(slideId, { [element.id]: { h: Math.ceil(measured) } });
    }
    this.#undo.stopCapturing();
  }

  /** Set by the text box being edited: how tall its text is now, in slide units. */
  measureEditing: (() => number) | undefined;

  /** The mark is on: under the cursor while typing, otherwise on all the text of every selected box. */
  markActive(mark: TextMark): boolean {
    void this.editorTick;
    void this.revision;
    if (this.textEditor && this.editingId) return this.textEditor.isActive(mark);
    const boxes = this.selectedText;
    return boxes.length > 0 && !!this.currentId && boxes.every(element => this.deck.allTextHasMark(this.currentId!, element.id, mark));
  }

  toggleMark(mark: TextMark): void {
    if (!this.canEdit || !this.currentId) return;
    if (this.textEditor && this.editingId) {
      this.textEditor.chain().focus().toggleMark(mark).run();
      return;
    }
    const on = !this.markActive(mark);
    const slideId = this.currentId;
    this.#act(() => this.deck.transact(() => {
      for (const element of this.selectedText) this.deck.formatAllText(slideId, element.id, mark, on ? {} : null);
    }));
  }

  #hasTextSelection(): boolean {
    return !!this.textEditor && !!this.editingId && !this.textEditor.state.selection.empty;
  }

  /** Colours the selected words, or all the text of the selected boxes when no words are selected. */
  setTextColour(colour: string | null): void {
    if (!this.canEdit || !this.currentId) return;
    if (this.#hasTextSelection()) {
      const chain = this.textEditor!.chain().focus();
      if (colour) chain.setMark('color', { color: colour }).run();
      else chain.unsetMark('color').run();
      return;
    }
    this.#formatBoxes('color', { color: colour ?? undefined });
  }

  setFontSize(size: number): void {
    if (!this.canEdit || !this.currentId) return;
    const clamped = Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(size)));
    if (this.#hasTextSelection()) {
      this.textEditor!.chain().focus().setMark('fontSize', { size: clamped }).run();
      return;
    }
    this.#formatBoxes('fontSize', { fontSize: clamped });
    this.textEditor?.commands.focus();
  }

  /** Sets a property of whole boxes and clears the same formatting from the words inside, so it shows everywhere. */
  #formatBoxes(mark: 'color' | 'fontSize', props: ElementProps): void {
    const slideId = this.currentId!;
    const changes: Record<string, ElementProps> = {};
    for (const element of this.selectedText) changes[element.id] = props;
    this.#act(() => this.deck.transact(() => {
      this.deck.updateElements(slideId, changes);
      for (const element of this.selectedText) this.deck.formatAllText(slideId, element.id, mark, null);
    }), mark);
  }

  /** The size of the text under the cursor, or of the first selected box. */
  get fontSize(): number | null {
    void this.editorTick;
    const element = this.editing ?? this.selectedText[0];
    if (!element) return null;
    const base = textStyle(element, this.theme, this.current?.layout ?? 'blank').fontSize;
    if (this.textEditor && this.editingId) {
      const marked = this.textEditor.getAttributes('fontSize').size as number | undefined;
      if (marked) return marked;
    }
    return base;
  }

  /** The stored colour of the text under the cursor or of the first selected box; undefined when it follows the theme. */
  get textColour(): string | undefined {
    void this.editorTick;
    if (this.textEditor && this.editingId) {
      const marked = this.textEditor.getAttributes('color').color as string | undefined;
      if (marked) return marked;
    }
    return (this.editing ?? this.selectedText[0])?.color;
  }

  listActive(list: 'bulletList' | 'orderedList'): boolean {
    void this.editorTick;
    return !!this.textEditor && !!this.editingId && this.textEditor.isActive(list);
  }

  toggleList(list: 'bulletList' | 'orderedList'): void {
    if (!this.canEdit) return;
    const run = (editor: Editor) => {
      if (list === 'bulletList') editor.chain().focus().toggleBulletList().run();
      else editor.chain().focus().toggleOrderedList().run();
    };
    if (this.textEditor && this.editingId) {
      run(this.textEditor);
      return;
    }
    // With a box selected but no cursor in it, the whole box becomes a list.
    const element = this.selectedText[0];
    if (element) this.startEditing(element.id, { selectAll: true, then: run });
  }

  setAlign(align: TextAlign): void {
    this.#updateText({ align });
  }

  setVerticalAlign(valign: VerticalAlign): void {
    this.#updateText({ valign });
  }

  #updateText(props: ElementProps): void {
    if (!this.canEdit || !this.currentId) return;
    const changes: Record<string, ElementProps> = {};
    for (const element of this.selectedText) changes[element.id] = props;
    this.#act(() => this.deck.updateElements(this.currentId!, changes));
    this.textEditor?.commands.focus();
  }

  // Clipboard

  copyPayload(): { payload: ClipboardPayload; text: string } | null {
    if (this.area === 'strip' || this.selection.length === 0) {
      if (this.area !== 'strip') return null;
      const slides = this.slides.filter(slide => this.pickedSlides.includes(slide.id));
      if (slides.length === 0) return null;
      return {
        payload: {
          kind: 'iris-slides',
          version: 1,
          slides: slides.map(slide => ({
            layout: slide.layout,
            ...(slide.background ? { background: slide.background } : {}),
            notes: slide.notes?.toString() ?? '',
            elements: slide.elements.map(elementToJson),
          })),
        },
        text: slides.map(slide => slide.elements.map(element => richTextToPlain(element.content)).filter(Boolean).join('\n')).join('\n\n'),
      };
    }
    return {
      payload: { kind: 'iris-slides', version: 1, elements: this.selected.map(elementToJson) },
      text: this.selected.map(element => richTextToPlain(element.content)).filter(Boolean).join('\n'),
    };
  }

  cut(): void {
    if (this.area === 'strip') this.deleteSlides();
    else this.deleteSelected();
  }

  paste(payload: ClipboardPayload): void {
    if (!this.canEdit) return;
    if (payload.slides?.length) {
      this.stopEditing();
      let after = this.currentId;
      const ids = this.#act(() => this.deck.transact(() => payload.slides!.map((slide) => {
        const id = this.deck.addSlide(typeof slide.layout === 'string' ? slide.layout : 'blank', (slide.elements ?? []) as ElementInit[], after, slide.background);
        if (slide.notes) this.deck.setNotes(id, String(slide.notes));
        after = id;
        return id;
      })));
      if (ids.length) {
        this.goTo(ids[ids.length - 1]!);
        this.pickedSlides = ids;
      }
    } else if (payload.elements?.length) {
      // Each paste of the same thing steps a little further, so copies do not hide each other.
      this.#pasteCount += 1;
      const offset = 24 * this.#pasteCount;
      this.#add(payload.elements.map(element => ({
        ...element,
        x: (typeof element.x === 'number' ? element.x : 0) + offset,
        y: (typeof element.y === 'number' ? element.y : 0) + offset,
      })));
    }
  }

  /** Forget how many times the clipboard was pasted; called when something new is copied. */
  resetPasteOffset(): void {
    this.#pasteCount = 0;
  }

  pasteText(value: string): void {
    const trimmed = value.replace(/\r\n?/g, '\n').trim();
    if (!trimmed) return;
    const w = 640;
    // A guess at the height; the box grows to its text the first time it is edited.
    const h = Math.min(560, Math.max(60, Math.round(trimmed.split('\n').length * 24 * 1.35 + 20)));
    this.#add([{ type: 'text', ...this.#place(w, h), w, h, rot: 0, text: trimmed }]);
  }
}

async function imageSize(file: File): Promise<{ width: number; height: number }> {
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    if (size.width > 0 && size.height > 0) return size;
  } catch {
    // Some images (SVG) cannot be decoded this way; an <img> can still measure them.
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    const done = (width: number, height: number) => {
      URL.revokeObjectURL(url);
      resolve({ width: width || 400, height: height || 300 });
    };
    image.onload = () => done(image.naturalWidth, image.naturalHeight);
    image.onerror = () => done(400, 300);
    image.src = url;
  });
}
