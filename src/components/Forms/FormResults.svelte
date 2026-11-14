<script lang="ts">
  /** A form's responses for its maker: a summary per question, every response, and CSV. */
  import { nip19 } from 'nostr-tools';
  import type * as Y from 'yjs';
  import CommentAuthorName from '../Sheets/CommentAuthorName.svelte';
  import { saveFile } from '../../lib/saveFile';
  import { updateForm, type FormData } from '../../lib/forms/model';
  import type { FormResponses } from '../../lib/forms/formResponses.svelte';
  import { answerText, answeredCount, choiceCounts, responsesCsv } from '../../lib/forms/responses';

  interface Props {
    ydoc: Y.Doc;
    form: FormData;
    results: FormResponses;
    title: string;
  }
  let { ydoc, form, results, title }: Props = $props();

  const SHOWN_ANSWERS = 5;

  let responses = $derived(results.responses);
  let signed = $derived(responses.some((response) => response.from));

  function download(): void {
    const csv = responsesCsv(form.questions, responses, signed, (response) => response.name || (response.from ? nip19.npubEncode(response.from) : ''));
    saveFile(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${title} (responses).csv`);
  }

  const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
</script>

<div class="flex-1 overflow-auto bg-violet-500/5" data-testid="form-results">
  <div class="max-w-3xl mx-auto px-3 py-4 sm:py-6 space-y-3">
    <section class="card p-4 sm:p-5 space-y-3">
      <div class="flex flex-wrap items-center gap-3">
        <h2 class="text-xl font-medium text-text-1 flex-1" data-testid="form-results-count">
          {responses.length} {responses.length === 1 ? 'response' : 'responses'}
        </h2>
        <button class="btn-ghost flex items-center gap-1.5" disabled={responses.length === 0} onclick={download} data-testid="form-download-csv">
          <span class="i-lucide-download text-sm"></span>
          Download CSV
        </button>
      </div>
      <label class="flex items-center justify-between gap-3 cursor-pointer border-t border-t-solid border-surface-2 pt-3">
        <span class="text-sm text-text-1">Taking responses</span>
        <input
          type="checkbox"
          class="w-4 h-4 accent-violet-500"
          checked={form.open}
          onchange={(event) => updateForm(ydoc, { open: event.currentTarget.checked })}
          data-testid="form-taking-responses"
        />
      </label>
      {#if !form.open}
        <p class="text-xs text-text-2">People who open the form are told it no longer takes responses.</p>
      {/if}
      {#if results.heldBack > 0}
        <p class="text-xs text-text-2" data-testid="form-held-back">
          {results.heldBack} {results.heldBack === 1 ? 'response was' : 'responses were'} left out: sent by people outside your network.
        </p>
      {/if}
    </section>

    {#if !results.loading && !results.owner}
      <section class="card p-5 text-sm text-text-2" data-testid="form-results-elsewhere">
        Responses go to the account that made this form.
      </section>
    {:else if responses.length === 0}
      <section class="card p-8 text-center text-sm text-text-3" data-testid="form-results-empty">
        <span class="i-lucide-inbox text-3xl block mx-auto mb-2"></span>
        No responses yet. Use Send to share the form.
      </section>
    {:else}
      {#each form.questions as question (question.id)}
        {@const counts = choiceCounts(question, responses)}
        {@const answered = answeredCount(question, responses)}
        <section class="card p-4 sm:p-5 space-y-3" data-testid="form-summary">
          <div>
            <h3 class="text-base text-text-1 break-words">{question.title || 'Untitled question'}</h3>
            <p class="text-xs text-text-3">{answered} {answered === 1 ? 'response' : 'responses'}</p>
          </div>
          {#if counts}
            {@const top = Math.max(1, ...counts.map((item) => item.count))}
            <ul class="space-y-1.5 list-none p-0 m-0">
              {#each counts as item (item.option)}
                <li class="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3 text-sm">
                  <span class="truncate text-text-1" title={item.option}>{item.option}</span>
                  <span class="h-3 rounded-sm bg-surface-2 overflow-hidden">
                    <span class="block h-full bg-violet-500 rounded-sm" style="width: {(item.count / top) * 100}%"></span>
                  </span>
                  <span class="text-text-2 tabular-nums" data-testid="form-summary-count">{item.count}</span>
                </li>
              {/each}
            </ul>
          {:else}
            {@const texts = responses.map((response) => answerText(response.answers[question.id])).filter((value) => value.trim())}
            <ul class="space-y-1.5 list-none p-0 m-0">
              {#each texts.slice(0, SHOWN_ANSWERS) as value, at (at)}
                <li class="text-sm text-text-1 bg-surface-2/60 rounded px-3 py-1.5 whitespace-pre-wrap break-words">{value}</li>
              {/each}
            </ul>
            {#if texts.length > SHOWN_ANSWERS}
              <p class="text-xs text-text-3">and {texts.length - SHOWN_ANSWERS} more below</p>
            {/if}
          {/if}
        </section>
      {/each}

      <section class="card p-0" aria-labelledby="all-responses">
        <h3 id="all-responses" class="text-base text-text-1 px-4 sm:px-5 pt-4 pb-2">All responses</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-sm border-collapse" data-testid="form-responses-table">
            <thead>
              <tr class="text-left text-text-2">
                <th class="cell font-medium">Time</th>
                {#if signed}<th class="cell font-medium">From</th>{/if}
                {#each form.questions as question (question.id)}
                  <th class="cell font-medium min-w-32">{question.title || 'Untitled question'}</th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each responses as response (response.id)}
                <tr class="border-t border-t-solid border-surface-2" data-testid="form-response-row">
                  <td class="cell whitespace-nowrap text-text-2">{when.format(new Date(response.at * 1000))}</td>
                  {#if signed}
                    <td class="cell whitespace-nowrap max-w-48">{#if response.from}<CommentAuthorName author={{ pubkey: response.from, profile: response.profile, name: response.name }} />{/if}</td>
                  {/if}
                  {#each form.questions as question (question.id)}
                    <td class="cell text-text-1 break-words max-w-64">{answerText(response.answers[question.id])}</td>
                  {/each}
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}
  </div>
</div>

<style>
  .cell {
    padding: 0.5rem 1rem;
    vertical-align: top;
  }
</style>
