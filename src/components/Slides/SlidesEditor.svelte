<script lang="ts">
  /**
   * A presentation: the strip of slides, the slide being worked on, its
   * notes, and presenting. Someone who may only view gets the slides and
   * presenting, without anything that edits. Opened as the presenter's
   * window, it shows the presenter's view and nothing else.
   */
  import { onMount, onDestroy } from 'svelte';
  import DocumentHeader from '../Viewer/DocumentHeader.svelte';
  import { DriveDocument } from '../../lib/yjs';
  import { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import { createClipboard, eventPlace } from './clipboardEvents';
  import type { Point } from '../../lib/slides/geometry';
  import Canvas from './Canvas.svelte';
  import SlideStrip from './SlideStrip.svelte';
  import Toolbar from './Toolbar.svelte';
  import NotesBox from './NotesBox.svelte';
  import SlideStack from './SlideStack.svelte';
  import Popover from './Popover.svelte';
  import { isPresenterWindow, presenterUrl } from '../../lib/slides/presentSync';
  import { clearPicked, stretchCells } from '../../lib/slides/tableEditing';

  interface Props {
    dirName: string;
  }
  let { dirName }: Props = $props();

  // svelte-ignore state_referenced_locally
  const drive = new DriveDocument(dirName);
  let editorState = $state.raw<SlidesEditorState | null>(null);
  let root: HTMLElement | undefined = $state();
  let imageInput: HTMLInputElement | undefined = $state();
  const clipboard = createClipboard({
    state: () => editorState,
    urls: drive.attachmentUrls,
    addAttachment: file => drive.addAttachment(file),
    root: () => root,
  });
  const { onCopy, onCut, onPaste, menuCopy, menuPaste } = clipboard;

  let canEdit = $derived(!!editorState?.canEdit);

  // Presenting, the presenter's window and printing are loaded apart from the editor, so a deck opens light.
  // Presenting is fetched once the deck is open, so that it starts at once when asked for.
  let presentView: ReturnType<typeof loadPresentView> | null = null;
  function loadPresentView() {
    return import('./PresentView.svelte');
  }
  const presentViewLoaded = () => (presentView ??= loadPresentView());
  let urls = $derived(drive.attachmentUrls);

  /** This window was opened beside a presentation, for the one presenting. */
  const presenterWindow = isPresenterWindow(window.location.hash);
  let printing = $state(false);
  let moreOpen = $state(false);
  let moreButton: HTMLElement | undefined = $state();
  /** On a phone, someone who is only reading gets the slides one under the other. */
  const narrowScreen = window.matchMedia('(max-width: 639px)');
  let narrow = $state(narrowScreen.matches);
  const onNarrowChange = () => (narrow = narrowScreen.matches);

  onMount(() => {
    void (async () => {
      if (!await drive.open()) return;
      const created = new SlidesEditorState(drive.ydoc, {
        addAttachment: file => drive.addAttachment(file),
        canEdit: () => drive.canEdit,
      });
      if (!presenterWindow) created.startDeck();
      editorState = created;
      if (!presenterWindow) setTimeout(() => void presentViewLoaded(), 1500);
    })();
    narrowScreen.addEventListener('change', onNarrowChange);
    if (presenterWindow) return;
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
  });

  onDestroy(() => {
    narrowScreen.removeEventListener('change', onNarrowChange);
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('cut', onCut);
    document.removeEventListener('paste', onPaste);
    editorState?.stopEditing();
    editorState?.destroy();
    drive.destroy();
  });

  function present(): void {
    if (!editorState || editorState.slides.length === 0) return;
    editorState.stopEditing();
    editorState.presenting = true;
  }

  /** Opens the presenter's window: the same presentation, marked as the presenter's. */
  function openNotesWindow(): void {
    window.open(presenterUrl(window.location.href), 'irisslides-presenter', 'popup=yes,width=1180,height=720');
  }

  function presentWithNotes(): void {
    moreOpen = false;
    openNotesWindow();
    present();
  }

  let exporting = $state(false);

  /** The deck as a .pptx file. The code that writes it is fetched only now. */
  async function savePowerPoint(): Promise<void> {
    const current = editorState;
    if (!current || exporting) return;
    exporting = true;
    current.stopEditing();
    try {
      const { downloadPptx } = await import('../../lib/slides/pptx');
      await downloadPptx({ slides: current.slides, theme: current.theme, title: drive.title, urls });
      moreOpen = false;
    } catch (error) {
      console.error('[Slides] Could not make the PowerPoint file:', error);
      current.notice = 'Could not make the PowerPoint file.';
    } finally {
      exporting = false;
    }
  }

  function print(): void {
    moreOpen = false;
    editorState?.stopEditing();
    printing = true;
  }

  function focusCanvas(): void {
    root?.querySelector<HTMLElement>('[data-testid="slide-canvas"]')?.focus({ preventScroll: true });
  }

  function place(target: EventTarget | null): 'text' | 'field' | 'editor' | 'elsewhere' {
    return eventPlace(root, target);
  }

  function onKeyDown(event: KeyboardEvent): void {
    const current = editorState;
    if (!current || current.presenting || event.defaultPrevented || event.isComposing) return;
    // An open menu takes Escape for itself.
    if (document.querySelector('[data-slides-popover]')) return;
    const where = place(event.target);
    if (where === 'elsewhere') return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    const lower = key.toLowerCase();
    const done = () => {
      event.preventDefault();
      event.stopPropagation();
    };

    // What concerns the whole deck works from anywhere, also in the middle of typing.
    if (mod && key === 'Enter') {
      done();
      present();
      return;
    }
    if (mod && !event.altKey && !event.shiftKey && lower === 'm' && current.canEdit) {
      done();
      current.addSlide();
      focusCanvas();
      return;
    }
    if (where === 'field') return;
    if ((key === 'PageDown' || key === 'PageUp') && !mod) {
      done();
      current.goBy(key === 'PageDown' ? 1 : -1);
      focusCanvas();
      return;
    }

    if (mod && !event.altKey && lower === 'z') {
      done();
      if (event.shiftKey) current.redo();
      else current.undo();
      return;
    }
    if (mod && !event.altKey && lower === 'y') {
      done();
      current.redo();
      return;
    }
    if (where === 'text' || current.editingId) {
      if (key === 'Escape') {
        done();
        current.stopEditing();
        focusCanvas();
      } else if (where !== 'text') {
        // A box is being typed in but the cursor is elsewhere: keys must not act on the box itself.
        current.textEditor?.view.focus();
      }
      return;
    }

    const strip = current.area === 'strip';
    const selected = !strip && current.selection.length > 0;

    if (key === 'Escape' && current.tool) {
      done();
      current.armTool(null);
      return;
    }
    // In a selected table: Shift and the arrows pick cells, Delete empties the picked ones, Escape lets go of them.
    if (current.canEdit && !strip && current.selectedTable && (current.tableCell || current.cellRange)) {
      if (event.shiftKey && !mod && !event.altKey && key.startsWith('Arrow')) {
        done();
        stretchCells(current, key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0, key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0);
        return;
      }
      if ((key === 'Delete' || key === 'Backspace') && current.pickedCells) {
        done();
        clearPicked(current);
        return;
      }
      if (key === 'Escape' && current.cellRange) {
        done();
        current.cellRange = null;
        return;
      }
    }
    if (key === 'Home' || key === 'End') {
      const target = key === 'Home' ? current.slides[0] : current.slides[current.slides.length - 1];
      if (target) {
        done();
        current.goTo(target.id);
      }
      return;
    }
    if (key.startsWith('Arrow') && !(selected && current.canEdit)) {
      const step = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1;
      done();
      if (current.canEdit && strip && (mod || event.altKey)) current.shiftSlides(step);
      else current.goBy(step);
      return;
    }
    if (!current.canEdit) return;

    if (key.startsWith('Arrow')) {
      const distance = event.shiftKey ? 10 : 1;
      done();
      current.nudge(
        key === 'ArrowLeft' ? -distance : key === 'ArrowRight' ? distance : 0,
        key === 'ArrowUp' ? -distance : key === 'ArrowDown' ? distance : 0,
      );
    } else if (key === 'Delete' || key === 'Backspace') {
      if (selected) {
        done();
        current.deleteSelected();
      } else if (strip) {
        done();
        current.deleteSlides();
      }
    } else if (key === 'Escape') {
      if (selected) {
        done();
        current.select([]);
      }
    } else if (mod && lower === 'a') {
      done();
      if (strip) current.pickedSlides = current.slides.map(slide => slide.id);
      else current.selectAll();
    } else if (mod && lower === 'd') {
      done();
      if (selected) current.duplicateSelected();
      else current.duplicateSlides();
    } else if (mod && (key === ']' || key === '[') && selected) {
      done();
      if (key === ']') current.arrange(event.shiftKey ? 'front' : 'forward');
      else current.arrange(event.shiftKey ? 'back' : 'backward');
    } else if (mod && (lower === 'b' || lower === 'i' || lower === 'u') && current.selectedText.length > 0) {
      done();
      current.toggleMark(lower === 'b' ? 'bold' : lower === 'i' ? 'italic' : 'underline');
    } else if (key === 'Tab' && !mod && selected && current.current && current.current.elements.length > 0) {
      // With something selected, Tab walks through the elements of the slide; with nothing, it moves on to the notes as usual.
      const elements = current.current.elements;
      const at = elements.findIndex(element => element.id === current.selection[0]);
      const next = elements[(at + (event.shiftKey ? -1 : 1) + elements.length) % elements.length] ?? elements[0]!;
      done();
      current.select([next.id]);
    } else if (key === 'Enter' && !mod) {
      const element = selected && current.selection.length === 1 ? current.selectedText[0] : undefined;
      if (element) {
        done();
        current.startEditing(element.id);
      } else if (strip) {
        done();
        current.addSlide();
      }
    } else if (key.length === 1 && key !== ' ' && !mod && !event.altKey && !strip) {
      // Typing with a box selected goes into the box; with nothing selected, into the first empty one.
      const box = current.selection.length === 1 ? current.selectedText[0] : current.selection.length === 0 ? current.firstEmptyBox : null;
      if (box) {
        done();
        current.startEditing(box.id, { insert: key });
      }
    }
  }

  function addImages(files: File[], at?: Point): void {
    files.forEach((file, index) => {
      void editorState?.addImage(file, at ? { x: at.x + index * 24, y: at.y + index * 24 } : undefined);
    });
  }

  function onImagesPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    addImages([...(input.files ?? [])]);
    input.value = '';
  }
