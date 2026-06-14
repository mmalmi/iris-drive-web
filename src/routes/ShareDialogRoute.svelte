<script lang="ts">
  import CopyText from '../components/CopyText.svelte';
  import { currentFullHash } from '../lib/router.svelte';
  import {
    parseShareDialogPath,
    shareDialogRequestWithRecipientHint,
  } from '../drive/shareDialog';
  import {
    searchShareContacts,
    type RankedShareContact,
  } from '../drive/shareContactSearch';
  import {
    nativeShareActionEndpoint,
    type NativeShareMemberView,
    type NativeSharedFolderView,
  } from '../drive/nativeShareActions';
  import {
    applyNativeShareActionResult,
    nativeShares as nativeShareStore,
  } from '../drive/nativeShareState';
  import type { ShareRole } from '../drive/protocol';
  import {
    createShareWithOptionalRecipientEvidence,
    repairShareKeyWraps,
    revokeShareMember,
    setShareMemberRole,
  } from '../drive/shareDialogActions';

  let fullHash = $derived($currentFullHash);
  let request = $derived(parseShareDialogPath(fullHash));
  let nativeActionEndpoint = $derived(nativeShareActionEndpoint());
  let recipientSearch = $state('');
  let recipientResults = $state<RankedShareContact[]>([]);
  let selectedRecipient = $state<RankedShareContact | null>(null);
  let contactSearchPending = $state(false);
  let contactSearchToken = 0;
  let shareActionPending = $state(false);
  let shareActionError = $state('');
  let createdShareId = $state('');
  let handoffRequest = $derived(
    request
      ? shareDialogRequestWithRecipientHint(
        request,
        selectedRecipient
          ? {
            representative_npub: selectedRecipient.representative_npub,
            display_name: selectedRecipient.display_name,
            iris_profile_id: selectedRecipient.iris_profile_id,
          }
          : null,
      )
      : null,
  );
  let folderName = $derived.by(() => {
    if (!request) return 'Shared folder';
    if (request.display_name) return request.display_name;
    const lastPathPart = request.source_path.split('/').filter(Boolean).at(-1);
    return lastPathPart || 'Shared folder';
  });
  let createdShare = $derived(
    $nativeShareStore.find((share) => share.share_id === createdShareId) ?? null,
  );
  let createButtonLabel = $derived.by(() => {
    if (shareActionPending) return selectedRecipient ? 'Inviting' : 'Creating';
    return selectedRecipient ? 'Create and invite' : 'Create';
  });

  $effect(() => {
    const query = recipientSearch.trim();
    const token = ++contactSearchToken;
    if (!query || query === selectedRecipient?.display_name) {
      recipientResults = [];
      contactSearchPending = false;
      return;
    }

    contactSearchPending = true;
    const timer = setTimeout(() => {
      searchShareContacts(query, { limit: 6 })
        .then((results) => {
          if (token === contactSearchToken) {
            recipientResults = results;
            contactSearchPending = false;
          }
        })
        .catch(() => {
          if (token === contactSearchToken) {
            recipientResults = [];
            contactSearchPending = false;
          }
        });
    }, 120);

    return () => clearTimeout(timer);
  });

  function handleRecipientInput(event: Event) {
    const value = (event.currentTarget as HTMLInputElement).value;
    recipientSearch = value;
    if (selectedRecipient && value !== selectedRecipient.display_name) {
      selectedRecipient = null;
    }
  }

  function selectRecipient(contact: RankedShareContact) {
    selectedRecipient = contact;
    recipientSearch = contact.display_name;
    recipientResults = [];
  }

  function clearRecipient() {
    selectedRecipient = null;
    recipientSearch = '';
    recipientResults = [];
  }

  async function handleCreateShare() {
    if (!request || shareActionPending) return;
    shareActionPending = true;
    shareActionError = '';
    try {
      const mutation = await createShareWithOptionalRecipientEvidence(
        request,
        folderName,
        selectedRecipient,
      );
      applyNativeShareActionResult(mutation.result);
      createdShareId = mutation.share_id;
    } catch (error) {
      shareActionError = error instanceof Error ? error.message : String(error);
    } finally {
      shareActionPending = false;
    }
  }

  async function handleRepairShare() {
    if (!createdShare || shareActionPending) return;
    shareActionPending = true;
    shareActionError = '';
    try {
      const result = await repairShareKeyWraps(createdShare.share_id);
      applyNativeShareActionResult(result);
      createdShareId = result.share_id ?? createdShare.share_id;
    } catch (error) {
      shareActionError = error instanceof Error ? error.message : String(error);
    } finally {
      shareActionPending = false;
    }
  }

  async function handleRevokeMember(profileId: string) {
    if (!createdShare || shareActionPending) return;
    shareActionPending = true;
    shareActionError = '';
    try {
      const result = await revokeShareMember(createdShare.share_id, profileId);
      applyNativeShareActionResult(result);
      createdShareId = result.share_id ?? createdShare.share_id;
    } catch (error) {
      shareActionError = error instanceof Error ? error.message : String(error);
    } finally {
      shareActionPending = false;
    }
  }

  async function handleSetMemberRole(profileId: string, role: ShareRole) {
    if (!createdShare || shareActionPending) return;
    shareActionPending = true;
    shareActionError = '';
    try {
      const result = await setShareMemberRole(createdShare.share_id, profileId, role);
      applyNativeShareActionResult(result);
      createdShareId = result.share_id ?? createdShare.share_id;
    } catch (error) {
      shareActionError = error instanceof Error ? error.message : String(error);
    } finally {
      shareActionPending = false;
    }
  }

  function handleRoleSelect(profileId: string, event: Event) {
    const role = (event.currentTarget as HTMLSelectElement).value as ShareRole;
    void handleSetMemberRole(profileId, role);
  }

  function shareRoleLabel(share: NativeSharedFolderView) {
    return share.local_role_label || share.role_label || statusText(share.local_role);
  }

  function shareKeyStatusLabel(share: NativeSharedFolderView) {
    return share.key_status_label || statusText(share.key_status);
  }

  function shareRepairText(share: NativeSharedFolderView) {
    if (!share.repair_needed && share.missing_key_wrap_count === 0) return '';
    if (share.missing_key_wrap_count > 0) {
      const noun = share.missing_key_wrap_count === 1 ? 'access wrap' : 'access wraps';
      return `${share.missing_key_wrap_count} missing ${noun}`;
    }
    return 'Repair needed';
  }

  function shareMemberDisplayName(member: NativeShareMemberView) {
    return member.display_name || 'IrisProfile';
  }

  function shareMemberDetail(member: NativeShareMemberView) {
    const role = member.role_label || statusText(member.role);
    const status = member.status_label || statusText(member.status);
    const identity = member.representative_npub_hint || member.profile_id;
    return `${role} · ${status} · ${identity}`;
  }

  function pendingInviteDetail(invite: NonNullable<NativeSharedFolderView['pending_invites']>[number]) {
    const role = invite.role_label || statusText(invite.role);
    const status = invite.status_label || statusText(invite.status);
    return `${role} · ${status} · ${invite.representative_npub_hint}`;
  }

  function statusText(value: string) {
    return value.split('_').map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part).join(' ');
  }
