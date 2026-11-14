<script lang="ts">
  /**
   * Send: who may answer, and the form's link. Opening it gives the form a
   * link of its own if it has none ("Anyone with the link can view"), so the
   * form can be sent at once; the link opens the questions, never the answers.
   */
  import { onMount } from 'svelte';
  import type * as Y from 'yjs';
  import CopyText from '@iris/svelte-ui/CopyText.svelte';
  import Modal from '../ui/Modal.svelte';
  import { nostrStore } from '../../nostr';
  import { routeStore } from '../../stores';
  import { acceptedShares } from '../../drive/shareLibrary';
  import { activeNostrIdentityRootScope } from '../../drive/profileRoute';
  import { canSetLinkAccess, linkShareOf, linkShares, linkShareUrl, linkSubjectAt, linkTargetAt } from '../../drive/linkShares';
  import { REACH_CHOICES, updateForm, type FormData, type Who } from '../../lib/forms/model';

  interface Props {
    ydoc: Y.Doc;
    form: FormData;
    title: string;
    onclose: () => void;
  }
  let { ydoc, form, title, onclose }: Props = $props();

  let profileId = $derived(activeNostrIdentityRootScope($nostrStore));
  let target = $derived(linkTargetAt({
    scope: $routeStore.npub,
    treeName: $routeStore.treeName,
    path: $routeStore.path,
    profileId,
    records: $acceptedShares,
  }));
  let subject = $derived(target ? linkSubjectAt(target, profileId, $acceptedShares) : null);
  let own = $derived(subject ? linkShareOf(subject.path, profileId, $linkShares, subject.share) : null);
  let link = $derived(own && own.access !== 'off' && (own.access === 'public' || own.key) ? linkShareUrl(own) : null);
  let canLink = $derived(!!target && canSetLinkAccess(target, profileId, $nostrStore.pubkey, $acceptedShares));
  let busy = $state(false);
  let error = $state('');

  async function makeLink(): Promise<void> {
    if (!subject || busy || link) return;
    busy = true;
    error = '';
    try {
      const { setLinkAccess } = await import('../../drive/linkShareSync');
      await setLinkAccess(subject, 'link');
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not make a link';
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    if (canLink && !link) void makeLink();
  });

  function setWho(who: Who): void {
    updateForm(ydoc, { who });
  }
</script>

<Modal open onClose={onclose} label="Send form" panelClass="bg-surface-1 rounded-lg shadow-lg p-5 sm:p-6 w-full max-w-lg mx-4 space-y-5">
  <div class="flex items-center gap-2">
    <h2 class="text-lg font-semibold text-text-1 flex-1 truncate">Send “{title}”</h2>
    <button class="btn-circle bg-transparent text-text-2 hover:bg-surface-2 hover:text-text-1" title="Close" aria-label="Close" onclick={onclose}>
      <span class="i-lucide-x text-base"></span>
    </button>
  </div>

  <fieldset class="space-y-2 border-0 p-0 m-0 min-w-0">
    <legend class="text-sm font-medium text-text-1 mb-2 p-0">Who can respond</legend>
    <label class="flex items-start gap-3 cursor-pointer">
      <input type="radio" name="who" class="mt-1 w-4 h-4 accent-violet-500" checked={form.who === 'anyone'} onchange={() => setWho('anyone')} data-testid="form-who-anyone" />
      <span>
        <span class="text-sm text-text-1 block">Anyone with the link</span>
        <span class="text-xs text-text-3">Answers are anonymous.</span>
      </span>
    </label>
    <label class="flex items-start gap-3 cursor-pointer">
      <input type="radio" name="who" class="mt-1 w-4 h-4 accent-violet-500" checked={form.who === 'network'} onchange={() => setWho('network')} data-testid="form-who-network" />
      <span>
        <span class="text-sm text-text-1 block">People in your network</span>
        <span class="text-xs text-text-3">People sign in to answer, and you see who answered. Answers from anyone else are left out.</span>
      </span>
    </label>
    {#if form.who === 'network'}
      <select
        class="pick ml-7"
        aria-label="How far in your network"
        value={String(form.reach)}
        onchange={(event) => updateForm(ydoc, { reach: Number(event.currentTarget.value) })}
        data-testid="form-reach"
      >
        {#each REACH_CHOICES as choice (choice.reach)}
          <option value={String(choice.reach)}>{choice.label}</option>
        {/each}
      </select>
    {/if}
  </fieldset>

  <div class="space-y-2 border-t border-t-solid border-surface-2 pt-4">
    <h3 class="text-sm font-medium text-text-1">Link</h3>
    {#if link}
      <div class="bg-surface-2 p-3 rounded">
        <CopyText text={link} truncate={44} class="text-sm" testId="form-link" />
      </div>
      <p class="text-xs text-text-3">The link opens the questions. Only you see the answers.</p>
    {:else if busy}
      <p class="text-sm text-text-2 flex items-center gap-2"><span class="i-lucide-loader-2 animate-spin"></span>Making a link…</p>
    {:else if canLink}
      <button class="btn-ghost" onclick={() => void makeLink()} data-testid="form-make-link">Make a link</button>
    {:else}
      <p class="text-sm text-text-2">Ask whoever shared this folder with you to send the form's link.</p>
    {/if}
    {#if error}
      <p class="text-xs text-danger" role="alert">{error}</p>
    {/if}
  </div>

  {#if !form.open}
    <p class="text-xs text-warning">This form isn't taking responses. Turn it back on under Responses.</p>
  {/if}
</Modal>

<style>
  .pick {
    height: 34px;
    padding: 0 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: rgb(var(--surface-0));
    color: rgb(var(--text-1));
    font-size: 0.85rem;
    max-width: calc(100% - 1.75rem);
  }
</style>
