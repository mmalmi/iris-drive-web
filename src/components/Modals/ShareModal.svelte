<script lang="ts" module>
  /**
   * ShareModal - unified sharing options with QR code, copy link, and native share
   */
  import { getAppType } from '../../appType';
  import { createShareUrlOptions, type ShareUrlOption, type ShareUrlOptionId } from '../../lib/shareUrls';
  import type { SharePeopleTarget } from '../../drive/sharePeople';

  interface ModalLinkVariant {
    id: 'snapshot' | 'latest';
    label: string;
    options: ShareUrlOption[];
  }

  let show = $state(false);
  let linkVariants = $state<ModalLinkVariant[]>([]);
  let selectedLinkVariantId = $state<ModalLinkVariant['id']>('snapshot');
  let options = $state<ShareUrlOption[]>([]);
  let selectedOptionId = $state<ShareUrlOptionId>('web');
  let people = $state<SharePeopleTarget | null>(null);
  let showPeople = $state(false);

  /**
   * `peopleTarget` adds inviting people, which the dialog opens on unless
   * `startWithPeople` is false: sharing is about people first, as elsewhere.
   */
  export function open(
    shareUrl: string,
    latestShareUrl: string | null = null,
    peopleTarget: SharePeopleTarget | null = null,
    startWithPeople = true,
  ) {
    people = peopleTarget;
    showPeople = Boolean(peopleTarget && startWithPeople);
    const snapshotOptions = createShareUrlOptions(getAppType(), shareUrl);
    const latestOptions = latestShareUrl
      ? createShareUrlOptions(getAppType(), latestShareUrl)
      : null;
    linkVariants = [
      { id: 'snapshot', label: 'Snapshot', options: snapshotOptions },
      ...(latestOptions && latestOptions[0]?.url !== snapshotOptions[0]?.url
        ? [{ id: 'latest' as const, label: 'Latest', options: latestOptions }]
        : []),
    ];
    selectedLinkVariantId = 'snapshot';
    options = snapshotOptions;
    selectedOptionId = 'web';
    show = true;
  }

  function selectLinkVariant(id: ModalLinkVariant['id']) {
    const variant = linkVariants.find((candidate) => candidate.id === id);
    if (!variant) return;
    selectedLinkVariantId = id;
    options = variant.options;
    selectedOptionId = 'web';
  }

  export function close() {
    show = false;
    people = null;
    showPeople = false;
    linkVariants = [];
    selectedLinkVariantId = 'snapshot';
    options = [];
    selectedOptionId = 'web';
  }
</script>

<script lang="ts">
  import { qrCodeDataUrl } from '../../lib/qrCode';
  import CopyText from '@iris/svelte-ui/CopyText.svelte';
  import { currentHash } from '../../stores';
  import { parseRouteFromHash } from '../../utils/route';
  import { acceptedShares } from '../../drive/shareLibrary';
  import { sharedRouteForOwnPath } from '../../drive/sharePeople';
  import { activeNostrIdentityRootScope } from '../../drive/profileRoute';
  import { nostrStore } from '../../nostr';
  import { COPY_NAME_PARAM } from '../../lib/shareUrls';
  import { documentTitle, isDocumentFolderName } from '../../lib/documentNames';

  /** The address without its query, which changes when a link key is added. */
  const place = (hash: string) => hash.replace(/^#/, '').split('?')[0];
  let openedAt = '';

  // Going somewhere else closes the dialog. Sharing an item moves the page to
  // the same item in the new shared folder, which keeps it open.
  $effect(() => {
    const hash = $currentHash;
    if (!show) {
      openedAt = '';
      return;
    }
    const here = place(hash);
    if (!openedAt) {
      openedAt = here;
      return;
    }
    if (here === openedAt) return;
    const before = parseRouteFromHash(`#${openedAt}`);
    const profileId = activeNostrIdentityRootScope($nostrStore);
    const moved = before.npub === profileId && before.treeName === 'main'
      ? sharedRouteForOwnPath(before.path, profileId, $acceptedShares)
      : null;
    if (moved && place(moved) === here) {
      openedAt = here;
      return;
    }
    close();
  });

  let selectedUrl = $derived(options.find((option) => option.id === selectedOptionId)?.url ?? null);

  /** What is being shared, by name: the folder or document, or the last part of the link. */
  let sharedName = $derived.by((): string => {
    if (people?.kind === 'drive') return people.name;
    if (people?.kind === 'share') {
      if (people.doc) return documentTitle(people.doc);
      const shareId = people.shareId;
      return $acceptedShares.find((record) => record.share_id === shareId)?.folder.display_name ?? '';
    }
    const [path = '', query = ''] = (options[0]?.url.split('#')[1] ?? '').split('?');
    const last = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
    const name = new URLSearchParams(query).get(COPY_NAME_PARAM)
      ?? (/^(nhash|npub)1/.test(last) ? '' : last);
    return isDocumentFolderName(name) ? documentTitle(name) : name;
  });
  let closeButton: HTMLButtonElement | undefined = $state();

  // The keyboard starts in the dialog, on its way out.
  $effect(() => {
    if (show) closeButton?.focus();
  });
  let qrDataUrl = $state<string | null>(null);

  // Generate QR code when modal opens
  $effect(() => {
    if (!show || !selectedUrl) {
      qrDataUrl = null;
      return;
    }
    generateQrCode(selectedUrl).then((u) => (qrDataUrl = u));
  });

  // Handle Escape key to close modal
  $effect(() => {
    if (!show) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        (document.activeElement as HTMLElement)?.blur();
        close();
      }
    };

    // First in line, so an editor underneath cannot take the Escape.
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  });

  async function handleNativeShare() {
    if (navigator.share && selectedUrl) {
      try {
        await navigator.share({ url: selectedUrl });
      } catch (e) {
        if ((e as Error).name !== 'AbortError') {
          console.error('Share failed:', e);
        }
      }
    }
  }

  async function generateQrCode(text: string): Promise<string> {
    return qrCodeDataUrl(text, {
      width: 200,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
    });
  }
