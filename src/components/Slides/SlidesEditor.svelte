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
  import { SlidesEditorState, CLIPBOARD_TYPE, type ClipboardPayload } from '../../lib/slides/editorState.svelte';
  import type { Point } from '../../lib/slides/geometry';
  import Canvas from './Canvas.svelte';
  import SlideStrip from './SlideStrip.svelte';
  import Toolbar from './Toolbar.svelte';
  import NotesBox from './NotesBox.svelte';
  import PresentView from './PresentView.svelte';
  import PresenterView from './PresenterView.svelte';
  import PrintView from './PrintView.svelte';
  import SlideStack from './SlideStack.svelte';
  import Popover from './Popover.svelte';
  import { isPresenterWindow, presenterUrl } from '../../lib/slides/presentSync';

  interface Props {
    dirName: string;
  }
  let { dirName }: Props = $props();

  // svelte-ignore state_referenced_locally
  const drive = new DriveDocument(dirName);
  let editorState = $state.raw<SlidesEditorState | null>(null);
  let root: HTMLElement | undefined = $state();
  let imageInput: HTMLInputElement | undefined = $state();
  /** What was last copied here, for browsers that keep only plain text on the clipboard. */
  let copied: { payload: ClipboardPayload; text: string } | null = null;

  let canEdit = $derived(!!editorState?.canEdit);
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

  function print(): void {
    moreOpen = false;
    editorState?.stopEditing();
    printing = true;
  }

  function focusCanvas(): void {
    root?.querySelector<HTMLElement>('[data-testid="slide-canvas"]')?.focus({ preventScroll: true });
  }

  /** Where a key or clipboard event happened: in a text box, in some other field, or neither. */
  function place(target: EventTarget | null): 'text' | 'field' | 'editor' | 'elsewhere' {
    const element = target instanceof Element ? target : null;
    if (!element || element === document.body || element === document.documentElement) return 'editor';
    if (!root?.contains(element)) return 'elsewhere';
    if (element.closest('.ProseMirror')) return 'text';
    // A control with keys of its own, such as the line above the notes, keeps them.
    if (element.closest('input, textarea, select, [contenteditable="true"], [role="separator"]')) return 'field';
    return 'editor';
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
    } else if (key === 'Tab' && !mod && current.current && current.current.elements.length > 0 && !strip) {
      // Tab walks through the elements of the slide.
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

  function copyTo(event: ClipboardEvent): boolean {
    const current = editorState;
    if (!current || current.presenting || place(event.target) !== 'editor') return false;
    // Selected words elsewhere on the page are copied as usual.
    if (!window.getSelection()?.isCollapsed) return false;
    const data = current.copyPayload();
    if (!data || !event.clipboardData) return false;
    event.preventDefault();
    event.clipboardData.setData(CLIPBOARD_TYPE, JSON.stringify(data.payload));
    event.clipboardData.setData('text/plain', data.text || ' ');
    copied = data;
    current.resetPasteOffset();
    return true;
  }

  function onCopy(event: ClipboardEvent): void {
    copyTo(event);
  }

  function onCut(event: ClipboardEvent): void {
    if (editorState?.canEdit && copyTo(event)) editorState.cut();
  }

  function onPaste(event: ClipboardEvent): void {
    const current = editorState;
    if (!current?.canEdit || current.presenting || place(event.target) !== 'editor' || !event.clipboardData) return;
    const raw = event.clipboardData.getData(CLIPBOARD_TYPE);
    if (raw) {
      try {
        const payload = JSON.parse(raw) as ClipboardPayload;
        if (payload?.kind === 'iris-slides') {
          event.preventDefault();
          current.paste(payload);
          return;
        }
      } catch {
        // Not ours after all; fall through to what else the clipboard holds.
      }
    }
    const images = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'));
    if (images.length) {
      event.preventDefault();
      for (const file of images) void current.addImage(file);
      return;
    }
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    if (copied && (copied.text || ' ') === text) current.paste(copied.payload);
    else current.pasteText(text);
  }

  /** Copy and cut from a menu, where there is no clipboard event to fill. */
  function menuCopy(cut: boolean): void {
    const current = editorState;
    const data = current?.copyPayload();
    if (!current || !data) return;
    copied = data;
    current.resetPasteOffset();
    void navigator.clipboard?.writeText(data.text || ' ').catch(() => {});
    if (cut && current.canEdit) current.cut();
  }

  /** Paste from a menu: what the clipboard holds if the browser lets it be read, otherwise what was last copied here. */
  async function menuPaste(): Promise<void> {
    const current = editorState;
    if (!current?.canEdit) return;
    let text: string | null = null;
    try {
      for (const item of await navigator.clipboard.read()) {
        const image = item.types.find(type => type.startsWith('image/'));
        if (image) {
          const blob = await item.getType(image);
          void current.addImage(new File([blob], `pasted.${image.split('/')[1] ?? 'png'}`, { type: image }));
          return;
        }
        if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
      }
    } catch {
      text = await navigator.clipboard?.readText?.().catch(() => null) ?? null;
    }
    if (copied && (text === null || text === (copied.text || ' '))) current.paste(copied.payload);
    else if (text) current.pasteText(text);
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
    <PresenterView slides={editorState.slides} theme={editorState.theme} {urls} title={drive.title} revision={editorState.revision} />
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
    {/if}
    {#if printing}
      <PrintView slides={editorState.slides} theme={editorState.theme} {urls} onDone={() => (printing = false)} />
    {/if}
  {/if}
</div>

<input bind:this={imageInput} type="file" accept="image/*" multiple onchange={onImagesPicked} class="hidden" data-testid="slides-image-input" />