</script>

<div class="flex-1 flex flex-col min-h-0 bg-surface-0" data-testid="document-editor" bind:this={root}>
  <DocumentHeader {drive}>
    {#if editorState && editorState.slides.length > 0 && !presenterWindow}
      <button onclick={present} class="btn-ghost flex items-center gap-1.5 max-sm:px-2.5" title="Present" aria-label="Present" data-testid="present">
        <span class="i-lucide-play text-sm"></span><span class="max-sm:hidden">Present</span>
      </button>
      <button bind:this={moreButton} onclick={() => (moreOpen = !moreOpen)} class="btn-circle btn-ghost" title="More" aria-label="More" aria-expanded={moreOpen} data-testid="slides-more">
        <span class="i-lucide-ellipsis text-base"></span>
      </button>
    {/if}
  </DocumentHeader>

  <Popover bind:open={moreOpen} anchor={moreButton} label="More">
    <button class="menu-item" onclick={presentWithNotes} data-testid="present-with-notes">
      <span class="i-lucide-notebook-text"></span>Present with notes
    </button>
    <button class="menu-item" onclick={print} data-testid="slides-print-button">
      <span class="i-lucide-printer"></span>Print or save as PDF
    </button>
    <button class="menu-item" onclick={() => void savePowerPoint()} disabled={exporting} data-testid="slides-pptx-button">
      <span class={exporting ? 'i-lucide-loader-2 animate-spin' : 'i-lucide-file-down'}></span>Download as PowerPoint
    </button>
  </Popover>

  {#if !editorState}
    <div class="flex-1 flex items-center justify-center text-text-3 text-sm">
      {#if drive.loading && drive.missing}
        <span data-testid="document-missing">Presentation not found</span>
      {:else}
        <span class="i-lucide-loader-2 animate-spin" data-testid="document-loading"></span>
      {/if}
    </div>
  {:else if presenterWindow}
    {#await import('./PresenterView.svelte') then { default: PresenterView }}
      <PresenterView slides={editorState.slides} theme={editorState.theme} {urls} title={drive.title} revision={editorState.revision} />
    {/await}
  {:else}
    {#if canEdit}
      <Toolbar {editorState} onPickImage={() => imageInput?.click()} />
    {/if}
    {#if editorState.deck.isNewer}
      <div class="shrink-0 px-4 py-1.5 text-xs text-text-1 bg-warning/20" role="status">
        This presentation was made with a newer version of Iris Drive. It can be viewed here, not changed.
      </div>
    {:else if editorState.notice}
      <div class="shrink-0 px-4 py-1.5 text-xs text-text-1 bg-warning/20" role="alert">{editorState.notice}</div>
    {/if}

    {#if editorState.slides.length === 0}
      <div class="flex-1 flex flex-col items-center justify-center gap-3 text-text-3 text-sm" data-testid="slides-empty">
        No slides yet
        {#if canEdit}
          <button class="btn-ghost flex items-center gap-1.5" onclick={() => editorState?.addSlide('title')} data-testid="slides-empty-add">
            <span class="i-lucide-plus"></span>Add a slide
          </button>
        {/if}
      </div>
    {:else if narrow && !canEdit}
      <SlideStack
        slides={editorState.slides}
        theme={editorState.theme}
        {urls}
        onPresent={(slideId) => {
          editorState?.goTo(slideId);
          present();
        }}
      />
    {:else}
      <div class="flex-1 flex min-h-0 flex-col-reverse sm:flex-row" data-testid="slides-workspace">
        <SlideStrip {editorState} {urls} />
        <div class="flex-1 flex flex-col min-w-0 min-h-0">
          <Canvas {editorState} {urls} onImageFiles={addImages} onCopy={menuCopy} onPaste={() => void menuPaste()} />
          {#if canEdit}
            <NotesBox {editorState} />
          {/if}
        </div>
      </div>
    {/if}

    {#if editorState.presenting}
      {#await presentViewLoaded() then { default: PresentView }}
      <PresentView
        slides={editorState.slides}
        theme={editorState.theme}
        {urls}
        startId={editorState.currentId}
        onExit={(slideId) => {
          const current = editorState;
          if (!current) return;
          current.presenting = false;
          if (slideId) current.goTo(slideId);
          focusCanvas();
        }}
        onOpenNotes={openNotesWindow}
      />
      {/await}
    {/if}
    {#if printing}
      {#await import('./PrintView.svelte') then { default: PrintView }}
        <PrintView slides={editorState.slides} theme={editorState.theme} {urls} onDone={() => (printing = false)} />
      {/await}
    {/if}
  {/if}
</div>

<input bind:this={imageInput} type="file" accept="image/*" multiple onchange={onImagesPicked} class="hidden" data-testid="slides-image-input" />
