<script lang="ts">
  /** One question of a form being made: its wording, kind, choices and whether it must be answered. */
  import type * as Y from 'yjs';
  import {
    QUESTION_TYPES,
    addOption,
    duplicateQuestion,
    hasOptions,
    moveQuestion,
    removeOption,
    removeQuestion,
    setOption,
    updateQuestion,
    type Question,
    type QuestionType,
  } from '../../lib/forms/model';

  interface Props {
    ydoc: Y.Doc;
    question: Question;
    index: number;
    count: number;
    /** Called with the id of a question this one made, to focus it. */
    onadded: (id: string) => void;
  }
  let { ydoc, question, index, count, onadded }: Props = $props();

  let card: HTMLElement | undefined = $state();
  let optionFields: HTMLInputElement[] = $state([]);

  const PLACEHOLDER: Partial<Record<QuestionType, string>> = {
    short: 'Short answer',
    paragraph: 'Long answer',
    date: 'Day, month, year',
  };

  function marker(type: QuestionType): string {
    if (type === 'checkboxes') return 'i-lucide-square';
    if (type === 'choice') return 'i-lucide-circle';
    return '';
  }

  function addChoice(): void {
    const at = addOption(ydoc, question.id);
    queueMicrotask(() => {
      optionFields[at]?.focus();
      optionFields[at]?.select();
    });
  }

  function onOptionKeydown(event: KeyboardEvent, at: number): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (at === question.options.length - 1) addChoice();
      else optionFields[at + 1]?.focus();
    } else if (event.key === 'Backspace' && (event.currentTarget as HTMLInputElement).value === '' && question.options.length > 1) {
      event.preventDefault();
      removeOption(ydoc, question.id, at);
      queueMicrotask(() => optionFields[Math.max(0, at - 1)]?.focus());
    }
  }

  function remove(): void {
    removeQuestion(ydoc, question.id);
  }

  function duplicate(): void {
    const id = duplicateQuestion(ydoc, question.id);
    if (id) onadded(id);
  }

  /** Focuses the question's wording, as when it was just added. */
  export function focus(): void {
    card?.querySelector<HTMLInputElement>('[data-testid="question-title"]')?.focus();
  }
</script>

<section
  bind:this={card}
  class="card p-4 sm:p-5 space-y-3 b-l-4 b-l-solid b-l-transparent focus-within:b-l-violet-500"
  data-testid="question-card"
  data-question={question.id}
  aria-label="Question {index + 1}"
>
  <div class="flex flex-wrap items-center gap-2">
    <input
      class="line flex-1 min-w-48 text-base"
      placeholder="Question"
      aria-label="Question"
      value={question.title}
      oninput={(event) => updateQuestion(ydoc, question.id, { title: event.currentTarget.value })}
      data-testid="question-title"
    />
    <select
      class="pick"
      value={question.type}
      aria-label="Kind of question"
      onchange={(event) => updateQuestion(ydoc, question.id, { type: event.currentTarget.value as QuestionType })}
      data-testid="question-type"
    >
      {#each QUESTION_TYPES as item (item.type)}
        <option value={item.type}>{item.label}</option>
      {/each}
    </select>
  </div>
  <input
    class="line w-full text-sm text-text-2"
    placeholder="Description (optional)"
    aria-label="Description"
    value={question.help}
    oninput={(event) => updateQuestion(ydoc, question.id, { help: event.currentTarget.value })}
  />

  {#if hasOptions(question.type)}
    <ol class="space-y-1.5" aria-label="Choices">
      {#each question.options as option, at (at)}
        <li class="flex items-center gap-2">
          {#if marker(question.type)}
            <span class="{marker(question.type)} text-text-3 shrink-0"></span>
          {:else}
            <span class="w-4 text-right text-sm text-text-3 shrink-0">{at + 1}.</span>
          {/if}
          <input
            bind:this={optionFields[at]}
            class="line flex-1 text-sm"
            aria-label="Choice {at + 1}"
            value={option}
            oninput={(event) => setOption(ydoc, question.id, at, event.currentTarget.value)}
            onkeydown={(event) => onOptionKeydown(event, at)}
            data-testid="question-option"
          />
          {#if question.options.length > 1}
            <button
              class="btn-circle bg-transparent text-text-2 hover:bg-surface-2 hover:text-text-1 w-8! min-h-8!"
              title="Remove choice"
              aria-label="Remove choice {at + 1}"
              onclick={() => removeOption(ydoc, question.id, at)}
            >
              <span class="i-lucide-x text-sm"></span>
            </button>
          {/if}
        </li>
      {/each}
    </ol>
    <button class="text-sm text-violet-500 hover:underline" onclick={addChoice} data-testid="question-add-option">
      Add choice
    </button>
  {:else}
    <div class="text-sm text-text-3 border-b border-b-dashed border-surface-3 py-1 w-2/3" aria-hidden="true">
      {PLACEHOLDER[question.type]}
    </div>
  {/if}

  <div class="flex flex-wrap items-center justify-end gap-1 border-t border-t-solid border-surface-2 pt-2">
    <button class="btn-circle bg-transparent text-text-2 hover:bg-surface-2 hover:text-text-1" title="Move up" aria-label="Move up" disabled={index === 0} onclick={() => moveQuestion(ydoc, question.id, -1)}>
      <span class="i-lucide-arrow-up text-base"></span>
    </button>
    <button class="btn-circle bg-transparent text-text-2 hover:bg-surface-2 hover:text-text-1" title="Move down" aria-label="Move down" disabled={index === count - 1} onclick={() => moveQuestion(ydoc, question.id, 1)}>
      <span class="i-lucide-arrow-down text-base"></span>
    </button>
    <button class="btn-circle bg-transparent text-text-2 hover:bg-surface-2 hover:text-text-1" title="Duplicate" aria-label="Duplicate" onclick={duplicate} data-testid="question-duplicate">
      <span class="i-lucide-copy text-base"></span>
    </button>
    <button class="btn-circle bg-transparent text-text-2 hover:bg-surface-2 hover:text-text-1" title="Delete" aria-label="Delete question" onclick={remove} data-testid="question-delete">
      <span class="i-lucide-trash-2 text-base"></span>
    </button>
    <span class="w-px h-6 bg-surface-3 mx-1"></span>
    <label class="flex items-center gap-2 text-sm text-text-2 cursor-pointer pl-1">
      Required
      <input
        type="checkbox"
        class="w-4 h-4 accent-violet-500"
        checked={question.required}
        onchange={(event) => updateQuestion(ydoc, question.id, { required: event.currentTarget.checked })}
        data-testid="question-required"
      />
    </label>
  </div>
</section>

<style>
  .line {
    background: transparent;
    border: 0;
    border-bottom: 1px solid rgb(var(--surface-3));
    padding: 0.375rem 0;
    color: rgb(var(--text-1));
    font: inherit;
    outline: none;
  }
  .line:focus {
    border-bottom: 2px solid rgb(139 92 246);
    padding-bottom: calc(0.375rem - 1px);
  }
  .pick {
    height: 36px;
    padding: 0 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: rgb(var(--surface-0));
    color: rgb(var(--text-1));
    font-size: 0.875rem;
    cursor: pointer;
  }
</style>
