<script lang="ts">
  /**
   * Links in the document being written. With the cursor in a link, a bubble
   * below it shows where the link goes, to open in a new tab, and buttons to
   * change or remove it. `editing` opens the field where an address is typed:
   * for the words selected, or, with none, to add the address itself.
   */
  import { untrack } from 'svelte';
  import type { Editor } from '@tiptap/core';
  import { TextSelection } from '@tiptap/pm/state';

  interface Props {
    editor: Editor;
    /** The element the menu is placed in; it scrolls with the text. */
    page: HTMLElement;
    editing: boolean;
  }

  let { editor, page, editing = $bindable() }: Props = $props();

  let field: HTMLInputElement | undefined = $state();
  let address = $state('');

  // The editor is not reactive; count its changes so the menu follows the cursor.
  let changes = $state(0);
  $effect(() => {
    const current = editor;
    let listening = true;
    const bump = () => {
      queueMicrotask(() => {
        if (listening) changes += 1;
      });
    };
    current.on('transaction', bump);
    window.addEventListener('resize', bump);
    return () => {
      listening = false;
      current.off('transaction', bump);
      window.removeEventListener('resize', bump);
    };
  });

  let href = $derived.by(() => {
    void changes;
    if (editor.isDestroyed || !editor.isActive('link')) return '';
    return String(editor.getAttributes('link').href ?? '');
  });

  /** Below the cursor, kept inside the page. */
  let place = $derived.by(() => {
    void changes;
    void editing;
    if (editor.isDestroyed || (!href && !editing)) return null;
    const at = editor.view.coordsAtPos(editor.state.selection.from);
    const box = page.getBoundingClientRect();
    const left = Math.max(8, Math.min(at.left - box.left, box.width - 328));
    return { left, top: at.bottom - box.top + 6 };
  });

  $effect(() => {
    if (!editing) return;
    address = untrack(() => href);
    queueMicrotask(() => {
      field?.focus();
      field?.select();
    });
  });

  function withScheme(text: string): string {
    if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
    return /^[^\s/@]+@[^\s/@]+$/.test(text) ? `mailto:${text}` : `https://${text}`;
  }

  function apply(event: SubmitEvent): void {
    event.preventDefault();
    const text = address.trim();
    editing = false;
    // At once, so that what is typed next goes into the text.
    editor.view.focus();
    const chain = editor.chain().focus();
    if (!text) {
      chain.extendMarkRange('link').unsetLink().run();
    } else if (editor.state.selection.empty && !editor.isActive('link')) {
      // Nothing selected: the address itself becomes the link, and typing goes on after it.
      const link = withScheme(text);
      chain.insertContent({ type: 'text', text, marks: [{ type: 'link', attrs: { href: link } }] }).unsetMark('link').run();
    } else {
      // The cursor goes after the link, as in other editors, so what comes next
      // follows it rather than replacing the linked words.
      chain
        .extendMarkRange('link')
        .setLink({ href: withScheme(text) })
        .command(({ tr }) => {
          tr.setSelection(TextSelection.create(tr.doc, tr.selection.to));
          return true;
        })
        .unsetMark('link')
        .run();
    }
  }

  function cancel(): void {
    editing = false;
    editor.view.focus();
  }

  function onFieldKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      cancel();
    }
  }

  function remove(): void {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
  }

  /** Pressing a button must not take the cursor out of the text. */
  function keepEditorFocus(event: MouseEvent): void {
    if (!(event.target as HTMLElement).closest('input, a')) event.preventDefault();
  }
</script>

{#if place}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="link-menu"
    style:left="{place.left}px"
    style:top="{place.top}px"
    onmousedown={keepEditorFocus}
    data-testid={editing ? 'document-link-editor' : 'document-link-bubble'}
  >
    {#if editing}
      <form class="flex items-center gap-1" onsubmit={apply}>
        <input
          bind:this={field}
          bind:value={address}
          onkeydown={onFieldKeyDown}
          onblur={() => { editing = false; }}
          type="text"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          placeholder="Paste or type a link"
          aria-label="Link address"
          class="link-field"
          data-testid="document-link-input"
        />
        <button type="submit" class="link-tool" title="Apply" aria-label="Apply">
          <span class="i-lucide-check"></span>
        </button>
      </form>
    {:else}
      <span class="i-lucide-globe shrink-0 text-text-3"></span>
      <a {href} target="_blank" rel="noopener noreferrer" class="link-address" title={href}>{href}</a>
      <button type="button" class="link-tool" onclick={() => { editing = true; }} title="Change link" aria-label="Change link">
        <span class="i-lucide-pencil"></span>
      </button>
      <button type="button" class="link-tool" onclick={remove} title="Remove link" aria-label="Remove link">
        <span class="i-lucide-unlink"></span>
      </button>
    {/if}
  </div>
{/if}

<style>
  .link-menu {
    position: absolute;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 6px;
    max-width: min(320px, calc(100% - 16px));
    padding: 4px 4px 4px 10px;
    border-radius: 10px;
    background: rgb(var(--surface-1));
    box-shadow: 0 4px 16px rgb(0 0 0 / 0.18), 0 0 0 1px rgb(var(--surface-3) / 0.6);
    font-size: 0.85rem;
  }

  .link-address {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: #916dfe;
    text-decoration: underline;
  }

  .link-field {
    width: 240px;
    max-width: 60vw;
    height: 32px;
    padding: 0 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: rgb(var(--surface-0));
    color: rgb(var(--text-1));
    font-size: 16px;
    outline: none;
  }

  .link-field:focus {
    border-color: #916dfe;
  }

  .link-tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: rgb(var(--text-1));
    cursor: pointer;
  }

  .link-tool:hover {
    background: rgb(var(--surface-2));
  }
</style>
