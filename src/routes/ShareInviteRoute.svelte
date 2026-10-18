<script lang="ts">
  import { resolveShareInvite } from '../drive/shareLinks';
  import CopyText from '@iris/svelte-ui/CopyText.svelte';
  import {
    SHARE_INVITE_PREFIX,
    parseShareInvite,
    projectSharedFolderView,
    type ShareInviteBundle,
    type SharedFolderView,
  } from '../drive/protocol';
  import {
    nativeShareActionEndpoint,
    type NativeSharedFolderView,
  } from '../drive/nativeShareActions';
  import {
    applyNativeShareActionResult,
    nativeShares as nativeShareStore,
    refreshNativeShareState,
  } from '../drive/nativeShareState';
  import {
    acceptShareInviteThroughCore,
    addShareShortcutThroughCore,
  } from '../drive/shareInviteActions';
  import {
    acceptedShares,
    acceptShareInviteForProfile,
    projectAcceptedShareViews,
  } from '../drive/shareLibrary';
  import { toast } from '../stores/toast';
  import { nostrStore } from '../nostr';
  import { activeNostrIdentityRootScope } from '../drive/profileRoute';

  interface Props {
    payload: string;
  }

  let { payload }: Props = $props();

  let invite = $derived(`${SHARE_INVITE_PREFIX}${payload}`);
  let webInvite = $derived(`https://drive.iris.to/#/share-invite/${payload}`);
  let nativeActionEndpoint = $derived(nativeShareActionEndpoint());
  let shareActionPending = $state(false);
  let resolvedInvite = $state('');
  let loading = $state(true);
  let loadError = $state('');
  let parsed = $state<{ bundle: ShareInviteBundle; view: SharedFolderView } | null>(null);
  $effect(() => {
    const input = payload;
    const controller = new AbortController();
    loading = true;
    loadError = '';
    parsed = null;
    void resolveShareInvite(input, controller.signal).then((resolved) => {
      if (controller.signal.aborted) return;
      resolvedInvite = resolved;
      const bundle = parseShareInvite(resolved);
      parsed = { bundle, view: projectSharedFolderView(bundle.shared_folder, [], '') };
    }).catch((error) => {
      if (!controller.signal.aborted) loadError = error instanceof Error ? error.message : 'Could not load invite';
    }).finally(() => { if (!controller.signal.aborted) loading = false; });
    return () => controller.abort();
  });

  let displayName = $derived(parsed?.view.display_name || 'Shared folder');
  let recipientMember = $derived.by(() => {
    if (!parsed) return null;
    return parsed.view.members.find((member) => (
      member.profile_id === parsed?.bundle.recipient_profile_id
    )) ?? null;
  });
  let localAcceptedShare = $derived.by(() => {
    if (!parsed) return null;
    return projectAcceptedShareViews($acceptedShares.filter((record) => record.local_profile_id === activeNostrIdentityRootScope($nostrStore)), $nostrStore.pubkey ?? undefined)
      .find((share) => share.share_id === parsed?.bundle.shared_folder.share_id) ?? null;
  });
  let acceptedView = $derived.by((): NativeSharedFolderView | SharedFolderView | null => {
    if (!parsed) return null;
    if (nativeActionEndpoint) {
      return $nativeShareStore.find((share) => share.share_id === parsed?.bundle.shared_folder.share_id) ?? null;
    }
    return localAcceptedShare?.view ?? null;
  });
  let currentView = $derived(acceptedView ?? parsed?.view);
  let accessRevoked = $derived(acceptedView?.key_status === 'revoked');
  let memberCount = $derived(currentView?.members.filter((member) => member.status === 'active').length ?? 0);
  let inviteDetail = $derived.by(() => {
    if (acceptedView?.shortcut_paths.length) {
      return acceptedView.shortcut_paths[0];
    }
    if (acceptedView) {
      return acceptedView.shared_with_me_path;
    }
    return recipientMember?.display_name || recipientMember?.representative_npub_hint || parsed?.view.shared_with_me_path || '';
  });

  $effect(() => {
    if (!nativeActionEndpoint) return;
    void refreshNativeShareState().catch(() => undefined);
  });

  async function handleAcceptInvite() {
    if (shareActionPending) return;
    shareActionPending = true;
    try {
      if (nativeActionEndpoint) {
        const result = await acceptShareInviteThroughCore(invite);
        applyNativeShareActionResult(result);
      } else {
        const profileId = activeNostrIdentityRootScope($nostrStore);
        if (profileId) {
          acceptShareInviteForProfile(resolvedInvite, profileId);
        } else {
          throw new Error('Sign in to the invited profile to accept this folder.');
        }
      }
      toast.success('Share accepted');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not accept share invite';
      toast.error(message.startsWith('share invite is not for NostrIdentity ')
        ? 'This invite is for another profile. Switch profiles to accept it.'
        : message);
    } finally {
      shareActionPending = false;
    }
  }

  async function handleAddShortcut() {
    if (!parsed || shareActionPending) return;
    shareActionPending = true;
    try {
      if (nativeActionEndpoint) {
        const result = await addShareShortcutThroughCore(parsed.bundle.shared_folder.share_id);
        applyNativeShareActionResult(result);
      }
      toast.success('Shortcut added');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not add shortcut');
    } finally {
      shareActionPending = false;
    }
  }
