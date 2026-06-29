<script lang="ts">
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
    acceptShareInvite,
    addShareShortcut,
    projectAcceptedShareViews,
  } from '../drive/shareLibrary';
  import { toast } from '../stores/toast';

  interface Props {
    payload: string;
  }

  let { payload }: Props = $props();

  let invite = $derived(`${SHARE_INVITE_PREFIX}${payload}`);
  let nativeActionEndpoint = $derived(nativeShareActionEndpoint());
  let shareActionPending = $state(false);
  let parsed = $derived.by((): { bundle: ShareInviteBundle; view: SharedFolderView } | null => {
    try {
      const bundle = parseShareInvite(payload);
      return {
        bundle,
        view: projectSharedFolderView(bundle.shared_folder, [], ''),
      };
    } catch {
      return null;
    }
  });

  let displayName = $derived(parsed?.view.display_name || 'Shared folder');
  let memberCount = $derived(parsed?.view.members.filter((member) => member.status === 'active').length ?? 0);
  let recipientMember = $derived.by(() => {
    if (!parsed) return null;
    return parsed.view.members.find((member) => (
      member.profile_id === parsed.bundle.recipient_profile_id
    )) ?? null;
  });
  let localAcceptedShare = $derived.by(() => {
    if (!parsed) return null;
    return projectAcceptedShareViews($acceptedShares)
      .find((share) => share.share_id === parsed.bundle.shared_folder.share_id) ?? null;
  });
  let acceptedView = $derived.by((): NativeSharedFolderView | SharedFolderView | null => {
    if (!parsed) return null;
    if (nativeActionEndpoint) {
      return $nativeShareStore.find((share) => share.share_id === parsed.bundle.shared_folder.share_id) ?? null;
    }
    return localAcceptedShare?.view ?? null;
  });
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
        acceptShareInvite(invite);
      }
      toast.success('Share accepted');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not accept share invite');
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
      } else {
        addShareShortcut(parsed.bundle.shared_folder.share_id);
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
            <p class="text-sm text-text-3">{parsed.bundle.role} access · {memberCount} people</p>
          </div>
        </div>

        <div class="rounded-lg border border-surface-2 bg-surface-1 p-3 space-y-2">
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm font-medium text-text-2">Invite</span>
            <a class="btn-ghost text-sm no-underline" href={invite}>
              <span class="i-lucide-external-link"></span>
              Open
            </a>
          </div>
          <CopyText text={invite} truncate={96} class="text-sm" testId="share-invite-copy" />
        </div>

        <div class="rounded-lg border border-surface-2 bg-surface-1 p-3 flex items-center gap-3">
          <div class="min-w-0 flex-1">
            <div class="text-sm font-medium text-text-2">
              {acceptedView ? 'Accepted' : 'Ready to accept'}
            </div>
            <div class="text-xs text-text-3 truncate">
              {inviteDetail}
            </div>
          </div>
          {#if acceptedView}
            {#if acceptedView.shortcut_paths.length === 0}
              <button class="btn-primary text-sm" data-testid="share-invite-add-shortcut" disabled={shareActionPending} onclick={handleAddShortcut}>
                <span class="i-lucide-plus"></span>
                Shortcut
              </button>
            {:else}
              <span class="i-lucide-check text-success" title="Shortcut added"></span>
            {/if}
          {:else}
            <button class="btn-primary text-sm" data-testid="share-invite-accept" disabled={shareActionPending} onclick={handleAcceptInvite}>
              <span class="i-lucide-check"></span>
              Accept
            </button>
          {/if}
        </div>

        <div class="space-y-2">
          <h2 class="text-sm font-semibold text-text-2">Members</h2>
          {#each parsed.view.members as member (member.profile_id)}
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
            {parsed.view.key_status_label || parsed.view.key_status}
            {#if parsed.view.repair_needed}
              · repair needed
            {/if}
          </div>
        </div>
      </section>
    {:else}
      <section class="space-y-3">
        <div class="flex items-center gap-3">
          <span class="i-lucide-circle-alert text-3xl text-warning"></span>
          <h1 class="text-xl font-semibold text-text-1">Invalid share invite</h1>
        </div>
      </section>
    {/if}
  </div>
</div>