</script>

<div class="flex-1 overflow-auto bg-surface-0">
  <div class="max-w-2xl mx-auto px-4 py-6 space-y-5">
    {#if request}
      <section class="space-y-4">
        <div class="flex items-center gap-3">
          <span class="i-lucide-folder-key text-3xl text-accent"></span>
          <div class="min-w-0">
            <h1 class="text-xl font-semibold text-text-1 truncate">{folderName}</h1>
            <p class="text-sm text-text-3 truncate">{request.source_path}</p>
          </div>
        </div>

        <div class="rounded-lg border border-surface-2 bg-surface-1 p-3 space-y-3">
          <label class="text-sm font-medium text-text-2" for="share-recipient-search">Recipient</label>
          <div class="relative">
            <span class="i-lucide-search absolute left-3 top-1/2 -translate-y-1/2 text-text-3 text-sm"></span>
            <input
              id="share-recipient-search"
              class="input w-full pl-9"
              value={recipientSearch}
              placeholder="Search recipient"
              data-testid="share-dialog-recipient-search"
              oninput={handleRecipientInput}
            />
          </div>

          {#if selectedRecipient}
            <div class="flex items-center gap-3">
              <span class="i-lucide-user-round text-text-3"></span>
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium text-text-1 truncate">{selectedRecipient.display_name}</div>
                <div class="text-xs text-text-3 truncate">{selectedRecipient.representative_npub}</div>
              </div>
              <button
                class="btn-ghost h-8 w-8 min-h-8 min-w-8 p-0"
                title="Clear recipient"
                aria-label="Clear recipient"
                onclick={clearRecipient}
              >
                <span class="i-lucide-x text-base"></span>
              </button>
            </div>
          {:else if recipientResults.length > 0}
            <div class="divide-y divide-surface-2" data-testid="share-dialog-recipient-results">
              {#each recipientResults as contact (contact.representative_npub)}
                <button
                  class="w-full px-0 py-2 flex items-center gap-3 text-left hover:text-accent"
                  data-testid="share-dialog-recipient-result"
                  onclick={() => selectRecipient(contact)}
                >
                  <span class="i-lucide-user-round text-text-3"></span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium text-text-1 truncate">{contact.display_name}</span>
                    <span class="block text-xs text-text-3 truncate">{contact.representative_npub}</span>
                  </span>
                </button>
              {/each}
            </div>
          {:else if contactSearchPending}
            <div class="text-xs text-text-3">Searching</div>
          {/if}
        </div>

        <div class="rounded-lg border border-surface-2 bg-surface-1 p-3 space-y-3">
          <div class="flex items-center gap-3">
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-text-2">Create share</div>
              {#if nativeActionEndpoint}
                {#if createdShare}
                  <div class="text-xs text-text-3 truncate" data-testid="share-dialog-created-share">
                    {shareRoleLabel(createdShare)} · {shareKeyStatusLabel(createdShare)}
                  </div>
                {:else}
                  <div class="text-xs text-text-3 truncate">{request.source_path}</div>
                {/if}
              {:else}
                <CopyText text={handoffRequest?.app_url ?? request.app_url} truncate={72} class="text-xs" testId="share-dialog-copy-native-url" />
              {/if}
            </div>
            {#if nativeActionEndpoint}
              <button
                class="btn-primary text-sm"
                data-testid="share-dialog-create-share"
                disabled={shareActionPending}
                onclick={handleCreateShare}
              >
                <span class="i-lucide-folder-plus"></span>
                {createButtonLabel}
              </button>
            {:else}
              <a class="btn-primary text-sm no-underline" href={handoffRequest?.app_url ?? request.app_url} data-testid="share-dialog-open-native">
                <span class="i-lucide-external-link"></span>
                Open
              </a>
            {/if}
          </div>

          {#if createdShare}
            {#if createdShare.repair_needed}
              <div class="flex items-center gap-3 rounded bg-warning/10 px-3 py-2">
                <span class="i-lucide-wrench text-warning shrink-0"></span>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium text-text-1">Access repair needed</div>
                  <div class="text-xs text-text-3">
                    {shareRepairText(createdShare)}
                  </div>
                </div>
                {#if createdShare.can_admin}
                  <button
                    class="btn-ghost text-sm"
                    data-testid="share-dialog-repair-wraps"
                    disabled={shareActionPending}
                    onclick={handleRepairShare}
                  >
                    <span class="i-lucide-wrench"></span>
                    Repair
                  </button>
                {/if}
              </div>
            {/if}
            <div class="divide-y divide-surface-2">
              {#each createdShare.members as member (member.profile_id)}
                <div class="py-2 flex items-center gap-3" data-testid="share-dialog-member-row">
                  <span class="i-lucide-user-round text-text-3"></span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium text-text-1 truncate">{shareMemberDisplayName(member)}</span>
                    <span class="block text-xs text-text-3 truncate">{shareMemberDetail(member)}</span>
                  </span>
                  {#if member.can_change_role}
                    <select
                      class="select select-sm w-28"
                      value={member.role}
                      data-testid="share-dialog-member-role"
                      disabled={shareActionPending}
                      onchange={(event) => handleRoleSelect(member.profile_id, event)}
                    >
                      <option value="reader">Reader</option>
                      <option value="editor">Editor</option>
                      <option value="admin">Admin</option>
                    </select>
                  {/if}
                  {#if member.can_revoke}
                    <button
                      class="btn-ghost h-8 w-8 min-h-8 min-w-8 p-0 text-danger"
                      title="Remove from share"
                      aria-label="Remove from share"
                      data-testid="share-dialog-revoke-member"
                      disabled={shareActionPending}
                      onclick={() => handleRevokeMember(member.profile_id)}
                    >
                      <span class="i-lucide-user-minus text-base"></span>
                    </button>
                  {/if}
                </div>
              {/each}
              {#each createdShare.pending_invites ?? [] as invite (invite.representative_npub_hint)}
                <div class="py-2 flex items-center gap-3" data-testid="share-dialog-pending-invite-row">
                  <span class="i-lucide-user-plus text-text-3"></span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-sm font-medium text-text-1 truncate">{invite.display_name}</span>
                    <span class="block text-xs text-text-3 truncate">{pendingInviteDetail(invite)}</span>
                  </span>
                </div>
              {/each}
            </div>
          {/if}

          {#if shareActionError}
            <div class="text-xs text-danger" data-testid="share-dialog-action-error">{shareActionError}</div>
          {/if}

          {#if nativeActionEndpoint}
            <div class="flex justify-end">
              <a class="btn-ghost text-sm no-underline" href={handoffRequest?.app_url ?? request.app_url} data-testid="share-dialog-open-native">
                <span class="i-lucide-external-link"></span>
                Open
              </a>
            </div>
          {/if}
        </div>
      </section>
    {:else}
      <section class="space-y-3">
        <div class="flex items-center gap-3">
          <span class="i-lucide-circle-alert text-3xl text-warning"></span>
          <h1 class="text-xl font-semibold text-text-1">Folder required</h1>
        </div>
      </section>
    {/if}
  </div>
</div>
