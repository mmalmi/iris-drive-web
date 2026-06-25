<script lang="ts">
  import { onMount } from 'svelte';
  import QRCode from 'qrcode';
  import UserSettingsPanel from '@iris/svelte-ui/UserSettingsPanel.svelte';
  import type { UserSettingsKey, UserSettingsPendingRequest } from '@iris/svelte-ui/userSettings';
  import {
    activatePendingDriveDeviceLinkIfApproved,
    approveDriveDeviceLinkRequest,
    createDriveDeviceLinkInvite,
    getCurrentIrisIdentitySession,
    removeDriveProfileAppKeyWithAdmin,
    restoreSession,
    setDriveProfileAppKeyAdmin,
    subscribeDriveDeviceLinkRequests,
    type DriveDeviceLinkInvite,
    type DriveDeviceLinkRequest,
  } from '../../nostr';
  import { projectIrisProfileRoster, type IrisIdentitySession, type IrisProfileRosterProjection } from '../../drive/protocol';
  import {
    readStoredDeviceLinkInvite,
    saveStoredDeviceLinkInvite,
  } from './deviceLinkInvites';
  import { appStore } from '../../store';

  type PendingRequest = UserSettingsPendingRequest & DriveDeviceLinkRequest;

  let session = $state<IrisIdentitySession | null>(null);
  let projection = $state<IrisProfileRosterProjection | null>(null);
  let activeInvite = $state<DriveDeviceLinkInvite | null>(null);
  let inviteQrUrl = $state('');
  let pendingRequests = $state<PendingRequest[]>([]);
  let error = $state('');
  let actionBusyKey = $state('');
  let inviteBusy = $state(false);
  let checkingApproval = $state(false);
  let restoring = $state(true);

  let canManage = $derived(Boolean(
    session
      && projection
      && session.status === 'active'
      && projection.active_facets[session.appKeyPubkey]?.capabilities?.can_admin_profile,
  ));

  let connectedDevicePubkeys = $derived(new Set(
    $appStore.peers
      .filter((peer) => peer.state === 'connected')
      .map((peer) => peer.pubkey),
  ));

  let keys = $derived<UserSettingsKey[]>(projection
    ? Object.values(projection.active_facets).map((facet) => ({
        pubkey: facet.pubkey,
        label: facet.label,
        purposes: facet.purposes,
        capabilities: facet.capabilities,
        addedAt: facet.added_at,
        current: facet.pubkey === session?.appKeyPubkey,
        online: facet.pubkey === session?.appKeyPubkey || connectedDevicePubkeys.has(facet.pubkey),
      }))
    : []);

  onMount(() => {
    let cancelled = false;
    void restoreUserSession().finally(() => {
      if (!cancelled) restoring = false;
    });
    return () => {
      cancelled = true;
    };
  });

  $effect(() => {
    if (!session || session.status !== 'active' || !canManage || !activeInvite) {
      pendingRequests = [];
      return;
    }
    pendingRequests = [];
    const unsubscribe = subscribeDriveDeviceLinkRequests(activeInvite, (requests) => {
      pendingRequests = visiblePendingRequests(requests.map((request) => ({
        ...request,
        id: request.id,
        pubkey: request.pubkey,
      })));
    });
    return unsubscribe;
  });

  $effect(() => {
    const invite = activeInvite;
    if (!invite) {
      inviteQrUrl = '';
      return;
    }
    let cancelled = false;
    QRCode.toDataURL(invite.url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 6,
      color: {
        dark: '#111111',
        light: '#ffffff',
      },
    }).then((url) => {
      if (!cancelled) inviteQrUrl = url;
    }).catch(() => {
      if (!cancelled) inviteQrUrl = '';
    });
    return () => {
      cancelled = true;
    };
  });

  function refreshSession(): void {
    session = getCurrentIrisIdentitySession();
    if (!session || session.status !== 'active') {
      projection = null;
      activeInvite = null;
      return;
    }
    const nextProjection = projectIrisProfileRoster(session.profileId, session.rosterOps);
    projection = nextProjection;
    pendingRequests = visiblePendingRequests(pendingRequests, nextProjection);
    const currentCanManage = Boolean(nextProjection.active_facets[session.appKeyPubkey]?.capabilities?.can_admin_profile);
    if (!currentCanManage) {
      activeInvite = null;
      return;
    }
    if (activeInvite?.profileId === session.profileId && activeInvite.adminAppKeyPubkey === session.appKeyPubkey) return;
    activeInvite = readStoredDeviceLinkInvite(session.profileId, session.appKeyPubkey);
  }

  async function restoreUserSession(): Promise<void> {
    error = '';
    try {
      if (!getCurrentIrisIdentitySession()) {
        await restoreSession({ autoCreate: false });
      }
    } catch (restoreError) {
      console.warn('[UserSettings] Could not restore Drive user session:', restoreError);
    } finally {
      refreshSession();
    }
  }

  async function runAction(key: string, action: () => Promise<void>): Promise<void> {
    if (actionBusyKey) return;
    actionBusyKey = key;
    error = '';
    try {
      await action();
      refreshSession();
    } catch (actionError) {
      error = actionError instanceof Error ? actionError.message : 'User action failed';
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
      saveStoredDeviceLinkInvite(activeInvite);
    } catch (inviteError) {
      error = inviteError instanceof Error ? inviteError.message : 'Could not prepare device invite';
    } finally {
      inviteBusy = false;
    }
  }

  async function approveRequest(request: UserSettingsPendingRequest): Promise<void> {
    const pending = pendingRequests.find((candidate) => candidate.id === request.id);
    if (!pending) return;
    await runAction(`approve:${pending.id}`, async () => {
      await approveDriveDeviceLinkRequest(pending.request);
      pendingRequests = pendingRequests.filter((candidate) => candidate.pubkey !== pending.pubkey);
      refreshSession();
    });
  }

  function visiblePendingRequests(
    requests: PendingRequest[],
    rosterProjection: IrisProfileRosterProjection | null = projection,
  ): PendingRequest[] {
    if (!rosterProjection) return requests;
    return requests.filter((request) => !rosterProjection.active_facets[request.pubkey]);
  }

  async function grantAdmin(key: UserSettingsKey): Promise<void> {
    await runAction(`grant-admin:${key.pubkey}`, () => setDriveProfileAppKeyAdmin(key.pubkey, true).then(() => undefined));
  }

  async function revokeAdmin(key: UserSettingsKey): Promise<void> {
    await runAction(`revoke-admin:${key.pubkey}`, () => setDriveProfileAppKeyAdmin(key.pubkey, false).then(() => undefined));
  }

  async function removeKey(key: UserSettingsKey): Promise<void> {
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
  class="user-settings-page space-y-4"
  style="
    --user-settings-surface: rgb(var(--surface-2));
    --user-settings-row: rgb(var(--surface-1));
    --user-settings-border: rgb(var(--surface-3));
    --user-settings-text: rgb(var(--text-1));
    --user-settings-muted: rgb(var(--text-3));
    --user-settings-button: rgb(var(--surface-2));
    --user-settings-icon-bg: rgb(var(--surface-3));
    --user-settings-accent: #28a745;
    --user-settings-success: #28a745;
    --user-settings-danger: #ff4d4f;
  "
>
  {#if restoring}
    <div class="rounded-lg bg-surface-2 p-4" data-testid="user-settings-loading">
      <h3 class="mb-2 text-sm font-semibold text-text-1">Loading devices</h3>
    </div>
  {:else if session?.status === 'pending_device_link'}
    <div class="rounded-lg bg-surface-2 p-4" data-testid="user-pending-link">
      <h3 class="mb-2 text-sm font-semibold text-text-1">Waiting for approval</h3>
      <p class="mb-3 text-sm text-text-3">This device has requested access to Drive.</p>
      <button
        type="button"
        class="btn-success flex w-full items-center justify-center gap-2"
        onclick={checkPendingApproval}
        disabled={checkingApproval}
        data-testid="user-check-approval"
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
    <UserSettingsPanel
      {keys}
      pendingRequests={pendingRequests}
      inviteUrl={activeInvite?.url ?? ''}
      inviteQrUrl={inviteQrUrl}
      {canManage}
      showSummary={false}
      showDevicesHeading={false}
      keyBadgeMode="admin"
      {inviteBusy}
      {actionBusyKey}
      onCreateInvite={createInvite}
      onApproveRequest={approveRequest}
      onGrantAdmin={grantAdmin}
      onRevokeAdmin={revokeAdmin}
      onRemoveKey={removeKey}
    />
  {:else}
    <div class="rounded-lg bg-surface-2 p-4" data-testid="user-no-session">
      <h3 class="mb-2 text-sm font-semibold text-text-1">No devices</h3>
      <p class="text-sm text-text-3">Create or link Drive to manage devices.</p>
    </div>
  {/if}

  {#if error}
    <p class="text-sm font-semibold text-danger" data-testid="user-settings-error">{error}</p>
  {/if}
</div>
