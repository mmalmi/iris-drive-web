<script lang="ts">
  /**
   * The account's recovery phrase: 12 words that sign in to the account on a
   * new device and bring its files back, also when every other device is lost:
   * each device wraps its Drive's key for the phrase too. Once added, the page
   * says when the relays hold what the phrase needs, as leaving before that
   * could lose it. The words are shown once, checked by typing two of
   * them back, and only then added. Drive keeps the phrase's public key, never
   * the words. As in native, a new phrase is added next to an earlier one.
   */
  import { onDestroy } from 'svelte';
  import { getPublicKey, type Event } from 'nostr-tools';
  import { privateKeyFromSeedWords } from 'nostr-tools/nip06';
  import { whenRelaysHold } from '../../lib/relayHolds';
  import { KIND_DRIVE_ROOT } from '../../drive/protocolTypes';
  import { driveRootDTag } from '../../drive/protocolRoots';
  import { rootWrapRecipients } from '../../drive/recoveryRootKeys';
  import { profileDriveProjection } from '../../drive/profileDriveProjection';
  import { getLocalRootCache } from '../../treeRootCache';
  import CopyButton from '@iris/svelte-ui/CopyButton.svelte';
  import { addDriveRecoveryPhrase, getCurrentNostrIdentitySession, nostrStore } from '../../nostr';
  import { projectNostrIdentityRoster } from '../../drive/protocol';
  import {
    activeRecoveryPhraseFacets,
    generateRecoveryPhrase,
    normalizeRecoveryPhrase,
    pickConfirmationWordIndexes,
  } from '../../drive/recoveryPhrase';

  type Step = 'status' | 'words' | 'check';

  let step = $state<Step>('status');
  let words = $state<string[]>([]);
  let checkIndexes = $state<[number, number]>([0, 1]);
  let typed = $state<[string, string]>(['', '']);
  let busy = $state(false);
  let error = $state('');
  /** After adding: 'saving' until the relays hold what the phrase needs, then 'saved'. */
  let saving = $state<'saving' | 'saved' | null>(null);
  let stopWatching: Array<() => void> = [];

  let account = $derived.by(() => {
    void $nostrStore;
    const session = getCurrentNostrIdentitySession();
    if (!session || session.status !== 'active') return null;
    const projection = projectNostrIdentityRoster(session.profileId, session.rosterOps);
    return {
      phrases: activeRecoveryPhraseFacets(projection),
      canManage: Boolean(projection.active_facets[session.appKeyPubkey]?.capabilities?.can_admin_profile),
    };
  });
  let phrases = $derived(account?.phrases ?? []);
  let newest = $derived(phrases.at(-1));
  let checked = $derived(checkIndexes.every((wordIndex, slot) => (
    normalizeRecoveryPhrase(typed[slot]) === words[wordIndex]
  )));

  function addedOn(seconds: number): string {
    return new Date(seconds * 1000).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  function forgetWords(): void {
    words = [];
    typed = ['', ''];
  }

  function start(): void {
    error = '';
    words = generateRecoveryPhrase().split(' ');
    checkIndexes = pickConfirmationWordIndexes(words.length);
    typed = ['', ''];
    step = 'words';
  }

  function cancel(): void {
    forgetWords();
    error = '';
    step = 'status';
  }

  async function add(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!checked || busy) return;
    busy = true;
    error = '';
    try {
      const phrase = words.join(' ');
      const recoveryPubkey = getPublicKey(privateKeyFromSeedWords(normalizeRecoveryPhrase(phrase)));
      const session = await addDriveRecoveryPhrase(phrase);
      forgetWords();
      step = 'status';
      watchSaved(recoveryPubkey, session.appKeyPubkey, session.profileId);
    } catch (addError) {
      error = addError instanceof Error ? addError.message : 'Could not add the recovery phrase';
    } finally {
      busy = false;
    }
  }

  /**
   * The phrase finds the account by the record it signed, and brings the files
   * back through this device's Drive wrapped for it: both must reach the relays.
   */
  function watchSaved(recoveryPubkey: string, device: string, profileId: string): void {
    for (const stop of stopWatching) stop();
    saving = 'saving';
    // The first local files may still be uploading and have no published
    // contribution yet. They must be recoverable before this page says saved.
    const drives = ['main', 'trash'].filter(drive =>
      !!getLocalRootCache(profileId, drive) || !!profileDriveProjection.contributionRoot(profileId, drive, device));
    let waiting = 1 + drives.length;
    const held = () => {
      waiting -= 1;
      if (waiting === 0) saving = 'saved';
    };
    stopWatching = [
      whenRelaysHold({ authors: [recoveryPubkey] }, () => true, held),
      ...drives.map(drive => whenRelaysHold({
        kinds: [KIND_DRIVE_ROOT], authors: [device], '#d': [driveRootDTag(profileId, drive)],
      }, event => rootWrapRecipients(event as Event).has(recoveryPubkey), held)),
    ];
  }

  function onbeforeunload(event: BeforeUnloadEvent): void {
    if (saving === 'saving') event.preventDefault();
  }

  onDestroy(() => {
    forgetWords();
    for (const stop of stopWatching) stop();
  });