</script>

{#if show && selectedUrl}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 bg-black/70 flex-center z-1000 overflow-auto"
    onclick={(e) => {
      if (e.target === e.currentTarget) close();
    }}
    data-testid="share-modal-backdrop"
  >
    <div
      class="bg-surface-1 sm:rounded-lg overflow-auto w-screen sm:w-96 sm:border border-surface-3 max-h-full my-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="share-dialog-title"
      data-testid="share-modal"
    >
      <div class="flex items-center gap-2 pl-4 pr-2 pt-3">
        <h2 id="share-dialog-title" class="min-w-0 flex-1 truncate text-base font-medium text-text-1">
          {sharedName ? `Share “${sharedName}”` : 'Share'}
        </h2>
        <button bind:this={closeButton} class="btn-circle btn-ghost shrink-0" aria-label="Close" title="Close" onclick={close}>
          <span class="i-lucide-x text-lg"></span>
        </button>
      </div>
      {#if people}
        <div class="grid grid-cols-2 gap-2 px-4 pt-3">
          {#each [[true, 'People'], [false, linkVariants.length > 1 ? 'View link' : 'Read-only copy']] as [value, label] (label)}
            <button
              class={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                value === showPeople ? 'border-accent bg-accent/10 text-text-1' : 'border-surface-3 text-text-3'
              }`}
              onclick={() => { showPeople = value as boolean; }}
              aria-pressed={value === showPeople}
              data-testid={value ? 'share-tab-people' : 'share-tab-link'}
            >
              {label}
            </button>
          {/each}
        </div>
      {/if}
      {#if people && showPeople}
        {#await import('../SharePeoplePanel.svelte') then { default: SharePeoplePanel }}
          <SharePeoplePanel target={people} />
        {/await}
      {:else}
      {#if linkVariants.length > 1}
        <div class="grid grid-cols-2 gap-2 px-4 pt-4">
          {#each linkVariants as variant (variant.id)}
            <button
              class={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                variant.id === selectedLinkVariantId
                  ? 'border-accent bg-accent/10 text-text-1'
                  : 'border-surface-3 text-text-3'
              }`}
              onclick={() => selectLinkVariant(variant.id)}
              aria-pressed={variant.id === selectedLinkVariantId}
              data-testid={`share-link-variant-${variant.id}`}
            >
              {variant.label}
            </button>
          {/each}
        </div>
        <p class="px-4 pt-2 text-xs text-text-3">
          {selectedLinkVariantId === 'snapshot'
            ? 'Fixed to this revision.'
            : 'Follows future updates at this path.'}
        </p>
      {:else}
        <!-- The only link is to what is here now: say so, next to the invite link that gives access. -->
        <p class="px-4 pt-3 text-sm text-text-2" data-testid="share-link-note">
          Anyone with this link can view a copy as it is now, without an account. Later changes are not included.
        </p>
      {/if}

      <div class="grid grid-cols-2 gap-2 px-4 pt-4">
        {#each options as option (option.id)}
          <button
            class={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
              option.id === selectedOptionId
                ? 'border-accent bg-accent/10 text-text-1'
                : 'border-surface-3 text-text-3'
            }`}
            onclick={() => { selectedOptionId = option.id; }}
            aria-pressed={option.id === selectedOptionId}
            data-testid={`share-url-option-${option.id}`}
          >
            {option.label}
          </button>
        {/each}
      </div>

      <!-- QR Code - click to close -->
      <div class="cursor-pointer" onclick={close}>
        {#if qrDataUrl}
          <img
            src={qrDataUrl}
            alt="QR Code"
            class="w-full max-h-screen object-contain bg-white"
            data-testid="share-qr-code"
          />
        {:else}
          <div class="w-full aspect-square max-h-screen bg-surface-2 flex-center">
            <span class="i-lucide-loader-2 animate-spin text-2xl text-text-3"></span>
          </div>
        {/if}
      </div>

      <!-- URL with copy -->
      <div class="bg-surface-2 p-3 m-4 mb-2 rounded">
        <CopyText text={selectedUrl} truncate={80} class="text-sm" testId="share-copy-url" />
      </div>

      <!-- Native share button -->
      {#if typeof navigator !== 'undefined' && 'share' in navigator}
        <div class="px-4 pb-4 pt-2">
          <button onclick={handleNativeShare} class="btn-ghost w-full flex items-center justify-center gap-2">
            <span class="i-lucide-share"></span>
            Share via...
          </button>
        </div>
      {/if}
      {/if}
    </div>
  </div>
{/if}
