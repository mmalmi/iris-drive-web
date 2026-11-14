<script lang="ts">
  import { nostrStore } from '../nostr';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import {
    nativeShareActionEndpoint,
    type NativeSharedFolderView,
  } from '../drive/nativeShareActions';
  import {
    applyNativeShareActionResult,
    nativeShares as nativeShareStore,
    refreshNativeShareState,
  } from '../drive/nativeShareState';
  import type { SharedFolderView } from '../drive/protocol';
  import { addShareShortcutThroughCore } from '../drive/shareInviteActions';
  import {
    acceptedShares,
    isOwnShare,
    projectAcceptedShareViews,
  } from '../drive/shareLibrary';
  import { toast } from '../stores/toast';
  import { documentKindInfo, isDocumentFolderName } from '../lib/documentNames';
  import { grantFor, personHref, sharedItemHref } from '../drive/people';

  interface Props {
    standalone?: boolean;
  }

  let { standalone = false }: Props = $props();

  type SharedWithMeRow = NativeSharedFolderView | SharedFolderView;

  let nativeActionEndpoint = $derived(nativeShareActionEndpoint());
  let shareActionPending = $state('');
  // Folders this profile shared itself are in My Drive, as in other drives.
  let localShareViews = $derived(projectAcceptedShareViews($acceptedShares.filter((share) => share.local_profile_id === activeNostrIdentityRootScope($nostrStore) && !isOwnShare(share)), $nostrStore.pubkey ?? undefined).map((share) => share.view));
  // The native app answers on this address only when it is running; without
  // an answer the folders this browser has joined are shown.
  let nativeAnswered = $state(false);
  let usingNative = $derived(Boolean(nativeActionEndpoint && nativeAnswered));
  let allShares = $derived.by((): SharedWithMeRow[] => (
    usingNative ? $nativeShareStore : localShareViews
  ));
  // Folders someone removed this profile from no longer open; they are listed apart, at the bottom.
  let shares = $derived(allShares.filter((share) => share.key_status !== 'revoked'));
  let removed = $derived(allShares.filter((share) => share.key_status === 'revoked'));

  $effect(() => {
    if (!nativeActionEndpoint) return;
    void refreshNativeShareState().then(() => { nativeAnswered = true; }).catch(() => undefined);
  });

  async function handleAddShortcut(shareId: string) {
    if (shareActionPending) return;
    shareActionPending = shareId;
    try {
      if (nativeActionEndpoint) {
        applyNativeShareActionResult(await addShareShortcutThroughCore(shareId));
      }
      toast.success('Shortcut added');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add shortcut');
    } finally {
      shareActionPending = '';
    }
  }

  /** Who shared it, when this browser holds the folder's access list. */
  function owner(shareId: string): { name: string; href: string } | null {
    if (usingNative) return null;
    const record = $acceptedShares.find((item) => item.share_id === shareId);
    if (!record || isOwnShare(record)) return null;
    const ownerId = record.folder.owner_profile_id;
    const name = grantFor(record.folder, ownerId)?.display_name;
    return name ? { name, href: personHref(record.folder, ownerId) } : null;
  }

  const ROLE_TEXT: Record<string, string> = { admin: 'Admin', editor: 'Can edit', reader: 'Can view' };

  function roleLabel(share: SharedWithMeRow): string {
    const known = ROLE_TEXT[share.local_role];
    if (known) return known;
    if ('local_role_label' in share && share.local_role_label) return share.local_role_label;
    if ('role_label' in share && share.role_label) return share.role_label;
    return labelText(share.local_role);
  }

  /** Worth saying only when something is wrong: a folder that opens needs no status. */
  function keyStatusLabel(share: SharedWithMeRow): string {
    if (share.key_status === 'available') return '';
    if ('key_status_label' in share && share.key_status_label) return share.key_status_label;
    return labelText(share.key_status);
  }

  /** A shared document is a folder holding one document: that document's name, for its icon. */
  function sharedDocumentName(share: SharedWithMeRow): string | null {
    const source = share.source_path?.split('/').at(-1);
    return source && isDocumentFolderName(source) ? source : null;
  }

  function detailText(share: SharedWithMeRow): string {
    return [roleLabel(share), keyStatusLabel(share), participantText(share), repairText(share)]
      .filter(Boolean)
      .join(' · ');
  }

  function participantText(share: SharedWithMeRow): string {
    return `${share.participant_count} ${share.participant_count === 1 ? 'person' : 'people'}`;
  }

  function repairText(share: SharedWithMeRow): string {
    if (!share.repair_needed) return '';
    if (share.missing_key_wrap_count > 0) {
      const noun = share.missing_key_wrap_count === 1 ? 'access wrap' : 'access wraps';
      return `${share.missing_key_wrap_count} missing ${noun}`;
    }
    return 'repair needed';
  }

  function labelText(value: string): string {
    return value
      .split('_')
      .map((part) => part ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part)
      .join(' ');
  }
