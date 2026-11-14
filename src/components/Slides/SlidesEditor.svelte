<script lang="ts">
  /**
   * A presentation: the strip of slides, the slide being worked on, its
   * notes, and presenting. Someone who may only view gets the slides and
   * presenting, without anything that edits. Opened as the presenter's
   * window, it shows the presenter's view and nothing else.
   */
  import { onMount, onDestroy, untrack } from 'svelte';
  import * as Y from 'yjs';
  import DocumentHeader from '../Viewer/DocumentHeader.svelte';
  import { DriveDocument } from '../../lib/yjs';
  import { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import { LOCAL_ORIGIN } from '../../lib/slides/model';
  import { createClipboard, eventPlace } from './clipboardEvents';
  import type { Point } from '../../lib/slides/geometry';
  import Canvas from './Canvas.svelte';
  import SlideStrip from './SlideStrip.svelte';
  import Toolbar from './Toolbar.svelte';
  import NotesBox from './NotesBox.svelte';
  import SlideStack from './SlideStack.svelte';
  import Popover from './Popover.svelte';
  import DocumentLinkMenu from '../Viewer/DocumentLinkMenu.svelte';
  import { isPresenterWindow, presenterUrl } from '../../lib/slides/presentSync';
  import { stretchCells } from '../../lib/slides/tableEditing';
  import { readSiblingFile, takeImportRequest } from '../../lib/fileImports';

  interface Props {
    dirName: string;
  }
  let { dirName }: Props = $props();

  // svelte-ignore state_referenced_locally
  const drive = new DriveDocument(dirName);
  let editorState = $state.raw<SlidesEditorState | null>(null);
  /** An earlier version, shown read-only in place of the deck. */
  let versionState = $state.raw<SlidesEditorState | null>(null);
  /** What the editor shows: the deck, or the earlier version being looked at. */
  let shown = $derived(versionState ?? editorState);
  let root: HTMLElement | undefined = $state();
  let imageInput: HTMLInputElement | undefined = $state();
  const clipboard = createClipboard({
    state: () => shown,
    urls: drive.attachmentUrls,
    addAttachment: file => drive.addAttachment(file),
    root: () => root,
  });
  const { onCopy, onCut, onPaste, onBlur, menuCopy, menuPaste } = clipboard;

  let canEdit = $derived(!!shown?.canEdit);
  /** The field for a link's address is open, for the words chosen in the box being typed in. */
  let linkEditing = $state(false);
  let workspace: HTMLElement | undefined = $state();
  $effect(() => {
    if (!editorState?.textEditor) linkEditing = false;
  });
  // The text editor is fetched once the deck is shown to someone who may change it, not before.
  $effect(() => {
    if (canEdit) void import('../../lib/slides/richTextEditor');
  });

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
      // Opened from a PowerPoint file in the Drive: it comes in once (see fileImports.ts).
      const requested = presenterWindow ? null : takeImportRequest();
      if (requested) void importFromFolder(requested);
    })();
    narrowScreen.addEventListener('change', onNarrowChange);
    if (presenterWindow) return;
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('copy', onCopy);
    document.addEventListener('cut', onCut);
    document.addEventListener('paste', onPaste);
    window.addEventListener('blur', onBlur);
  });

  $effect(() => {
    const version = drive.preview;
    if (!version) {
      versionState = null;
      return;
    }
    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, version.update);
    const viewed = untrack(() => {
      editorState?.stopEditing();
      const made = new SlidesEditorState(ydoc, {
        addAttachment: () => Promise.reject(new Error('An earlier version cannot be changed')),
        canEdit: () => false,
      });
      // The slide that is open stays open, when the version has it.
      if (editorState?.currentId) made.goTo(editorState.currentId);
      return made;
    });
    versionState = viewed;
    return () => {
      viewed.destroy();
      ydoc.destroy();
    };
  });

  /** Makes the deck what an earlier version holds, as one step undo takes back. */
  async function restoreVersion(update: Uint8Array): Promise<void> {
    const current = editorState;
    if (!current) throw new Error('The presentation is not open');
    const { restoreVersion: restore } = await import('../../lib/yjs/versionHistory');
    current.stopEditing();
    current.step(() => restore(drive.ydoc, update, LOCAL_ORIGIN));
  }

  onDestroy(() => {
    narrowScreen.removeEventListener('change', onNarrowChange);
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('cut', onCut);
    document.removeEventListener('paste', onPaste);
    window.removeEventListener('blur', onBlur);
    editorState?.stopEditing();
    editorState?.destroy();
    drive.destroy();
  });

  function present(): void {
    // An earlier version on screen is only looked at.
    if (!editorState || editorState.slides.length === 0 || versionState) return;
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

  let importing = $state('');
  let pptxInput: HTMLInputElement | undefined = $state();

  /**
   * Brings a PowerPoint file into the deck: in place of a new, untouched
   * deck, otherwise after its last slide, as one step undo takes back. The
   * code that reads it is fetched only now.
   */
  async function importPowerPoint(file: Blob, name: string, fromRoute = false): Promise<void> {
    const current = editorState;
    if (!current?.canEdit || importing) return;
    moreOpen = false;
    current.stopEditing();
    importing = name;
    current.notice = '';
    try {
      const { importPptx } = await import('../../lib/slides/pptxImport');
      const replace = current.isBlank;
      const result = await importPptx(file, { ydoc: drive.ydoc, addAttachment: picture => drive.addAttachment(picture) }, { replace });
      if (fromRoute) current.forgetHistory();
      if (result.firstId) current.goTo(result.firstId);
      if (result.skipped.length) current.notice = `Left out of ${name}: ${result.skipped.join(', ')}.`;
    } catch (error) {
      console.error('[Slides] Could not bring in the PowerPoint file:', error);
      current.notice = error instanceof Error && /PowerPoint|slides/.test(error.message) ? error.message : `Could not bring in ${name}.`;
    } finally {
      importing = '';
    }
  }

  /** The file the address asks for, from the folder the deck is in. */
  async function importFromFolder(name: string): Promise<void> {
    const bytes = await readSiblingFile(name, 15_000);
    // A deck already made from the file (or written in since) is just opened.
    if (editorState && !editorState.isBlank) return;
    if (!bytes) {
      if (editorState) editorState.notice = `Could not find ${name} beside this presentation.`;
      return;
    }
    await importPowerPoint(new Blob([bytes as BlobPart]), name, true);
  }

  function onPptxPicked(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void importPowerPoint(file, file.name);
  }

  function hasFiles(event: DragEvent): boolean {
    return !!event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  }

  /** A PowerPoint file dropped anywhere on the editor is brought in; pictures are left to the slide. */
  function onDropFile(event: DragEvent): void {
    const files = [...(event.dataTransfer?.files ?? [])].filter(file => /\.pptx$/i.test(file.name));
    if (!files.length || !editorState?.canEdit) return;
    event.preventDefault();
    void importPowerPoint(files[0]!, files[0]!.name);
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
    const current = shown;
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
    // Ctrl+K: a link for the words chosen, or for an address to be typed in.
    if (mod && !event.altKey && !event.shiftKey && lower === 'k' && where === 'text' && current.textEditor) {
      done();
      linkEditing = true;
      return;
    }
    if (where === 'text' || current.editingId) {
      if (key === 'Escape') {
        done();
        current.stopEditing();
        focusCanvas();
      } else if (!current.textEditor && key.length === 1 && !mod && !event.altKey) {
        // The box's editor is still on its way: what is typed meanwhile goes in once it is there.
        done();
        current.typeAhead(key);
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
        void import('../../lib/slides/tableCells').then(cells => cells.clearPicked(current));
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

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="flex-1 flex flex-col min-h-0 bg-surface-0"
  data-testid="document-editor"
  bind:this={root}
  ondragover={event => {
    if (canEdit && hasFiles(event)) event.preventDefault();
  }}
  ondrop={onDropFile}
>
  <DocumentHeader {drive} editorMenu>
    {#if editorState && editorState.slides.length > 0 && !presenterWindow && !versionState}
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
    {#if canEdit}
      <button class="menu-item" onclick={() => pptxInput?.click()} disabled={!!importing} data-testid="slides-pptx-import">
        <span class="i-lucide-file-up"></span>Import PowerPoint
      </button>
      <button class="menu-item" onclick={() => { moreOpen = false; drive.openHistory(); }} data-testid="version-history">
        <span class="i-lucide-history"></span>Version history
      </button>
    {/if}
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
    {@const view = versionState ?? editorState}
    {#if versionState}
      {#await import('../Viewer/VersionBar.svelte') then { default: VersionBar }}
        <VersionBar {drive} onrestore={restoreVersion} />
      {/await}
    {:else if canEdit}
      <Toolbar {editorState} onPickImage={() => imageInput?.click()} onLink={() => (linkEditing = true)} />
    {/if}
    {#if versionState}
      <!-- What is said about the deck is not about the version shown. -->
    {:else if editorState.deck.isNewer}
      <div class="shrink-0 px-4 py-1.5 text-xs text-text-1 bg-warning/20" role="status">
        This presentation was made with a newer version of Iris Drive. It can be viewed here, not changed.
      </div>
    {:else if importing}
      <div class="shrink-0 px-4 py-1.5 text-xs text-text-1 bg-surface-2 flex items-center gap-2" role="status" data-testid="slides-importing">
        <span class="i-lucide-loader-2 animate-spin"></span>Bringing in {importing}…
      </div>
    {:else if editorState.notice}
      <div class="shrink-0 px-4 py-1.5 text-xs text-text-1 bg-warning/20 flex items-center gap-2" role="alert" data-testid="slides-notice">
        <span class="flex-1">{editorState.notice}</span>
        <button class="btn-circle btn-ghost w-6 h-6 min-h-0" onclick={() => editorState && (editorState.notice = '')} title="Dismiss" aria-label="Dismiss"><span class="i-lucide-x text-xs"></span></button>
      </div>
    {/if}

    <div class="flex-1 flex min-h-0">
    <div class="flex-1 flex flex-col min-w-0 min-h-0">
    {#if view.slides.length === 0}
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
        slides={view.slides}
        theme={view.theme}
        {urls}
        onPresent={(slideId) => {
          if (versionState) return;
          editorState?.goTo(slideId);
          present();
        }}
      />
    {:else}
      <div class="relative flex-1 flex min-h-0 flex-col-reverse sm:flex-row" data-testid="slides-workspace" bind:this={workspace}>
        {#key view}
          <SlideStrip editorState={view} {urls} />
          <div class="flex-1 flex flex-col min-w-0 min-h-0">
            <Canvas editorState={view} {urls} onImageFiles={addImages} onCopy={menuCopy} onPaste={() => void menuPaste()} />
            {#if canEdit}
              <NotesBox editorState={view} />
            {/if}
          </div>
        {/key}
        {#if view.textEditor && workspace}
          <DocumentLinkMenu editor={view.textEditor} page={workspace} bind:editing={linkEditing} />
        {/if}
      </div>
    {/if}
    </div>
    {#if drive.historyOpen}
      {#await import('../Viewer/VersionHistoryPanel.svelte') then { default: VersionHistoryPanel }}
        <VersionHistoryPanel {drive} />
      {/await}
    {/if}
    </div>

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
<input bind:this={pptxInput} type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" onchange={onPptxPicked} class="hidden" data-testid="slides-pptx-input" />
