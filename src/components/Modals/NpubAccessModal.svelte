<script lang="ts">
  import { nip19 } from 'nostr-tools';
  import { open as openShareModal } from './ShareModal.svelte';
  import { NpubRow, UserRow } from '../User';
  import { npubToPubkey, nostrStore } from '../../nostr';
  import { createFollowsStore } from '../../stores/follows';
  import { searchUsers, indexUsers, type UserIndexEntry, type UserIndexEntryInput } from '../../stores/searchIndex';
  import { getProfileSync } from '../../stores/profile';
  import QRScanner from '../QRScanner.svelte';
  import CopyText from '@iris/svelte-ui/CopyText.svelte';
  import Modal from '../ui/Modal.svelte';
  import { shortNpub } from '../../utils/format';
  import { extractNpubFromScan, titleCase, validateNpub } from './NpubAccessModal.utils';
  import type { NpubAccessModalProps as Props } from './NpubAccessModal.types';
  export type { AccessSection, RequestAccessOptions } from './NpubAccessModal.types';

  let {
    open,
    onClose,
    title,
    intro,
    sections,
    canEdit = false,
    onAdd,
    onRemove,
    validateAdd,
    initialSectionId,
    addPromptLabel,
    sectionSelectLabel = 'Role',
    addButtonLabel = 'Add',
    searchPlaceholder = 'Search followed users...',
    requestAccess = null,
    beforeSections,
    panelClass = 'w-full max-w-md mx-4',
    sectionsClass = 'space-y-3',
  }: Props = $props();

  let newNpubInput = $state('');
  let actionError = $state<string | null>(null);
  let pendingNpub = $state<string | null>(null);
  let showQRScanner = $state(false);
  let searchQuery = $state('');
  let showSearchResults = $state(false);
  let saving = $state(false);
  let selectedSectionId = $state('');
  let searchResults = $state<UserIndexEntry[]>([]);
  let searchTimer: ReturnType<typeof setTimeout> | null = null;

  let userPubkey = $derived($nostrStore.pubkey);
  let userNpub = $derived(userPubkey ? nip19.npubEncode(userPubkey) : null);
  let followsStore = $derived(createFollowsStore(userPubkey));
  let follows = $state<string[]>([]);

  let selectedSection = $derived.by(() => (
    sections.find(section => section.id === selectedSectionId) || sections[0] || null
  ));
  let userAlreadyIncluded = $derived(userNpub ? sections.some(section => section.npubs.includes(userNpub)) : false);
  let showRequestAccess = $derived(
    !canEdit &&
    !!requestAccess &&
    requestAccess.visible !== false &&
    !!userNpub &&
    !userAlreadyIncluded
  );

  $effect(() => {
    if (!followsStore) {
      follows = [];
      return;
    }
    const unsub = followsStore.subscribe(value => {
      follows = value?.follows || [];
    });
    return () => {
      unsub();
      followsStore.destroy();
    };
  });

  $effect(() => {
    if (follows.length === 0) return;

    const entries: UserIndexEntryInput[] = [];
    for (const pubkey of follows) {
      try {
        const profile = getProfileSync(pubkey);
        entries.push({
          pubkey,
          name: profile?.name,
          displayName: profile?.display_name,
          nip05: profile?.nip05,
        });
      } catch {
        // Ignore invalid pubkeys in follows index hydration
      }
    }

    if (entries.length > 0) {
      indexUsers(entries);
    }
  });

  function resolveInitialSectionId(): string {
    if (initialSectionId && sections.some(section => section.id === initialSectionId)) {
      return initialSectionId;
    }
    return sections[0]?.id || '';
  }

  $effect(() => {
    if (!open) return;
    newNpubInput = '';
    actionError = null;
    pendingNpub = null;
    showQRScanner = false;
    searchQuery = '';
    showSearchResults = false;
    saving = false;
    searchResults = [];
    selectedSectionId = resolveInitialSectionId();
  });

  $effect(() => {
    if (!open) return;
    if (sections.some(section => section.id === selectedSectionId)) return;
    selectedSectionId = resolveInitialSectionId();
  });

  function validateCandidate(npub: string): { valid: boolean; error?: string } {
    const formatValidation = validateNpub(npub);
    if (!formatValidation.valid) return formatValidation;

    const sectionId = selectedSection?.id;
    if (!sectionId) {
      return { valid: false, error: 'No role available.' };
    }

    const customError = validateAdd?.(npub, sectionId);
    if (customError) {
      return { valid: false, error: customError };
    }

    if (!validateAdd && selectedSection?.npubs.includes(npub)) {
      return { valid: false, error: `This npub is already a ${selectedSection.memberLabel}.` };
    }

    return { valid: true };
  }

  function clearTransientError(): void {
    if (actionError) actionError = null;
  }

  $effect(() => {
    const query = searchQuery.trim();
    const activeSectionId = selectedSectionId;
    const sectionSignature = sections
      .map(section => `${section.id}:${section.npubs.join(',')}`)
      .join('|');

    if (query.length < 2) {
      searchResults = [];
      return;
    }

    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      try {
        const results = await searchUsers(query, 10);
        searchResults = results.filter(item => {
          void activeSectionId;
          void sectionSignature;
          return validateCandidate(item.npub).valid;
        });
      } catch {
        searchResults = [];
      }
    }, 150);

    return () => {
      if (searchTimer) clearTimeout(searchTimer);
    };
  });

  let detectedNpub = $derived.by(() => {
    if (pendingNpub) return null;
    const trimmed = newNpubInput.trim();
    if (!trimmed || !trimmed.startsWith('npub1') || trimmed.length !== 63) return null;
    return validateCandidate(trimmed).valid ? trimmed : null;
  });

  function handlePrepareAdd() {
    const npub = newNpubInput.trim();
    const validation = validateCandidate(npub);

    if (!validation.valid) {
      actionError = validation.error || 'Invalid npub';
      return;
    }

    pendingNpub = npub;
    newNpubInput = '';
    actionError = null;
    showSearchResults = false;
  }

  async function applyAdd(npub: string): Promise<void> {
    if (!onAdd || !selectedSection) return;

    saving = true;
    try {
      const result = await onAdd(npub, selectedSection.id);
      if (typeof result === 'string' && result) {
        actionError = result;
        return;
      }
      pendingNpub = null;
      newNpubInput = '';
      searchQuery = '';
      showSearchResults = false;
      actionError = null;
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'Could not update access.';
    } finally {
      saving = false;
    }
  }

  async function handleRemove(sectionId: string, npub: string): Promise<void> {
    if (!onRemove) return;

    saving = true;
    try {
      const result = await onRemove(sectionId, npub);
      if (typeof result === 'string' && result) {
        actionError = result;
        return;
      }
      actionError = null;
    } catch (error) {
      actionError = error instanceof Error ? error.message : 'Could not update access.';
    } finally {
      saving = false;
    }
  }

  function handleQRScan(result: string) {
    const npub = extractNpubFromScan(result);
    showQRScanner = false;

    if (!npub) {
      actionError = 'Could not find an npub in the scanned QR code.';
      return;
    }

    const validation = validateCandidate(npub);
    if (!validation.valid) {
      actionError = validation.error || 'Invalid npub';
      return;
    }

    pendingNpub = npub;
    actionError = null;
  }

  function handleSearchSelect(result: UserIndexEntry) {
    const validation = validateCandidate(result.npub);
    if (!validation.valid) {
      actionError = validation.error || 'Invalid npub';
      return;
    }

    pendingNpub = result.npub;
    searchQuery = '';
    showSearchResults = false;
    actionError = null;
  }

  function handleEsc(event: KeyboardEvent) {
    if (!open || event.key !== 'Escape') return;

    event.preventDefault();
    if (showQRScanner) {
      showQRScanner = false;
      return;
    }
    if (pendingNpub) {
      pendingNpub = null;
      return;
    }
    onClose();
  }

  $effect(() => {
    if (!open) return;

    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  });
