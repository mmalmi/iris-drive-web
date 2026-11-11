<script lang="ts">
  /**
   * Invite people to a folder or document: one link, and the list of people
   * who have joined with it.
   */
  import CopyText from '@iris/svelte-ui/CopyText.svelte';
  import { nostrStore } from '../nostr';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';
  import { projectSharedFolderView, type ShareRole } from '../drive/protocol';
  import { acceptedShares } from '../drive/shareLibrary';
  import type { SharePeopleTarget } from '../drive/sharePeople';
  import {
    changeShareMemberRole,
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

  function create() {
    if (target.kind !== 'drive') return;
    const { path, name } = target;
    void run(async () => {
      createdShareId = (await shareFromDrive(path, name)).share_id;
    });
  }

  function changeRole(memberProfileId: string, event: Event) {
    const role = (event.currentTarget as HTMLSelectElement).value as ShareRole;
    void run(() => changeShareMemberRole(shareId, memberProfileId, role));
  }
</script>

<div class="p-4 space-y-4" data-testid="share-people">
  {#if !record}
    <p class="text-sm text-text-2">
      Invite people to work on “{target.kind === 'drive' ? target.name : 'this folder'}” with you.
    </p>
    <button class="btn-primary w-full" disabled={busy || target.kind !== 'drive'} onclick={create} data-testid="share-people-create">
      <span class={busy ? 'i-lucide-loader-2 animate-spin' : 'i-lucide-link'}></span>
      Create invite link
    </button>
  {:else if view?.can_admin}
    <label class="flex items-center gap-2 text-sm text-text-2">
      Anyone with the link
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

    <div class="divide-y divide-surface-2" data-testid="share-people-list">
      {#each people as member (member.profile_id)}
        <div class="py-2 flex items-center gap-3" data-testid="share-people-member">
          <span class="i-lucide-user-round text-text-3"></span>
          <span class="min-w-0 flex-1 text-sm text-text-1 truncate">
            {member.display_name}{member.profile_id === profileId ? ' (you)' : ''}
          </span>
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
  {:else}
    <p class="text-sm text-text-2">Only the owner can invite people to this folder.</p>
    <div class="divide-y divide-surface-2">
      {#each people as member (member.profile_id)}
        <div class="py-2 flex items-center gap-3">
          <span class="i-lucide-user-round text-text-3"></span>
          <span class="min-w-0 flex-1 text-sm text-text-1 truncate">{member.display_name}</span>
          <span class="text-xs text-text-3">{member.role_label}</span>
        </div>
      {/each}
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
