<script lang="ts">
  import { onMount } from 'svelte';
  import IdentitySettingsPanel from '@iris/svelte-ui/IdentitySettingsPanel.svelte';
  import type { IdentitySettingsKey, IdentitySettingsPendingRequest } from '@iris/svelte-ui/identitySettings';
  import {
    activatePendingDriveDeviceLinkIfApproved,
    approveDriveDeviceLinkRequest,
    createDriveDeviceLinkInvite,
    getCurrentIrisIdentitySession,
    removeDriveProfileAppKeyWithAdmin,
    setDriveProfileAppKeyAdmin,
    subscribeDriveDeviceLinkRequests,
    type DriveDeviceLinkInvite,
    type DriveDeviceLinkRequest,
  } from '../../nostr';
  import { projectIrisProfileRoster, type IrisIdentitySession, type IrisProfileRosterProjection } from '../../drive/protocol';

  type PendingRequest = IdentitySettingsPendingRequest & DriveDeviceLinkRequest;

  let session = $state<IrisIdentitySession | null>(null);
  let projection = $state<IrisProfileRosterProjection | null>(null);
  let activeInvite = $state<DriveDeviceLinkInvite | null>(null);
  let pendingRequests = $state<PendingRequest[]>([]);
  let error = $state('');
  let actionBusyKey = $state('');
  let inviteBusy = $state(false);
  let checkingApproval = $state(false);

  let canManage = $derived(Boolean(
    session
      && projection
      && session.status === 'active'
      && projection.active_facets[session.appKeyPubkey]?.capabilities?.can_admin_profile,
  ));

  let keys = $derived<IdentitySettingsKey[]>(projection
    ? Object.values(projection.active_facets).map((facet) => ({
        pubkey: facet.pubkey,
        label: facet.label,
        purposes: facet.purposes,
        capabilities: facet.capabilities,
        addedAt: facet.added_at,
        current: facet.pubkey === session?.appKeyPubkey,
      }))
    : []);

  onMount(() => {
    refreshSession();
  });

  $effect(() => {
    if (!activeInvite) {
      pendingRequests = [];
      return;
    }
    pendingRequests = [];
    const unsubscribe = subscribeDriveDeviceLinkRequests(activeInvite, (requests) => {
      pendingRequests = requests.map((request) => ({
        ...request,
        id: request.id,
        pubkey: request.pubkey,
      }));
    });
    return unsubscribe;
  });

  function refreshSession(): void {
    session = getCurrentIrisIdentitySession();
    if (!session || session.status !== 'active') {
      projection = null;
      return;
    }
    projection = projectIrisProfileRoster(session.profileId, session.rosterOps);
  }

  async function runAction(key: string, action: () => Promise<void>): Promise<void> {
    if (actionBusyKey) return;
    actionBusyKey = key;
    error = '';
    try {
      await action();
      refreshSession();
    } catch (actionError) {
      error = actionError instanceof Error ? actionError.message : 'Identity action failed';
    } finally {
      actionBusyKey = '';
    }
  }

  async function createInvite(): Promise<void> {
    if (inviteBusy) return;
    inviteBusy = true;
    error = '';
    try {
      activeInvite = await createDriveDeviceLinkInvite();
    } catch (inviteError) {
      error = inviteError instanceof Error ? inviteError.message : 'Could not create link';
    } finally {
      inviteBusy = false;
    }
  }

  async function approveRequest(request: IdentitySettingsPendingRequest): Promise<void> {
    const pending = pendingRequests.find((candidate) => candidate.id === request.id);
    if (!pending) return;
    await runAction(`approve:${pending.id}`, async () => {
      await approveDriveDeviceLinkRequest(pending.request);
      pendingRequests = pendingRequests.filter((candidate) => candidate.id !== pending.id);
    });
  }

  async function grantAdmin(key: IdentitySettingsKey): Promise<void> {
    await runAction(`grant-admin:${key.pubkey}`, () => setDriveProfileAppKeyAdmin(key.pubkey, true).then(() => undefined));
  }

  async function revokeAdmin(key: IdentitySettingsKey): Promise<void> {
    await runAction(`revoke-admin:${key.pubkey}`, () => setDriveProfileAppKeyAdmin(key.pubkey, false).then(() => undefined));
  }

  async function removeKey(key: IdentitySettingsKey): Promise<void> {
    await runAction(`remove:${key.pubkey}`, () => removeDriveProfileAppKeyWithAdmin(key.pubkey).then(() => undefined));
  }

  async function checkPendingApproval(): Promise<void> {
    if (checkingApproval) return;
    checkingApproval = true;
    error = '';
    try {
      await activatePendingDriveDeviceLinkIfApproved();
      refreshSession();
    } catch (approvalError) {
      error = approvalError instanceof Error ? approvalError.message : 'Could not check approval';
    } finally {
      checkingApproval = false;
    }
  }
</script>

<div
  class="identity-settings-page space-y-4"
  style="
    --identity-settings-surface: rgb(var(--surface-2));
    --identity-settings-row: rgb(var(--surface-1));
    --identity-settings-border: rgb(var(--surface-3));
    --identity-settings-text: rgb(var(--text-1));
    --identity-settings-muted: rgb(var(--text-3));
    --identity-settings-button: rgb(var(--surface-2));
    --identity-settings-icon-bg: rgb(var(--surface-3));
    --identity-settings-accent: #28a745;
    --identity-settings-success: #28a745;
    --identity-settings-danger: #ff4d4f;
  "
>
  {#if session?.status === 'pending_device_link'}
    <div class="rounded-lg bg-surface-2 p-4" data-testid="identity-pending-link">
      <h3 class="mb-2 text-sm font-semibold text-text-1">Waiting for approval</h3>
      <p class="mb-3 text-sm text-text-3">This key has requested access to the Drive identity.</p>
      <button
        type="button"
        class="btn-success flex w-full items-center justify-center gap-2"
        onclick={checkPendingApproval}
        disabled={checkingApproval}
        data-testid="identity-check-approval"
      >
        {#if checkingApproval}
          <span class="i-lucide-loader-2 animate-spin"></span>
        {:else}
          <span class="i-lucide-refresh-cw"></span>
        {/if}
        <span>Check approval</span>
      </button>
    </div>
  {:else if session && projection}
    <IdentitySettingsPanel
      identityName="Drive identity"
      identityId={session.profileId}
      currentKeyPubkey={session.appKeyPubkey}
      {keys}
      pendingRequests={pendingRequests}
      inviteUrl={activeInvite?.url ?? ''}
      {canManage}
      {inviteBusy}
      {actionBusyKey}
      onCreateInvite={createInvite}
      onApproveRequest={approveRequest}
      onGrantAdmin={grantAdmin}
      onRevokeAdmin={revokeAdmin}
      onRemoveKey={removeKey}
    />
  {:else}
    <div class="rounded-lg bg-surface-2 p-4" data-testid="identity-no-session">
      <h3 class="mb-2 text-sm font-semibold text-text-1">No Drive identity</h3>
      <p class="text-sm text-text-3">Create or add a Drive user to manage identity keys.</p>
    </div>
  {/if}

  {#if error}
    <p class="text-sm font-semibold text-danger" data-testid="identity-settings-error">{error}</p>
  {/if}
</div>