</script>

<Modal
  {open}
  {onClose}
  label={title}
  panelClass={panelClass}
  closeOnEsc={false}
>
  <div class="bg-surface-1 rounded-lg shadow-lg border border-surface-3">
    <div class="flex items-center justify-between px-4 py-3 border-b border-surface-3">
      <h2 class="text-lg font-semibold">{title}</h2>
      <button onclick={onClose} class="btn-ghost p-1" aria-label="Close">
        <span class="i-lucide-x text-lg"></span>
      </button>
    </div>

    <div class="p-4 space-y-4">
      <p class="text-sm text-text-3">{intro}</p>

      {#if beforeSections}
        {@render beforeSections()}
      {/if}

      <div class={sectionsClass}>
        {#each sections as section (section.id)}
          <div class="space-y-2">
            <span class="text-sm font-medium">{section.label}</span>
            {#if section.npubs.length > 0}
              <ul class="space-y-1 list-none m-0 p-0">
                {#each section.npubs as npub (npub)}
                  <li class="flex items-center gap-2 bg-surface-2 rounded px-3 py-2">
                    <a href={`#/${npub}/profile`} class="flex-1 min-w-0 hover:opacity-80">
                      <NpubRow npub={npub} avatarSize={32} class="min-w-0" />
                    </a>
                    {#if canEdit}
                      <button
                        onclick={() => handleRemove(section.id, npub)}
                        class="btn-ghost p-1 text-danger shrink-0"
                        title={section.removeTitle || `Remove ${section.memberLabel}`}
                        disabled={saving}
                      >
                        <span class="i-lucide-x"></span>
                      </button>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <div class="text-sm text-text-3 bg-surface-2 rounded px-3 py-2">
                {section.emptyText || `No ${section.label.toLowerCase()} yet.`}
              </div>
            {/if}
          </div>
        {/each}
      </div>

      {#if showRequestAccess && requestAccess && userNpub}
        <div class="bg-surface-2 rounded p-3 space-y-2">
          <p class="text-sm text-text-2">{requestAccess.text}</p>
          <div class="flex items-center gap-2">
            <CopyText
              text={requestAccess.copyText || userNpub}
              displayText={requestAccess.displayText || shortNpub(requestAccess.copyText || userNpub, { start: 12, end: 6 })}
              class="text-sm flex-1 min-w-0"
            />
            {#if requestAccess.shareHref}
              <button
                onclick={() => {
                  const shareHref = requestAccess.shareHref?.(userNpub);
                  if (!shareHref) return;
                  openShareModal(shareHref);
                }}
                class="btn-ghost p-2 shrink-0"
                title={requestAccess.shareTitle || 'Share with QR code'}
              >
                <span class="i-lucide-share text-base"></span>
              </button>
            {/if}
          </div>
        </div>
      {/if}

      {#if pendingNpub && canEdit}
        {@const pendingNpubValue = pendingNpub}
        {@const pendingPubkey = npubToPubkey(pendingNpubValue)}
        <div class="space-y-2">
          <span class="text-sm font-medium">Add this {selectedSection?.memberLabel || 'user'}?</span>
          <div class="bg-surface-2 rounded p-3 space-y-3">
            <div class="flex items-center gap-3">
              {#if pendingPubkey}
                <NpubRow npub={pendingNpubValue} avatarSize={40} />
              {:else}
                <span class="text-text-3 text-sm">Invalid npub</span>
              {/if}
            </div>
            {#if sections.length > 1}
              <div class="space-y-1">
                <label class="text-xs text-text-3" for="npub-access-pending-section">{sectionSelectLabel}</label>
                <select
                  id="npub-access-pending-section"
                  class="input w-full text-sm"
                  bind:value={selectedSectionId}
                  onchange={clearTransientError}
                  disabled={saving}
                >
                  {#each sections as section (section.id)}
                    <option value={section.id}>{titleCase(section.memberLabel)}</option>
                  {/each}
                </select>
              </div>
            {/if}
            <div class="flex gap-2">
              <button onclick={() => pendingNpub = null} class="btn-ghost flex-1 text-sm" disabled={saving}>
                Cancel
              </button>
              <button
                onclick={() => applyAdd(pendingNpubValue)}
                class="btn-success flex-1 text-sm"
                disabled={!pendingPubkey || saving}
              >
                {saving ? 'Saving...' : `Add ${titleCase(selectedSection?.memberLabel || 'User')}`}
              </button>
            </div>
          </div>
        </div>
      {/if}

      {#if detectedNpub && !pendingNpub && canEdit}
        {@const detectedPubkey = npubToPubkey(detectedNpub)}
        <div class="space-y-2">
          <span class="text-sm font-medium">Add this {selectedSection?.memberLabel || 'user'}?</span>
          <div class="bg-surface-2 rounded p-3 space-y-3">
            <div class="flex items-center gap-3">
              {#if detectedPubkey}
                <NpubRow npub={detectedNpub} avatarSize={40} />
              {:else}
                <span class="text-text-3 text-sm">Invalid npub</span>
              {/if}
            </div>
            {#if sections.length > 1}
              <div class="space-y-1">
                <label class="text-xs text-text-3" for="npub-access-detected-section">{sectionSelectLabel}</label>
                <select
                  id="npub-access-detected-section"
                  class="input w-full text-sm"
                  bind:value={selectedSectionId}
                  onchange={clearTransientError}
                  disabled={saving}
                >
                  {#each sections as section (section.id)}
                    <option value={section.id}>{titleCase(section.memberLabel)}</option>
                  {/each}
                </select>
              </div>
            {/if}
            <div class="flex gap-2">
              <button onclick={() => newNpubInput = ''} class="btn-ghost flex-1 text-sm" disabled={saving}>
                Cancel
              </button>
              <button
                onclick={() => applyAdd(detectedNpub)}
                class="btn-success flex-1 text-sm"
                disabled={!detectedPubkey || saving}
              >
                {saving ? 'Saving...' : `Add ${titleCase(selectedSection?.memberLabel || 'User')}`}
              </button>
            </div>
          </div>
        </div>
      {/if}

      {#if canEdit && !pendingNpub}
        <div class="space-y-2">
          <span class="text-sm font-medium">{addPromptLabel || (sections.length > 1 ? 'Assign role' : `Add ${selectedSection?.memberLabel || 'user'}`)}</span>

          {#if follows.length > 0}
            <div class="relative">
              <div class="flex gap-2">
                <div class="relative flex-1">
                  <span class="i-lucide-search absolute left-3 top-1/2 -translate-y-1/2 text-text-3 text-sm"></span>
                  <input
                    type="text"
                    bind:value={searchQuery}
                    oninput={() => {
                      showSearchResults = true;
                      clearTransientError();
                    }}
                    onfocus={() => showSearchResults = true}
                    placeholder={searchPlaceholder}
                    class="input w-full pl-9 text-sm"
                  />
                </div>
              </div>

              {#if showSearchResults && searchResults.length > 0}
                <div class="absolute top-full left-0 right-0 mt-1 bg-surface-2 rounded border border-surface-3 shadow-lg z-10 max-h-48 overflow-auto">
                  {#each searchResults as result (result.pubkey)}
                    <button
                      onclick={() => handleSearchSelect(result)}
                      class="w-full px-3 py-2 hover:bg-surface-3 text-left"
                    >
                      <UserRow pubkey={result.pubkey} avatarSize={28} />
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}

          {#if follows.length > 0}
            <div class="flex items-center gap-2 text-xs text-text-3">
              <span class="flex-1 h-px bg-surface-3"></span>
              <span>or paste npub</span>
              <span class="flex-1 h-px bg-surface-3"></span>
            </div>
          {/if}

          {#if !detectedNpub}
            <div class="flex gap-2">
              <input
                type="text"
                bind:value={newNpubInput}
                placeholder="npub1..."
                class="input flex-1 font-mono text-sm"
                oninput={clearTransientError}
                onkeydown={(event) => event.key === 'Enter' && handlePrepareAdd()}
                disabled={saving}
              />
              {#if sections.length > 1}
                <select class="input w-28 text-sm" bind:value={selectedSectionId} onchange={clearTransientError} disabled={saving}>
                  {#each sections as section (section.id)}
                    <option value={section.id}>{titleCase(section.memberLabel)}</option>
                  {/each}
                </select>
              {/if}
              <button
                onclick={() => showQRScanner = true}
                class="btn-ghost px-2"
                title="Scan QR code"
                disabled={saving}
              >
                <span class="i-lucide-qr-code text-lg"></span>
              </button>
              <button
                onclick={handlePrepareAdd}
                class="btn-success px-3"
                disabled={!newNpubInput.trim() || saving}
              >
                {addButtonLabel}
              </button>
            </div>
          {/if}

          {#if actionError}
            <p class="text-sm text-danger">{actionError}</p>
          {/if}
        </div>
      {/if}
    </div>

    <div class="flex justify-end gap-2 px-4 py-3 border-t border-surface-3">
      <button onclick={onClose} class="btn-ghost" disabled={saving}>
        Close
      </button>
    </div>
  </div>

  {#if showQRScanner}
    <QRScanner
      onScanSuccess={handleQRScan}
      onClose={() => showQRScanner = false}
    />
  {/if}
</Modal>
