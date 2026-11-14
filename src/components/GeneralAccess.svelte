<script lang="ts">
  /**
   * General access: who can open a folder, document or file by its link,
   * without being added. Where this device cannot change it, it only says
   * whether the item opens by link, and nothing when it does not.
   */
  import CopyText from '@iris/svelte-ui/CopyText.svelte';
  import MakePublicDialog from './Modals/MakePublicDialog.svelte';
  import { documentKindInfo, documentTitle } from '../lib/documentNames';
  import { nostrStore } from '../nostr';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { acceptedShares } from '../drive/shareLibrary';
  import {
    canSetLinkAccess,
    linkShareCovering,
    linkShareOf,
    linkShares,
    linkShareUrl,
    linkSubjectAt,
    type LinkAccess,
    type LinkTarget,
  } from '../drive/linkShares';

  interface Props {
    target: LinkTarget;
    /** What a link to a whole shared folder is named after. */
    name?: string;
    file?: boolean;
  }

  let { target, name, file = false }: Props = $props();
  let confirmation = $state<MakePublicDialog>();
  let itemName = $derived(target.path.at(-1) || name || 'Shared folder');
  let documentKind = $derived(file ? null : documentKindInfo(itemName));

  let profileId = $derived(activeNostrIdentityRootScope($nostrStore));
  let subject = $derived(linkSubjectAt(target, profileId, $acceptedShares));
  let own = $derived(subject ? linkShareOf(subject.path, profileId, $linkShares, subject.share) : null);
  let access = $derived<LinkAccess | 'off'>(own?.access ?? 'off');
  // Another account's link to a shared folder is theirs to change.
  let canChange = $derived(
    canSetLinkAccess(target, profileId, $nostrStore.pubkey, $acceptedShares) && (!own || own.profile === profileId),
  );
  /** The folder it is in that opens by link, when it has no link of its own, and its address through that link. */
  let through = $derived.by(() => {
    if (!subject || subject.path.length === 0 || access !== 'off') return null;
    const record = linkShareCovering(subject.path.slice(0, -1), profileId, $linkShares, subject.share);
    if (!record) return null;
    const inside = subject.path.slice(record.path ? record.path.split('/').length : 0);
    const known = record.access === 'public' || record.key !== '';
    return { record, url: known ? linkShareUrl(record, undefined, inside) : null };
  });
  let busy = $state(false);
  let error = $state('');

  const HINT: Record<LinkAccess | 'off', string> = {
    off: 'Only people added can open it',
    link: 'Anyone with the link can view it, without an account',
    public: 'Anyone can find it and view it',
  };
  const STATE: Record<LinkAccess, string> = { link: 'Anyone with the link can view', public: 'Anyone can find it and view it' };
  const ICON: Record<LinkAccess | 'off', string> = { off: 'i-lucide-lock', link: 'i-lucide-link', public: 'i-lucide-globe' };

  function change(event: Event) {
    const select = event.currentTarget as HTMLSelectElement;
    const value = select.value as LinkAccess | 'off';
    select.value = access;
    if (value === 'public') {
      select.focus();
      confirmation?.open();
    } else {
      void apply(value);
    }
  }

  async function apply(value: LinkAccess | 'off') {
    if (!subject || !canChange || busy || value === access) return;
    const selected = subject;
    const selectedName = name;
    busy = true;
    error = '';
    try {
      const { setLinkAccess } = await import('../drive/linkShareSync');
      await setLinkAccess(selected, value, selectedName);
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not change who can open it';
    } finally {
      busy = false;
    }
  }
</script>

{#snippet throughFolder()}
  {#if through}
    <p class="text-xs text-text-3" data-testid="general-access-through">
      Anyone with the link to “{through.record.tree}” can view it
    </p>
    {#if through.url && canChange}
      <div class="bg-surface-2 p-3 rounded">
        <CopyText text={through.url} truncate={40} class="text-sm" testId="general-access-through-link" />
      </div>
    {/if}
  {/if}
{/snippet}

{#if subject && canChange}
  <div class="space-y-2 border-t border-surface-2 pt-4" data-testid="general-access">
    <h3 class="text-sm font-medium text-text-1">General access</h3>
    <div class="flex items-center gap-3">
      <span class="{ICON[access]} text-lg text-text-2 shrink-0"></span>
      <select
        class="pick flex-1"
        value={access}
        disabled={busy}
        aria-label="General access"
        data-testid="general-access-select"
        onchange={change}
      >
        <option value="off">Restricted</option>
        <option value="link">Anyone with the link can view</option>
        <option value="public">Public</option>
      </select>
      {#key JSON.stringify([profileId, target.scope, target.path])}
        <MakePublicDialog
          bind:this={confirmation}
          name={file ? itemName : documentTitle(itemName)}
          item={file ? 'this file' : documentKind ? `this ${documentKind.noun}` : 'this folder and its contents'}
          onconfirm={() => void apply('public')}
        />
      {/key}
    </div>
    {#if through}
      {@render throughFolder()}
    {:else}
      <p class="text-xs text-text-3">{HINT[access]}</p>
    {/if}
    {#if own && own.access !== 'off'}
      <div class="bg-surface-2 p-3 rounded">
        <CopyText text={linkShareUrl(own)} truncate={40} class="text-sm" testId="general-access-link" />
      </div>
    {/if}
    {#if error}
      <p class="text-xs text-danger" data-testid="general-access-error">{error}</p>
    {/if}
  </div>
{:else if subject && (access !== 'off' || through)}
  <div class="space-y-2 border-t border-surface-2 pt-4" data-testid="general-access">
    <h3 class="text-sm font-medium text-text-1">General access</h3>
    {#if access !== 'off'}
      <p class="flex items-center gap-3 text-sm text-text-2" data-testid="general-access-state">
        <span class="{ICON[access]} text-lg shrink-0"></span>
        {STATE[access]}
      </p>
    {:else}
      {@render throughFolder()}
    {/if}
  </div>
{/if}

<style>
  .pick {
    height: 32px;
    padding: 0 8px;
    border: 1px solid rgb(var(--surface-3));
    border-radius: 6px;
    background: rgb(var(--surface-0));
    color: rgb(var(--text-1));
    font-size: 0.85rem;
    cursor: pointer;
  }
</style>
