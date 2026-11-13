<script lang="ts">
  /** The bar above the grid: where the selection is, and the content of its cell for reading and typing. */
  import { parseRectName } from '../../lib/sheets/address';
  import type { SheetController } from '../../lib/sheets/controller.svelte';

  interface Props {
    ctl: SheetController;
  }
  let { ctl }: Props = $props();

  let input: HTMLTextAreaElement | undefined = $state();
  let nameInput: HTMLInputElement | undefined = $state();
  let nameDraft = $state<string | null>(null);

  let text = $derived(ctl.barText);
  let editingHere = $derived(ctl.edit?.source === 'bar');

  // The input shows what the controller holds, also after a click on a cell put an address into it.
  $effect(() => {
    if (!input) return;
    if (input.value !== text) input.value = text;
    const edit = ctl.edit;
    if (edit && edit.source === 'bar' && document.activeElement === input
      && (input.selectionStart !== edit.caret[0] || input.selectionEnd !== edit.caret[1])) {
      input.setSelectionRange(edit.caret[0], edit.caret[1]);
    }
  });

  function caret(): [number, number] {
    return [input?.selectionStart ?? 0, input?.selectionEnd ?? 0];
  }

  function onfocus(): void {
    if (!input) return;
    if (!ctl.edit && !ctl.startEdit({ source: 'bar' })) return;
    ctl.setEditText(ctl.edit?.text ?? input.value, caret(), 'bar');
  }

  function oninput(): void {
    if (!input) return;
    if (!ctl.edit && !ctl.startEdit({ source: 'bar' })) {
      input.value = text;
      return;
    }
    ctl.setEditText(input.value, caret(), 'bar');
  }

  function onselect(): void {
    const edit = ctl.edit;
    if (!edit || edit.source !== 'bar' || !input) return;
    const [start, end] = caret();
    if (start !== edit.caret[0] || end !== edit.caret[1]) ctl.setEditText(edit.text, [start, end], 'bar');
  }

  function onkeydown(event: KeyboardEvent): void {
    if (!ctl.edit) return;
    if (event.key === 'Enter' && !event.isComposing) {
      ctl.commitEdit(event.shiftKey ? 'up' : 'down');
    } else if (event.key === 'Tab') {
      ctl.commitEdit(event.shiftKey ? 'left' : 'right');
    } else if (event.key === 'Escape') {
      ctl.cancelEdit();
    } else if (event.key === 'F4') {
      ctl.cycleAbsolute();
      event.preventDefault();
      return;
    } else {
      return;
    }
    event.preventDefault();
    ctl.focusGrid();
  }

  function goToName(): void {
    const rect = parseRectName(nameDraft ?? '');
    if (rect && ctl.goTo(rect)) {
      nameDraft = null;
      ctl.focusGrid();
    } else if (nameDraft !== null && nameDraft.trim() !== '') {
      ctl.say('Type a cell such as B7, or a range such as A1:C9.');
      nameInput?.select();
    } else {
      nameDraft = null;
      ctl.focusGrid();
    }
  }

  function onNameKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      goToName();
    } else if (event.key === 'Escape') {
      nameDraft = null;
      ctl.focusGrid();
    }
  }
</script>

<div class="bar" data-testid="sheet-formula-bar">
  <input
    bind:this={nameInput}
    class="name"
    value={nameDraft ?? ctl.selectionName}
    aria-label="Go to cell"
    title="Go to cell"
    spellcheck="false"
    autocomplete="off"
    autocapitalize="characters"
    data-testid="sheet-name-box"
    onfocus={() => { if (ctl.edit) ctl.commitEdit(); nameDraft = ctl.selectionName; nameInput?.select(); }}
    oninput={event => { nameDraft = event.currentTarget.value; }}
    onblur={() => { nameDraft = null; }}
    onkeydown={onNameKeydown}
  />
  <span class="fx" class:on={editingHere || text.startsWith('=')} aria-hidden="true">fx</span>
  <!-- A textarea, because a cell's text can have line breaks and an input would drop them. -->
  <textarea
    bind:this={input}
    class="content"
    rows="1"
    wrap="off"
    aria-label="Cell content"
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    readonly={!ctl.canEdit}
    data-testid="sheet-formula-input"
    {onfocus}
    {oninput}
    {onselect}
    onkeyup={onselect}
    onpointerup={onselect}
    {onkeydown}
  ></textarea>
</div>

<style>
  .bar {
    flex: none;
    display: flex;
    align-items: center;
    height: 32px;
    border-bottom: 1px solid rgb(var(--surface-2));
    background: rgb(var(--surface-0));
  }

  @media (prefers-color-scheme: light) {
    .bar {
      background: #fff;
    }
  }

  input,
  textarea {
    height: 100%;
    border: none;
    background: transparent;
    color: rgb(var(--text-1));
    font-size: 0.82rem;
    outline: none;
    min-width: 0;
  }

  .name {
    flex: none;
    width: 84px;
    padding: 0 8px;
    text-align: center;
    border-right: 1px solid rgb(var(--surface-2));
  }

  .name:focus {
    background: rgb(var(--surface-1));
  }

  .fx {
    flex: none;
    padding: 0 8px 0 10px;
    color: rgb(var(--text-3));
    font-size: 0.8rem;
    font-style: italic;
    font-family: Georgia, 'Times New Roman', serif;
    user-select: none;
  }

  .fx.on {
    color: #916dfe;
  }

  .content {
    flex: 1;
    padding: 7px 8px 0 0;
    resize: none;
    overflow: hidden;
    white-space: pre;
    font-family: inherit;
    line-height: 18px;
  }
</style>
