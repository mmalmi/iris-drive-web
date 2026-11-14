<script lang="ts">
  /**
   * A form opened from a Drive folder. Whoever can edit it sees its questions
   * and responses, a preview and Send; anyone else who can open it fills it in.
   */
  import { onMount, onDestroy } from 'svelte';
  import DocumentHeader from '../Viewer/DocumentHeader.svelte';
  import { DriveDocument } from '../../lib/yjs';
  import { readForm, seedForm, type FormData } from '../../lib/forms/model';
  import { FormResponses, setUpInbox } from '../../lib/forms/formResponses.svelte';
  import { canKeepForms } from '../../lib/forms/formStore';
  import FormEditor from './FormEditor.svelte';
  import FormFill from './FormFill.svelte';
  import FormResults from './FormResults.svelte';
  import SendDialog from './SendDialog.svelte';

  interface Props {
    dirName: string;
  }
  let { dirName }: Props = $props();

  // svelte-ignore state_referenced_locally
  const drive = new DriveDocument(dirName);
  let form = $state.raw<FormData>(readForm(drive.ydoc));
  drive.ydoc.on('update', () => {
    form = readForm(drive.ydoc);
  });
  const results = new FormResponses(() => form, () => drive.canEdit);

  let ready = $state(false);
  let tab = $state<'questions' | 'responses'>('questions');
  let previewing = $state(false);
  let sending = $state(false);
  let setUpFailed = $state(false);

  // The inbox can change while the form is open (two devices set it up at once).
  $effect(() => {
    void form.inbox?.pubkey;
    if (ready) results.refresh();
  });

  onMount(() => {
    void (async () => {
      if (!await drive.open()) return;
      if (drive.canEdit && !form.inbox) await setUp();
      ready = true;
    })();
  });

  /** A new form gets the key its answers are sent to, kept in this account's My Drive, and a first question. */
  async function setUp(): Promise<void> {
    if (!canKeepForms()) {
      setUpFailed = true;
      return;
    }
    const inbox = await setUpInbox();
    if (!inbox) {
      setUpFailed = true;
      return;
    }
    seedForm(drive.ydoc, inbox);
    setUpFailed = false;
  }

  onDestroy(() => {
    results.destroy();
    drive.destroy();
  });

  let count = $derived(results.responses.length);
</script>

<div class="relative flex-1 flex flex-col min-h-0 bg-surface-0" data-testid="document-editor">
  {#if drive.canEdit}
    <DocumentHeader {drive} editorMenu>
      {#if ready}
        <button
          class="btn-circle btn-ghost"
          class:bg-surface-3={previewing}
          onclick={() => { previewing = !previewing; }}
          title={previewing ? 'Back to editing' : 'Preview'}
          aria-label={previewing ? 'Back to editing' : 'Preview'}
          aria-pressed={previewing}
          data-testid="form-preview"
        >
          <span class="{previewing ? 'i-lucide-pencil' : 'i-lucide-eye'} text-base"></span>
        </button>
        <button class="btn-success flex items-center gap-1.5" onclick={() => { sending = true; }} data-testid="form-send">
          <span class="i-lucide-send text-sm"></span>
          <span class="hidden sm:inline">Send</span>
        </button>
      {/if}
    </DocumentHeader>
  {/if}

  {#if drive.loading && drive.missing}
    <div class="flex-1 flex-center text-text-3 text-sm" data-testid="document-missing">Form not found</div>
  {:else if !ready}
    <div class="flex-1 flex-center text-text-3" data-testid="document-loading">
      <span class="i-lucide-loader-2 animate-spin"></span>
    </div>
  {:else if !drive.canEdit}
    <FormFill {form} title={drive.title} />
  {:else if previewing}
    <div class="shrink-0 px-4 py-1.5 text-xs text-text-1 bg-accent/15 text-center" role="status">
      This is how people see the form. Answers sent from here count as responses.
    </div>
    <FormFill {form} title={drive.title} />
  {:else}
    {#if setUpFailed}
      <div class="shrink-0 px-4 py-1.5 text-xs text-text-1 bg-warning/20" role="alert" data-testid="form-setup-failed">
        This form can't take responses yet: My Drive hasn't loaded on this device.
        <button class="underline" onclick={() => void setUp()}>Try again</button>
      </div>
    {/if}
    <div class="shrink-0 flex justify-center gap-6 border-b border-surface-2 bg-surface-1" role="tablist">
      <button
        role="tab"
        class="px-1 py-2.5 text-sm font-medium flex items-center border-b-3 border-b-solid {tab === 'questions' ? 'text-violet-500 border-violet-500' : 'text-text-2 border-transparent hover:text-text-1'}"
        aria-selected={tab === 'questions'}
        onclick={() => { tab = 'questions'; }}
        data-testid="form-tab-questions"
      >Questions</button>
      <button
        role="tab"
        class="px-1 py-2.5 text-sm font-medium flex items-center border-b-3 border-b-solid {tab === 'responses' ? 'text-violet-500 border-violet-500' : 'text-text-2 border-transparent hover:text-text-1'}"
        aria-selected={tab === 'responses'}
        onclick={() => { tab = 'responses'; }}
        data-testid="form-tab-responses"
      >
        Responses
        {#if count > 0}<span class="ml-1 px-1.5 rounded-full bg-violet-500 text-white text-xs" data-testid="form-response-count">{count}</span>{/if}
      </button>
    </div>
    {#if tab === 'questions'}
      <FormEditor ydoc={drive.ydoc} {form} title={drive.title} />
    {:else}
      <FormResults ydoc={drive.ydoc} {form} {results} title={drive.title} />
    {/if}
  {/if}

  {#if sending}
    <SendDialog ydoc={drive.ydoc} {form} title={drive.title} onclose={() => { sending = false; }} />
  {/if}
</div>