</script>

<svelte:window {onbeforeunload} />

<div class="rounded bg-surface-2 p-3 space-y-3" data-testid="recovery-phrase-settings">
  {#if step === 'status'}
    <p class="text-sm text-text-2">
      If you lose your devices, your recovery phrase signs you in on a new one and brings your files back. It is 12 words for you to write down and keep safe.
    </p>
    {#if newest}
      <p class="flex items-start gap-2 text-sm text-text-1" data-testid="recovery-phrase-status">
        <span class="i-lucide-circle-check mt-0.5 shrink-0 text-success"></span>
        <span>
          Recovery phrase added on {addedOn(newest.added_at)}.
          {#if phrases.length > 1}Your earlier one works too.{/if}
        </span>
      </p>
    {:else}
      <p class="text-sm text-text-1" data-testid="recovery-phrase-status">You have no recovery phrase yet.</p>
    {/if}
    {#if saving === 'saving'}
      <p class="flex items-center gap-2 text-xs text-text-3" data-testid="recovery-phrase-saving">
        <span class="i-lucide-loader-2 animate-spin"></span>Saving. Keep this page open for a moment.
      </p>
    {:else if saving === 'saved'}
      <p class="flex items-center gap-2 text-xs text-text-3" data-testid="recovery-phrase-saved">
        <span class="i-lucide-check"></span>Saved
      </p>
    {/if}
    {#if account?.canManage}
      <button
        type="button"
        class="{newest ? 'btn-ghost' : 'btn-primary'} flex items-center gap-2 text-sm"
        onclick={start}
        data-testid="create-recovery-phrase"
      >
        <span class="i-lucide-key-round"></span>
        <span>{newest ? 'Create a new recovery phrase' : 'Create recovery phrase'}</span>
      </button>
    {:else if account}
      <p class="text-xs text-text-3">Only an admin device can create one.</p>
    {/if}
  {:else if step === 'words'}
    <p class="flex gap-2 text-sm text-text-1">
      <span class="i-lucide-triangle-alert mt-0.5 shrink-0 text-danger"></span>
      <span>Write these words down, in order, and keep them somewhere safe. Anyone who has them can open your Drive.</span>
    </p>
    <ol
      class="m-0 grid list-none grid-cols-2 gap-2 p-0 sm:grid-cols-3"
      translate="no"
      aria-label="Recovery phrase"
      data-testid="recovery-phrase-words"
    >
      {#each words as word, index (index)}
        <li class="flex items-baseline gap-2 rounded bg-surface-1 px-3 py-2">
          <span class="w-5 shrink-0 text-right text-xs text-text-3">{index + 1}</span>
          <span class="font-mono text-sm text-text-1 select-all" data-testid="recovery-phrase-word">{word}</span>
        </li>
      {/each}
    </ol>
    {#if newest}
      <p class="text-xs text-text-3">Your earlier recovery phrase keeps working.</p>
    {/if}
    <div class="flex flex-wrap items-center gap-2">
      <CopyButton
        text={words.join(' ')}
        label="Copy"
        copiedLabel="Copied"
        class="btn-ghost flex items-center gap-2 text-sm"
        iconClass="i-lucide-copy"
        copiedIconClass="i-lucide-check text-success"
        testId="copy-recovery-phrase"
      />
      <span class="flex-1"></span>
      <button type="button" class="btn-ghost text-sm" onclick={cancel}>Cancel</button>
      <button
        type="button"
        class="btn-primary text-sm"
        onclick={() => (step = 'check')}
        data-testid="recovery-phrase-written"
      >I wrote them down</button>
    </div>
  {:else}
    <form class="space-y-3" onsubmit={add} novalidate>
      <p class="text-sm text-text-2">To check, type two of the words.</p>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {#each checkIndexes as wordIndex, slot (wordIndex)}
          <label class="block">
            <span class="mb-1 block text-xs text-text-3">Word {wordIndex + 1}</span>
            <input
              class="input w-full font-mono text-sm"
              type="text"
              autocomplete="off"
              autocapitalize="none"
              spellcheck="false"
              disabled={busy}
              bind:value={typed[slot]}
              data-testid="recovery-phrase-check"
            />
          </label>
        {/each}
      </div>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <button type="button" class="btn-ghost text-sm" disabled={busy} onclick={() => (step = 'words')}>Show words again</button>
        <button
          type="submit"
          class="btn-primary flex items-center gap-2 text-sm"
          disabled={!checked || busy}
          data-testid="add-recovery-phrase"
        >
          {#if busy}<span class="i-lucide-loader-2 animate-spin"></span>{/if}
          <span>Add recovery phrase</span>
        </button>
      </div>
    </form>
  {/if}
  {#if error}
    <p class="text-sm text-danger" role="alert">{error}</p>
  {/if}
</div>