</script>

<div class="flex-1 overflow-auto bg-surface-0">
  <div class="max-w-3xl mx-auto px-4 py-6 space-y-5">
    {#if parsed}
      <section class="space-y-4">
        <div class="flex items-center gap-3">
          <span class="i-lucide-folder-key text-3xl text-accent"></span>
          <div class="min-w-0">
            <h1 class="text-xl font-semibold text-text-1 truncate">{displayName}</h1>
            <p class="text-sm text-text-3">{accessRevoked ? 'Access removed' : `${acceptedView?.local_role ?? parsed.bundle.role} access`} · {memberCount} people</p>
          </div>
        </div>

        <div class="rounded-lg border border-surface-2 bg-surface-1 p-3 space-y-2">
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium text-text-2">Invite</span>

          </div>
          <CopyText text={webInvite} truncate={96} class="text-sm" testId="share-invite-copy" />
        </div>

        <div class="rounded-lg border border-surface-2 bg-surface-1 p-3 flex items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-text-2">
              {accessRevoked ? 'You no longer have access to this folder.' : acceptedView ? 'Accepted' : 'Ready to accept'}
            </div>
            <div class="text-xs text-text-3 truncate">
              {inviteDetail}
            </div>
          </div>
          {#if acceptedView && !accessRevoked}
            <a class="btn-primary text-sm no-underline" data-testid="share-invite-open" href={`#/${acceptedView.share_id}/main`}>Open folder</a>
            {#if nativeActionEndpoint && acceptedView.shortcut_paths.length === 0}
              <button class="btn-primary text-sm" data-testid="share-invite-add-shortcut" disabled={shareActionPending} onclick={handleAddShortcut}>
                <span class="i-lucide-plus"></span>
                Shortcut
              </button>
            {:else if nativeActionEndpoint}
              <span class="i-lucide-check text-success" title="Shortcut added"></span>
            {/if}
          {:else if accessRevoked}
            <span class="i-lucide-lock-keyhole text-text-3" aria-label="Access removed"></span>
          {:else if !nativeActionEndpoint && !activeNostrIdentityRootScope($nostrStore)}
            <a class="btn-primary text-sm no-underline" href="#/users/existing">Sign in to accept</a>
          {:else}
            <button class="btn-primary text-sm" data-testid="share-invite-accept" disabled={shareActionPending} onclick={handleAcceptInvite}>
              <span class="i-lucide-check"></span>
              Accept
            </button>
          {/if}
        </div>

        <div class="space-y-2">
          <h2 class="text-sm font-semibold text-text-2">Members</h2>
          {#each currentView?.members ?? [] as member (member.profile_id)}
            <div class="rounded-lg border border-surface-2 bg-surface-1 px-3 py-2 flex items-center gap-3">
              <span class="i-lucide-user-round text-text-3"></span>
              <div class="min-w-0 flex-1">
                <div class="text-sm font-medium text-text-1 truncate">{member.display_name || 'NostrIdentity'}</div>
                <div class="text-xs text-text-3 truncate">
                  {member.role_label || member.role} · {member.status_label || member.status}
                  {#if member.representative_npub_hint}
                    · {member.representative_npub_hint}
                  {/if}
                </div>
              </div>
            </div>
          {/each}
        </div>

        <div class="rounded-lg border border-surface-2 bg-surface-1 p-3 space-y-2">
          <div class="text-sm font-medium text-text-2">Key status</div>
          <div class="text-sm text-text-3">
            {currentView?.key_status_label || currentView?.key_status}
            {#if currentView?.repair_needed}
              · repair needed
            {/if}
          </div>
        </div>
      </section>
    {:else if loading}
      <p class="text-text-3" role="status">Loading invite…</p>
    {:else}
      <section class="space-y-3">
        <div class="flex items-center gap-3">
          <span class="i-lucide-circle-alert text-3xl text-warning"></span>
          <h1 class="text-xl font-semibold text-text-1">Could not open invite</h1>
        </div>
        <p class="text-sm text-text-3">{loadError}</p>
      </section>
    {/if}
  </div>
</div>
