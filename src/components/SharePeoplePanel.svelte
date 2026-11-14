<script lang="ts">
  /**
   * Invite people to a folder or document: one link, a search to add someone
   * directly, and the list of people who have access.
   */
  import CopyText from '@iris/svelte-ui/CopyText.svelte';
  import { nostrStore } from '../nostr';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { projectSharedFolderView, type ShareRole } from '../drive/protocol';
  import { acceptedShares } from '../drive/shareLibrary';
  import type { SharePeopleTarget } from '../drive/sharePeople';
  import { memberNpub, npubPubkey, personHref } from '../drive/people';
  import type { RankedShareContact } from '../drive/shareContactSearch';
  import { getProfileName, getProfileSync } from '../stores/profile';
  import { refreshSocialGraph } from '../lib/socialGraphRefresh';
  import { close as closeShareDialog } from './Modals/ShareModal.svelte';
  import { Avatar } from './User';
  import PersonName from './User/PersonName.svelte';
  import { linkShareOf, linkShares, linkShareUrl, type LinkAccess } from '../drive/linkShares';
  import {
    addPersonToShare,
    changeShareMemberRole,
    NoDevicesFoundError,
    disableJoinLinks,
    joinLinkUrl,
    removeShareMember,
    shareFromDrive,
  } from '../drive/shareOwner';

  interface Props {
    target: SharePeopleTarget;
  }

  let { target }: Props = $props();

  let createdShareId = $state('');
  let linkRole = $state<'editor' | 'reader'>('editor');
  let busy = $state(false);
  let error = $state('');

  let profileId = $derived(activeNostrIdentityRootScope($nostrStore));
  let shareId = $derived(target.kind === 'share' ? target.shareId : createdShareId);
  let record = $derived($acceptedShares.find((item) => item.share_id === shareId && item.local_profile_id === profileId) ?? null);
  let view = $derived(record ? projectSharedFolderView(record.folder, [], $nostrStore.pubkey ?? '') : null);
  let link = $state('');
  // Making the link on first use stores it, so this runs as an effect, not a derivation.
  $effect(() => {
    if (!record || !view?.can_admin) {
      link = '';
      return;
    }
    try {
      link = joinLinkUrl(record.share_id, linkRole, { doc: target.kind === 'share' ? target.doc : undefined });
    } catch {
      link = '';
    }
  });
  let people = $derived((view?.members ?? []).filter((member) => member.status !== 'revoked'));

  // General access: who can open it by its link, without being added.
  let general = $derived(target.kind === 'drive' ? linkShareOf(target.path, profileId, $linkShares) : null);
  let generalAccess = $derived<LinkAccess | 'off'>(general?.access ?? 'off');
  let generalBusy = $state(false);
  let generalError = $state('');
  const GENERAL_HINT: Record<LinkAccess | 'off', string> = {
    off: 'Only people added can open it',
    link: 'Anyone with the link can view it, without an account',
    public: 'Anyone can find it and view it',
  };
  const GENERAL_ICON: Record<LinkAccess | 'off', string> = { off: 'i-lucide-lock', link: 'i-lucide-link', public: 'i-lucide-globe' };

  async function changeGeneral(event: Event) {
    if (target.kind !== 'drive' || generalBusy) return;
    const access = (event.currentTarget as HTMLSelectElement).value as LinkAccess | 'off';
    generalBusy = true;
    generalError = '';
    try {
      const { setLinkAccess } = await import('../drive/linkShareSync');
      await setLinkAccess(target.path, access);
    } catch (cause) {
      generalError = cause instanceof Error ? cause.message : 'Could not change who can open it';
    } finally {
      generalBusy = false;
    }
  }

  async function run(action: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      await action();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Something went wrong';
    } finally {
      busy = false;
    }
  }

  let sharing: Promise<string> | null = null;
  /** The shared folder's id, sharing the folder or document first if it is not shared yet. */
  function shared(): Promise<string> {
    if (shareId) return Promise.resolve(shareId);
    if (target.kind !== 'drive') return Promise.reject(new Error('Could not share this'));
    const { path, name } = target;
    sharing ??= shareFromDrive(path, name).then((record) => (createdShareId = record.share_id), (cause) => {
      sharing = null;
      throw cause;
    });
    return sharing;
  }

  function create() {
    void run(async () => {
      await shared();
    });
  }

  function changeRole(memberProfileId: string, event: Event) {
    const role = (event.currentTarget as HTMLSelectElement).value as ShareRole;
    void run(() => changeShareMemberRole(shareId, memberProfileId, role));
  }

  function memberPubkey(memberProfileId: string): string | null {
    const npub = record ? memberNpub(record.folder, memberProfileId) : null;
    return npub ? npubPubkey(npub) : null;
  }

  // Adding a person directly, found by name or key.
  let query = $state('');
  let addRole = $state<'editor' | 'reader'>('editor');
  let found = $state<RankedShareContact[]>([]);
  let searching = $state(false);
  let adding = $state<Array<{ pubkey: string; name: string; error: string }>>([]);
  let searchCode: Promise<typeof import('../drive/sharePeopleSearch')> | null = null;
  let inFolder = $derived(new Set([
    ...Object.values(record?.folder.access?.devices ?? {})
      .filter((device) => device.profile_id && people.some((member) => member.profile_id === device.profile_id))
      .map((device) => device.pubkey),
    ...people.map((member) => member.representative_npub_hint && npubPubkey(member.representative_npub_hint)).filter(Boolean),
  ]));
  let choices = $derived(found.filter((contact) => !inFolder.has(contact.pubkey)));

  $effect(() => {
    const text = query.trim();
    if (!text) {
      found = [];
      searching = false;
      return;
    }
    searching = true;
    let stop = () => {};
    const timer = setTimeout(() => {
      searchCode ??= import('../drive/sharePeopleSearch');
      void searchCode.then(({ searchPeopleToShare }) => {
        stop = searchPeopleToShare(text, (contacts, done) => {
          found = contacts;
          searching = !done;
        });
      });
    }, 150);
    return () => {
      clearTimeout(timer);
      stop();
    };
  });

  function add(contact: RankedShareContact) {
    if (adding.some((item) => item.pubkey === contact.pubkey && !item.error)) return;
    const name = getProfileName(getProfileSync(contact.pubkey)) || contact.display_name;
    adding = [...adding.filter((item) => item.pubkey !== contact.pubkey), { pubkey: contact.pubkey, name, error: '' }];
    query = '';
    void shared().then((id) => addPersonToShare(id, contact.pubkey, addRole, name)).then(() => {
      adding = adding.filter((item) => item.pubkey !== contact.pubkey);
    }, (cause) => {
      const message = cause instanceof NoDevicesFoundError
        ? `Could not find ${name}'s devices. Send them the invite link instead.`
        : cause instanceof Error ? cause.message : 'Could not add them';
      adding = adding.map((item) => item.pubkey === contact.pubkey ? { ...item, error: message } : item);
    });
  }
