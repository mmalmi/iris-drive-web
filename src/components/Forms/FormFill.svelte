<script lang="ts">
  /**
   * A form as the people answering it see it. Answers go straight to the
   * form's owner, encrypted (see lib/forms/inbox.ts): from a key made for
   * this one answer, or, for a form open only to the owner's network, as the
   * person signed in, so the owner can tell who answered.
   */
  import { nostrStore } from '../../nostr';
  import { encrypt } from '../../nostr/auth';
  import { PENDING_OPEN_KEY } from '../../drive/sharePeople';
  import { Name } from '../User';
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import { accountsStore } from '../../accounts';
  import { activeNostrIdentityRootScope } from '../../drive/profileRoute';
  import { createIdentityProfileNameStore } from '../../stores/identityProfile';
  import { anonymousSender, sendAnswers, watchDelivered, type AnswerAuthor, type Sender } from '../../lib/forms/inbox';
  import { appRelay } from '../../lib/forms/formResponses.svelte';
  import { cleanAnswers, missingAnswers, type Answers, type FormData, type Question } from '../../lib/forms/model';

  interface Props {
    form: FormData;
    title: string;
  }
  let { form, title }: Props = $props();

  let answers = $state<Answers>({});
  let checkedMissing = $state(false);
  let sending = $state(false);
  let sent = $state(false);
  /** True once the relays hold the answers sent last; until then, leaving the page could lose them. */
  let delivered = $state(false);
  let stopWatching: (() => void) | null = null;
  let error = $state('');

  let missing = $derived(new Set(missingAnswers(form, answers)));
  let anyRequired = $derived(form.questions.some((question) => question.required));
  let me = $derived($nostrStore.isLoggedIn ? $nostrStore.pubkey : null);
  let needsSignIn = $derived(form.who === 'network' && !me);

  function sender(): Sender | null {
    if (form.who === 'anyone') return anonymousSender();
    const pubkey = nostrStore.getState().pubkey;
    if (!pubkey) return null;
    return { pubkey, encrypt: (plaintext, recipient) => encrypt(recipient, plaintext) };
  }

  /** The Drive profile and name of the person signed in, so the owner can tell who answered. */
  function author(): AnswerAuthor | undefined {
    if (form.who !== 'network') return undefined;
    const state = nostrStore.getState();
    if (!state.pubkey) return undefined;
    const profile = activeNostrIdentityRootScope(state) ?? undefined;
    const chosen = accountsStore.getState().accounts.find((account) => account.pubkey === state.pubkey)?.name?.trim();
    const named = get(createIdentityProfileNameStore(profile, state.pubkey));
    const name = chosen || (named.name !== named.fallbackName ? named.name : '');
    return { ...(profile ? { profile } : {}), ...(name ? { name } : {}) };
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (sending) return;
    if (missing.size > 0) {
      checkedMissing = true;
      const first = form.questions.find((question) => missing.has(question.id));
      if (first) document.querySelector<HTMLElement>(`[data-answer="${first.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return;
    }
    const inbox = form.inbox;
    const from = sender();
    if (!inbox || !from) return;
    sending = true;
    error = '';
    try {
      const relay = appRelay();
      const result = await sendAnswers(inbox, cleanAnswers(form, answers), from, relay, author());
      sent = true;
      delivered = false;
      stopWatching?.();
      stopWatching = watchDelivered(result.events, relay, () => { delivered = true; });
    } catch (cause) {
      console.warn('[Forms] Could not send answers:', cause);
      error = 'Your answers could not be sent. Try again.';
    } finally {
      sending = false;
    }
  }

  function onbeforeunload(event: BeforeUnloadEvent): void {
    if (sent && !delivered) event.preventDefault();
  }

  onDestroy(() => stopWatching?.());

  function again(): void {
    answers = {};
    checkedMissing = false;
    sent = false;
  }

  function signIn(): void {
    try {
      sessionStorage.setItem(PENDING_OPEN_KEY, window.location.hash.replace(/^#/, ''));
    } catch {
      // The form can be opened again after signing in.
    }
    window.location.hash = '#/users';
  }

  function toggle(question: Question, option: string, on: boolean): void {
    const now = Array.isArray(answers[question.id]) ? answers[question.id] as string[] : [];
    const next = on ? [...now.filter((item) => item !== option), option] : now.filter((item) => item !== option);
    answers[question.id] = question.options.filter((item) => next.includes(item));
  }

  function text(question: Question): string {
    const value = answers[question.id];
    return typeof value === 'string' ? value : '';
  }
</script>

<svelte:window {onbeforeunload} />

<div class="flex-1 overflow-auto bg-violet-500/5" data-testid="form-fill">
  <div class="max-w-2xl mx-auto px-3 py-4 sm:py-6 space-y-3">
    <section class="card p-4 sm:p-6 b-t-8 b-t-solid b-t-violet-500 space-y-2">
      <h1 class="text-2xl font-semibold text-text-1 break-words" data-testid="form-fill-title">{title}</h1>
      {#if form.description}
        <p class="text-sm text-text-1 whitespace-pre-wrap break-words">{form.description}</p>
      {/if}
      {#if form.who === 'network' && !sent}
        <p class="text-xs text-text-2 flex items-center gap-1.5 flex-wrap" data-testid="form-fill-network">
          <span class="i-lucide-users text-sm"></span>
          {#if me}
            Answering as <Name pubkey={me} class="font-medium" />. Only answers from people in the owner's network are kept.
          {:else}
            Only people in the owner's network can answer. Sign in to answer as yourself.
          {/if}
        </p>
      {/if}
      {#if anyRequired && !sent && form.open}
        <p class="text-xs text-danger">* Required</p>
      {/if}
    </section>

    {#if !form.inbox}
      <section class="card p-5 text-sm text-text-2" data-testid="form-not-ready">This form isn't ready for answers yet.</section>
    {:else if !form.open}
      <section class="card p-5 text-sm text-text-2" data-testid="form-closed">This form is no longer taking responses.</section>
    {:else if sent}
      <section class="card p-5 space-y-3" data-testid="form-sent">
        <p class="text-text-1">Your response has been sent.</p>
        {#if delivered}
          <p class="text-xs text-text-3 flex items-center gap-1.5" data-testid="form-delivered"><span class="i-lucide-check"></span>Delivered</p>
        {:else}
          <p class="text-xs text-text-3 flex items-center gap-1.5" data-testid="form-delivering">
            <span class="i-lucide-loader-2 animate-spin"></span>Delivering. Keep this page open for a moment.
          </p>
        {/if}
        <button class="text-sm text-violet-500 hover:underline" onclick={again} data-testid="form-send-another">Send another response</button>
      </section>
    {:else}
      <form class="space-y-3" onsubmit={submit} novalidate>
        {#each form.questions as question (question.id)}
          {@const flagged = checkedMissing && missing.has(question.id)}
          <fieldset
            class="card p-4 sm:p-6 space-y-3 m-0 min-w-0 b-1 b-solid {flagged ? 'b-danger' : 'b-transparent'}"
            data-answer={question.id}
            data-testid="form-question"
          >
            <legend class="sr-only">{question.title || 'Untitled question'}</legend>
            <div>
              <p class="text-base text-text-1 break-words" aria-hidden="true">
                {question.title || 'Untitled question'}{#if question.required}<span class="text-danger"> *</span>{/if}
              </p>
              {#if question.help}<p class="text-xs text-text-2 mt-0.5 break-words">{question.help}</p>{/if}
            </div>

            {#if question.type === 'short'}
              <input
                class="line w-full sm:w-2/3"
                placeholder="Your answer"
                aria-label={question.title || 'Your answer'}
                value={text(question)}
                oninput={(event) => { answers[question.id] = event.currentTarget.value; }}
              />
            {:else if question.type === 'paragraph'}
              <textarea
                class="line w-full resize-y"
                rows="3"
                placeholder="Your answer"
                aria-label={question.title || 'Your answer'}
                value={text(question)}
                oninput={(event) => { answers[question.id] = event.currentTarget.value; }}
              ></textarea>
            {:else if question.type === 'date'}
              <input
                type="date"
                class="line"
                aria-label={question.title || 'Date'}
                value={text(question)}
                oninput={(event) => { answers[question.id] = event.currentTarget.value; }}
              />
            {:else if question.type === 'dropdown'}
              <select
                class="pick"
                aria-label={question.title || 'Choose'}
                value={text(question)}
                onchange={(event) => { answers[question.id] = event.currentTarget.value; }}
              >
                <option value="">Choose</option>
                {#each question.options as option, at (at)}
                  <option value={option}>{option}</option>
                {/each}
              </select>
            {:else if question.type === 'choice'}
              <div class="space-y-1">
                {#each question.options as option, at (at)}
                  <label class="flex items-center gap-3 py-1.5 cursor-pointer text-sm text-text-1">
                    <input
                      type="radio"
                      class="w-4 h-4 accent-violet-500"
                      name={question.id}
                      value={option}
                      checked={answers[question.id] === option}
                      onchange={() => { answers[question.id] = option; }}
                    />
                    <span class="break-words">{option}</span>
                  </label>
                {/each}
              </div>
              {#if text(question) && !question.required}
                <button type="button" class="text-xs text-text-2 hover:underline" onclick={() => { answers[question.id] = ''; }}>Clear selection</button>
              {/if}
            {:else if question.type === 'checkboxes'}
              <div class="space-y-1">
                {#each question.options as option, at (at)}
                  <label class="flex items-center gap-3 py-1.5 cursor-pointer text-sm text-text-1">
                    <input
                      type="checkbox"
                      class="w-4 h-4 accent-violet-500"
                      checked={Array.isArray(answers[question.id]) && (answers[question.id] as string[]).includes(option)}
                      onchange={(event) => toggle(question, option, event.currentTarget.checked)}
                    />
                    <span class="break-words">{option}</span>
                  </label>
                {/each}
              </div>
            {/if}

            {#if flagged}
              <p class="text-xs text-danger flex items-center gap-1" role="alert">
                <span class="i-lucide-circle-alert"></span>This question is required
              </p>
            {/if}
          </fieldset>
        {/each}

        {#if error}
          <p class="text-sm text-danger px-1" role="alert" data-testid="form-send-error">{error}</p>
        {/if}
        <div class="flex items-center justify-between gap-3 px-1">
          {#if needsSignIn}
            <button type="button" class="btn bg-violet-500 text-white hover:bg-violet-600" onclick={signIn} data-testid="form-sign-in">Sign in to answer</button>
          {:else}
            <button type="submit" class="btn bg-violet-500 text-white hover:bg-violet-600 px-6" disabled={sending} data-testid="form-submit">
              {sending ? 'Sending…' : 'Submit'}
            </button>
          {/if}
          <button type="button" class="text-sm text-violet-500 hover:underline" onclick={again}>Clear form</button>
        </div>
      </form>
    {/if}
  </div>
</div>

<style>
  .line {
    background: transparent;
    border: 0;
    border-bottom: 1px solid rgb(var(--surface-3));
    padding: 0.375rem 0;
    color: rgb(var(--text-1));
    font: inherit;
    font-size: 0.875rem;
    outline: none;
  }
  .line:focus {
    border-bottom: 2px solid rgb(139 92 246);
    padding-bottom: calc(0.375rem - 1px);
  }
  .pick {
    height: 36px;
    min-width: 12rem;
    padding: 0 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: rgb(var(--surface-0));
    color: rgb(var(--text-1));
    font-size: 0.875rem;
  }
</style>
