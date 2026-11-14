<script lang="ts">
  /** The questions of a form being made, edited in place by everyone who has it open. */
  import { tick } from 'svelte';
  import type * as Y from 'yjs';
  import { addQuestion, updateForm, type FormData } from '../../lib/forms/model';
  import QuestionCard from './QuestionCard.svelte';

  interface Props {
    ydoc: Y.Doc;
    form: FormData;
    title: string;
  }
  let { ydoc, form, title }: Props = $props();

  const cards: Record<string, QuestionCard> = $state({});
  /** The question last worked on; a new one goes after it. */
  let current = $state<string | null>(null);

  async function focusQuestion(id: string): Promise<void> {
    current = id;
    await tick();
    cards[id]?.focus();
    document.querySelector(`[data-question="${id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function add(): void {
    const after = current && form.questions.some((question) => question.id === current) ? current : undefined;
    void focusQuestion(addQuestion(ydoc, 'choice', after));
  }

  function onfocusin(event: FocusEvent): void {
    const id = (event.target as HTMLElement).closest<HTMLElement>('[data-question]')?.dataset.question;
    if (id) current = id;
  }
</script>

<div class="flex-1 overflow-auto bg-violet-500/5" data-testid="form-editor">
  <div class="max-w-2xl mx-auto px-3 py-4 sm:py-6 space-y-3" {onfocusin}>
    <section class="card p-4 sm:p-5 b-t-8 b-t-solid b-t-violet-500 space-y-2">
      <h2 class="text-2xl font-semibold text-text-1 break-words" data-testid="form-title">{title}</h2>
      <textarea
        class="description"
        rows="2"
        placeholder="Form description"
        aria-label="Form description"
        value={form.description}
        oninput={(event) => updateForm(ydoc, { description: event.currentTarget.value })}
        data-testid="form-description"
      ></textarea>
    </section>

    {#each form.questions as question, index (question.id)}
      <QuestionCard
        bind:this={cards[question.id]}
        {ydoc}
        {question}
        {index}
        count={form.questions.length}
        onadded={(id) => void focusQuestion(id)}
      />
    {/each}

    <button class="btn-ghost w-full flex-center gap-2 py-3" onclick={add} data-testid="form-add-question">
      <span class="i-lucide-plus-circle text-base text-violet-500"></span>
      Add question
    </button>
  </div>
</div>

<style>
  .description {
    display: block;
    width: 100%;
    background: transparent;
    border: 0;
    border-bottom: 1px solid rgb(var(--surface-3));
    padding: 0.375rem 0;
    color: rgb(var(--text-1));
    font: inherit;
    font-size: 0.875rem;
    outline: none;
    resize: none;
  }
  .description:focus {
    border-bottom: 2px solid rgb(139 92 246);
    padding-bottom: calc(0.375rem - 1px);
  }
</style>