</script>

{#snippet addPeople()}
  <div class="space-y-2">
    <div class="flex gap-2">
      <div class="relative min-w-0 flex-1">
        <span class="i-lucide-search absolute left-3 top-1/2 -translate-y-1/2 text-sm text-text-3"></span>
        <input
          class="input w-full pl-9"
          bind:value={query}
          placeholder="Add people by name or npub"
          aria-label="Add people"
          autocomplete="off"
          onfocus={() => refreshSocialGraph()}
          data-testid="share-people-search"
        />
      </div>
      <select class="pick h-auto!" bind:value={addRole} aria-label="Access for people you add" data-testid="share-people-add-role">
        <option value="editor">Editor</option>
        <option value="reader">Reader</option>
      </select>
    </div>
    {#if choices.length > 0}
      <div class="rounded border border-surface-2 divide-y divide-surface-2" data-testid="share-people-results">
        {#each choices as contact (contact.pubkey)}
          <button
            class="w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-surface-2"
            onclick={() => add(contact)}
            data-testid="share-people-result"
          >
            <Avatar pubkey={contact.pubkey} size={28} />
            <span class="min-w-0 flex-1">
              <span class="block text-sm text-text-1 truncate"><PersonName pubkey={contact.pubkey} known={contact.display_name} /></span>
              <span class="block text-xs text-text-3 truncate">{contact.follow_distance === 1 ? 'You follow them' : contact.representative_npub.slice(0, 20) + '…'}</span>
            </span>
            <span class="i-lucide-user-plus text-text-3 shrink-0"></span>
          </button>
        {/each}
      </div>
    {:else if query.trim()}
      <p class="text-xs text-text-3">{searching ? 'Searching…' : 'Nobody found. Paste their npub, or send the invite link.'}</p>
    {/if}
  </div>
{/snippet}

<div class="p-4 space-y-4" data-testid="share-people">
  {#if !record}
    <p class="text-sm text-text-2">
      Invite people to work on “{target.kind === 'drive' ? target.name : 'this folder'}” with you.
    </p>
    {@render addPeople()}
    <button class="btn-ghost w-full" disabled={busy || target.kind !== 'drive'} onclick={create} data-testid="share-people-create">
      <span class={busy ? 'i-lucide-loader-2 animate-spin' : 'i-lucide-link'}></span>
      Create invite link
    </button>
  {:else if view?.can_admin}
    <label class="flex items-center gap-2 text-sm text-text-2">
      People who join with the link
      <select class="pick" bind:value={linkRole} aria-label="Link access" data-testid="share-people-role">
        <option value="editor">can edit</option>
        <option value="reader">can view</option>
      </select>
    </label>
    <div class="bg-surface-2 p-3 rounded">
      <CopyText text={link} truncate={40} class="text-sm" testId="share-people-link" />
    </div>
    <div class="flex items-center gap-2">
      <p class="flex-1 text-xs text-text-3">People are added while Drive is open on this device.</p>
      <button
        class="btn-ghost text-xs"
        title="The current link stops working. People who already joined keep their access."
        disabled={busy}
        data-testid="share-people-reset"
        onclick={() => disableJoinLinks(shareId)}
      >
        Reset link
      </button>
    </div>

    {@render addPeople()}
  {:else}
    <p class="text-sm text-text-2">Only the owner can invite people to this folder.</p>
  {/if}

  {#if record}
    <div class="divide-y divide-surface-2" data-testid="share-people-list">
      {#each adding as item (item.pubkey)}
        <div class="py-2 flex items-center gap-3" data-testid="share-people-adding">
          <Avatar pubkey={item.pubkey} size={20} />
          <span class="min-w-0 flex-1">
            <span class="block text-sm text-text-1 truncate">{item.name}</span>
            {#if item.error}
              <span class="block text-xs text-danger" data-testid="share-people-adding-error">{item.error}</span>
            {/if}
          </span>
          {#if item.error}
            <button
              class="btn-ghost h-8 w-8 min-h-8 min-w-8 p-0"
              aria-label="Dismiss"
              onclick={() => { adding = adding.filter((other) => other.pubkey !== item.pubkey); }}
            >
              <span class="i-lucide-x text-base"></span>
            </button>
          {:else}
            <span class="text-xs text-text-3">Adding…</span>
          {/if}
        </div>
      {/each}
      {#each people as member (member.profile_id)}
        {@const pubkey = memberPubkey(member.profile_id)}
        <div class="py-2 flex items-center gap-3" data-testid="share-people-member">
          {#if pubkey}
            <Avatar {pubkey} size={20} />
          {:else}
            <span class="i-lucide-user-round text-text-3"></span>
          {/if}
          {#if member.profile_id === profileId}
            <span class="min-w-0 flex-1 text-sm text-text-1 truncate">{member.display_name} (you)</span>
          {:else}
            <a
              class="min-w-0 flex-1 text-sm text-text-1 truncate no-underline hover:underline"
              href={personHref(record.folder, member.profile_id)}
              onclick={closeShareDialog}
              data-testid="share-people-member-link"
            >{member.display_name}</a>
          {/if}
          {#if member.can_change_role}
            <select
              class="pick"
              value={member.role}
              disabled={busy}
              aria-label={`Access for ${member.display_name}`}
              data-testid="share-people-member-role"
              onchange={(event) => changeRole(member.profile_id, event)}
            >
              <option value="reader">Reader</option>
              <option value="editor">Editor</option>
            </select>
          {:else}
            <span class="text-xs text-text-3">{member.role_label}</span>
          {/if}
          {#if member.can_revoke}
            <button
              class="btn-ghost h-8 w-8 min-h-8 min-w-8 p-0 text-danger"
              title="Remove"
              aria-label={`Remove ${member.display_name}`}
              disabled={busy}
              data-testid="share-people-remove"
              onclick={() => void run(() => removeShareMember(shareId, member.profile_id))}
            >
              <span class="i-lucide-user-minus text-base"></span>
            </button>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if target.kind === 'drive' && !record}
    <div class="space-y-2 border-t border-surface-2 pt-4" data-testid="general-access">
      <h3 class="text-sm font-medium text-text-1">General access</h3>
      <div class="flex items-center gap-3">
        <span class="{GENERAL_ICON[generalAccess]} text-lg text-text-2 shrink-0"></span>
        <select
          class="pick flex-1"
          value={generalAccess}
          disabled={generalBusy}
          aria-label="General access"
          data-testid="general-access-select"
          onchange={changeGeneral}
        >
          <option value="off">Restricted</option>
          <option value="link">Anyone with the link can view</option>
          <option value="public">Public</option>
        </select>
      </div>
      <p class="text-xs text-text-3">{GENERAL_HINT[generalAccess]}</p>
      {#if general && general.access !== 'off'}
        <div class="bg-surface-2 p-3 rounded">
          <CopyText text={linkShareUrl(general)} truncate={40} class="text-sm" testId="general-access-link" />
        </div>
      {/if}
      {#if generalError}
        <p class="text-xs text-danger" data-testid="general-access-error">{generalError}</p>
      {/if}
    </div>
  {/if}

  {#if error}
    <div class="text-xs text-danger" data-testid="share-people-error">{error}</div>
  {/if}
</div>

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
