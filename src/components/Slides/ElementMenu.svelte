<script lang="ts">
  /** The menu of the slide itself, opened with a right click: what can be done with what is selected, or pasting. */
  import type { SlidesEditorState } from '../../lib/slides/editorState.svelte';
  import Popover from './Popover.svelte';
  import { cellChoice, clearPicked, mergePicked, unmergePicked } from '../../lib/slides/tableCells';

  interface Props {
    editorState: SlidesEditorState;
    open: boolean;
    at: { x: number; y: number } | undefined;
    /** Copies the selection; takes it off the slide too when `cut`. */
    onCopy: (cut: boolean) => void;
    onPaste: () => void;
    /** Puts a picture of the selection, or of the slide, on the clipboard. */
    onCopyImage: () => void;
    /** Called as an item is chosen, before it acts. */
    onDone: () => void;
  }
  let { editorState, open = $bindable(), at, onCopy, onPaste, onCopyImage, onDone }: Props = $props();

  const modifier = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';

  let reveals = $derived(editorState.selected.every(element => element.appearOn !== undefined));

  function toggleAppearance(): void {
    const last = editorState.current?.elements.reduce((max, element) => Math.max(max, element.appearOn ?? 0), 0) ?? 0;
    editorState.updateSelected({ appearOn: reveals ? undefined : last + 1 });
  }

  function run(action: () => void): void {
    open = false;
    onDone();
    action();
  }
</script>

<Popover bind:open anchor={at} label="Element options">
  {#if editorState.selection.length > 0}
    <button class="menu-item" onclick={() => run(() => onCopy(true))} data-testid="element-menu-cut">
      <span class="i-lucide-scissors"></span>Cut<span class="keys">{modifier}X</span>
    </button>
    <button class="menu-item" onclick={() => run(() => onCopy(false))} data-testid="element-menu-copy">
      <span class="i-lucide-copy"></span>Copy<span class="keys">{modifier}C</span>
    </button>
  {/if}
  <button class="menu-item" onclick={() => run(onCopyImage)} data-testid="element-menu-copy-image">
    <span class="i-lucide-image"></span>{editorState.selection.length > 0 ? 'Copy image' : 'Copy slide as image'}
  </button>
  <button class="menu-item" onclick={() => run(onPaste)} data-testid="element-menu-paste">
    <span class="i-lucide-clipboard"></span>Paste<span class="keys">{modifier}V</span>
  </button>
  {#if editorState.selectedTable}
    {@const choice = cellChoice(editorState)}
    <div class="menu-divider"></div>
    {#if choice.canMerge}
      <button class="menu-item" onclick={() => run(() => mergePicked(editorState))} data-testid="element-menu-merge">
        <span class="i-lucide-table-cells-merge"></span>Merge cells
      </button>
    {/if}
    {#if choice.canUnmerge}
      <button class="menu-item" onclick={() => run(() => unmergePicked(editorState))} data-testid="element-menu-unmerge">
        <span class="i-lucide-table-cells-split"></span>Unmerge cells
      </button>
    {/if}
    {#if editorState.pickedCells}
      <button class="menu-item" onclick={() => run(() => clearPicked(editorState))} data-testid="element-menu-clear-cells">
        <span class="i-lucide-eraser"></span>Clear cells<span class="keys">Delete</span>
      </button>
    {/if}
  {/if}
  {#if editorState.selection.length > 0}
    <div class="menu-divider"></div>
    <button class="menu-item" onclick={() => run(toggleAppearance)} data-testid="element-menu-appear">
      <span class="i-lucide-mouse-pointer-click"></span>{reveals ? 'Show from start' : 'Appear on click'}
    </button>
    <button class="menu-item" onclick={() => run(() => editorState.duplicateSelected())} data-testid="element-menu-duplicate">
      <span class="i-lucide-copy-plus"></span>Duplicate<span class="keys">{modifier}D</span>
    </button>
    <button class="menu-item" onclick={() => run(() => editorState.deleteSelected())} data-testid="element-menu-delete">
      <span class="i-lucide-trash-2"></span>Delete
    </button>
    <div class="menu-divider"></div>
    <button class="menu-item" onclick={() => run(() => editorState.arrange('front'))} data-testid="element-menu-front">
      <span class="i-lucide-bring-to-front"></span>Bring to front
    </button>
    <button class="menu-item" onclick={() => run(() => editorState.arrange('forward'))} data-testid="element-menu-forward">
      <span class="i-lucide-arrow-up"></span>Bring forward<span class="keys">{modifier}]</span>
    </button>
    <button class="menu-item" onclick={() => run(() => editorState.arrange('backward'))} data-testid="element-menu-backward">
      <span class="i-lucide-arrow-down"></span>Send backward<span class="keys">{modifier}[</span>
    </button>
    <button class="menu-item" onclick={() => run(() => editorState.arrange('back'))} data-testid="element-menu-back">
      <span class="i-lucide-send-to-back"></span>Send to back
    </button>
  {:else}
    <button class="menu-item" onclick={() => run(() => editorState.selectAll())} data-testid="element-menu-select-all">
      <span class="i-lucide-box-select"></span>Select all<span class="keys">{modifier}A</span>
    </button>
  {/if}
</Popover>
