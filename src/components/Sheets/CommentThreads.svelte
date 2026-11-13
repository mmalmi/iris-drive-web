<script lang="ts">
  /**
   * The comment threads of one cell, with a box to answer or start one. Used
   * in the card beside the cell and in the list of all comments.
   */
  import CommentAuthorName from './CommentAuthorName.svelte';
  import type { SheetController } from '../../lib/sheets/controller.svelte';
  import { addComment, deleteComment, isOwn, reopenThread, resolveThread, type CommentThread } from '../../lib/sheets/comments';

  interface Props {
    ctl: SheetController;
    threads: CommentThread[];
    /** "rowId:colId" of the cell, for a new thread. */
    cell: string;
    /** Offer a box for a new thread. */
    compose?: boolean;
    /** Show resolved threads too. */
    showResolved?: boolean;
    autofocus?: boolean;
    ondone?: () => void;
  }
  let { ctl, threads, cell, compose = false, showResolved = false, autofocus = false, ondone }: Props = $props();

  let drafts = $state<Record<string, string>>({});
  let me = $derived(ctl.canEdit ? ctl.authorOf() : null);
  let shown = $derived(threads.filter(thread => showResolved || !thread.resolved));

  function when(time: number): string {
    const date = new Date(time);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay
      ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
  }

  function send(thread: string | null): void {
    const key = thread ?? 'new';
    const author = ctl.authorOf();
    if (!author || !ctl.canEdit) return;
    const id = addComment(ctl.sheet, cell, author, drafts[key] ?? '', thread ?? undefined);
    if (id) {
      drafts[key] = '';
      if (!thread) {
        ondone?.();
        // The keyboard goes back to the cells, where Escape closes the card.
        ctl.focusGrid();
      }
    }
  }

  function onkeydown(event: KeyboardEvent, thread: string | null): void {
    event.stopPropagation();
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send(thread);
    } else if (event.key === 'Escape') {
      ondone?.();
    }
  }

  function focusOnMount(element: HTMLElement): void {
    if (autofocus) requestAnimationFrame(() => element.focus({ preventScroll: true }));
  }
</script>

{#each shown as thread (thread.id)}
  <div class="thread" class:resolved={thread.resolved} data-testid="comment-thread">
    {#each thread.messages as message (message.id)}
      <div class="message" data-testid="comment-message">
        <div class="who">
          <CommentAuthorName author={message.author} />
          <span class="time" title={new Date(message.time).toLocaleString()}>{when(message.time)}</span>
          {#if ctl.canEdit && isOwn(message.author, me)}
            <button class="tiny" onclick={() => deleteComment(ctl.sheet, message.id)} title={message.id === thread.id ? 'Delete thread' : 'Delete'} aria-label="Delete comment" data-testid="comment-delete"><span class="i-lucide-trash-2"></span></button>
          {/if}
        </div>
        <p class="text">{message.text}</p>
      </div>
    {/each}
    {#if thread.resolved}
      <div class="status">
        <span class="i-lucide-check-circle-2"></span> Resolved
        {#if ctl.canEdit}<button class="link" onclick={() => reopenThread(ctl.sheet, thread.id)} data-testid="comment-reopen">Reopen</button>{/if}
      </div>
    {:else if ctl.canEdit}
      <div class="reply">
        <textarea
          rows="1"
          placeholder="Reply"
          bind:value={drafts[thread.id]}
          onkeydown={(event) => onkeydown(event, thread.id)}
          data-testid="comment-reply"
        ></textarea>
        <div class="actions">
          <button class="btn-ghost small" onclick={() => resolveThread(ctl.sheet, thread.id, ctl.authorOf() ?? { pubkey: '' })} data-testid="comment-resolve"><span class="i-lucide-check"></span> Resolve</button>
          {#if drafts[thread.id]?.trim()}
            <button class="btn-ghost small accent" onclick={() => send(thread.id)} data-testid="comment-send-reply">Reply</button>
          {/if}
        </div>
      </div>
    {/if}
  </div>
{/each}

{#if compose && ctl.canEdit}
  <div class="thread new">
    <textarea
      rows="2"
      placeholder="Comment"
      bind:value={drafts.new}
      onkeydown={(event) => onkeydown(event, null)}
      use:focusOnMount
      data-testid="comment-new"
    ></textarea>
    <div class="actions">
      <button class="btn-ghost small" onclick={() => ondone?.()}>Cancel</button>
      <button class="btn-ghost small accent" disabled={!drafts.new?.trim()} onclick={() => send(null)} data-testid="comment-send">Comment</button>
    </div>
  </div>
{/if}

<style>
  .thread {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 8px;
    background: rgb(var(--surface-0));
  }

  .thread.resolved {
    opacity: 0.75;
  }

  .message {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .who {
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    font-size: 0.8rem;
  }

  .who :global(.name) {
    font-weight: 600;
    color: rgb(var(--text-1));
    min-width: 0;
  }

  .time {
    flex: none;
    color: rgb(var(--text-3));
    font-size: 0.72rem;
  }

  .tiny {
    margin-left: auto;
    flex: none;
    border: none;
    background: transparent;
    color: rgb(var(--text-3));
    cursor: pointer;
    padding: 2px;
  }

  .text {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: 0.85rem;
    color: rgb(var(--text-1));
  }

  .status {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.78rem;
    color: rgb(var(--text-2));
  }

  .link {
    border: none;
    background: transparent;
    color: #916dfe;
    cursor: pointer;
    padding: 0;
    font-size: 0.78rem;
  }

  textarea {
    width: 100%;
    min-height: 32px;
    padding: 6px 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: rgb(var(--surface-1));
    color: rgb(var(--text-1));
    font: inherit;
    font-size: 0.85rem;
    resize: vertical;
    box-sizing: border-box;
  }

  textarea:focus {
    outline: 2px solid #916dfe;
    outline-offset: -1px;
  }

  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 4px;
    margin-top: 4px;
  }

  .small {
    min-height: 28px;
    padding: 0 10px;
    font-size: 0.8rem;
  }

  .accent {
    color: #916dfe;
  }
</style>