</script>

{#if shares.length > 0 || standalone}
  <section class={standalone ? '' : 'mx-3 mt-3 rounded border border-surface-2 bg-surface-1/70'} data-testid="shared-with-me-panel">
    {#if !standalone}
      <div class="h-11 px-4 flex items-center gap-2 border-b border-surface-2 bg-surface-1/70">
        <span class="i-lucide-users text-accent"></span>
        <span class="text-sm font-medium text-text-2">Shared with me</span>
      </div>
    {/if}
    {#if shares.length === 0}
      <div class="flex flex-col items-center gap-3 px-4 py-16 text-center text-sm text-text-3">
        <span class="i-lucide-users text-4xl"></span>
        Folders and documents people share with you show up here.
      </div>
    {/if}
    {#each shares as share (share.share_id)}
      {@const documentIcon = documentKindInfo(sharedDocumentName(share))?.icon}
      {@const sharedBy = owner(share.share_id)}
      <div class="flex items-center border-b border-surface-2 hover:bg-surface-2/50" data-testid="shared-with-me-row">
        <a
          href={sharedItemHref(share.share_id, share.source_path)}
          class="min-w-0 flex-1 flex items-center gap-3 p-3 lg:px-5 no-underline text-text-1"
          data-testid="shared-with-me-open"
        >
          <span class="shrink-0 {documentIcon ?? 'i-lucide-folder text-warning'}"></span>
          <span class="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
            <span class="block truncate sm:flex-1" title={share.display_name}>{share.display_name}</span>
            <span class="block truncate text-xs text-text-3 sm:shrink-0 sm:text-sm">{detailText(share)}</span>
          </span>
        </a>
        {#if sharedBy}
          <a
            class="shrink-0 max-w-32 truncate text-xs text-text-3 no-underline hover:underline mr-3 lg:mr-5"
            href={sharedBy.href}
            title="Shared by {sharedBy.name}"
            data-testid="shared-with-me-owner"
          >{sharedBy.name}</a>
        {/if}
        {#if usingNative && share.shortcut_paths.length === 0}
          <button
            class="btn-circle btn-ghost shrink-0 mr-3 lg:mr-5"
            title="Add shortcut to My Drive"
            aria-label="Add shortcut to My Drive"
            data-testid="shared-with-me-add-shortcut"
            disabled={Boolean(shareActionPending)}
            onclick={() => handleAddShortcut(share.share_id)}
          >
            <span class="i-lucide-plus text-base"></span>
          </button>
        {:else if usingNative}
          <span class="i-lucide-check text-success shrink-0 mr-3 lg:mr-5" title="Shortcut added"></span>
        {/if}
      </div>
    {/each}
    {#if standalone && removed.length > 0}
      <div class="mt-8" data-testid="shared-with-me-removed-section">
        <h2 class="px-4 lg:px-5 pb-2 text-xs font-medium text-text-3">Removed from</h2>
        {#each removed as share (share.share_id)}
          {@const documentIcon = documentKindInfo(sharedDocumentName(share))?.icon}
          <div
            class="flex items-center gap-3 px-4 py-2 lg:px-5 border-t border-surface-2 text-sm text-text-3"
            title="You no longer have access"
            data-testid="shared-with-me-removed"
          >
            <span class="shrink-0 opacity-70 {documentIcon ?? 'i-lucide-folder'}"></span>
            <span class="min-w-0 flex-1 truncate">{share.display_name}</span>
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}
