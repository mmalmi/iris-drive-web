<script lang="ts">
  import { onMount } from 'svelte';
  import QRCode from 'qrcode';
  import UserSettingsPanel from '@iris/svelte-ui/UserSettingsPanel.svelte';
  import type { UserSettingsKey, UserSettingsPendingRequest } from '@iris/svelte-ui/userSettings';
  import {
    activatePendingDriveDeviceLinkIfApproved,
    approveDriveDeviceLinkRequest,
    approveDriveDeviceApprovalRequest,
    createDriveDeviceLinkInvite,
    getCurrentNostrIdentitySession,
    loadDriveDeviceLabels,
    parseDriveDeviceApprovalRequestInput,
    removeDriveProfileAppKeyWithAdmin,
    restoreSession,
    setDriveProfileAppKeyAdmin,
    subscribeDriveDeviceLinkRequests,
    type DriveDeviceLinkInvite,
    type DriveDeviceLinkRequest,
  } from '../../nostr';
  import { projectNostrIdentityRoster, type NostrIdentitySession, type NostrIdentityRosterProjection } from '../../drive/protocol';
  import {
    readStoredDeviceLinkInvite,
    saveStoredDeviceLinkInvite,
  } from './deviceLinkInvites';
  import { appStore } from '../../store';
  import { currentBrowserDeviceLabel } from '../../drive/deviceLabels';
  import QRScanner from '../QRScanner.svelte';

  type PendingRequest = UserSettingsPendingRequest & DriveDeviceLinkRequest;

  let session = $state<NostrIdentitySession | null>(null);
  let projection = $state<NostrIdentityRosterProjection | null>(null);
  let activeInvite = $state<DriveDeviceLinkInvite | null>(null);
  let inviteQrUrl = $state('');
  let pendingRequests = $state<PendingRequest[]>([]);
  let deviceLabels = $state<Record<string, string>>({});
  let approvalInput = $state('');
  let showApprovalScanner = $state(false);
  let error = $state('');
  let actionBusyKey = $state('');
  let inviteBusy = $state(false);
  let approvalBusy = $state(false);
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
        label: deviceLabelForKey(facet.pubkey),
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

  $effect(() => {
    if (session?.status !== 'pending_device_link') return;
    let cancelled = false;
    const timer = setInterval(() => {
      if (!cancelled) void checkPendingApproval();
    }, 3000);
    void checkPendingApproval();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  });

  function refreshSession(): void {
    session = getCurrentNostrIdentitySession();
    if (!session || session.status !== 'active') {
      projection = null;
      activeInvite = null;
      deviceLabels = {};
      return;
    }
    const nextProjection = projectNostrIdentityRoster(session.profileId, session.rosterOps);
    projection = nextProjection;
    void refreshDeviceLabels(session);
    pendingRequests = visiblePendingRequests(pendingRequests, nextProjection);
    const currentCanManage = Boolean(nextProjection.active_facets[session.appKeyPubkey]?.capabilities?.can_admin_profile);
    if (!currentCanManage) {
      activeInvite = null;
      return;
    }
    if (activeInvite?.profileId === session.profileId && activeInvite.adminAppKeyPubkey === session.appKeyPubkey) return;
    activeInvite = readStoredDeviceLinkInvite(session.profileId, session.appKeyPubkey);
  }

  function deviceLabelForKey(pubkey: string): string | undefined {
    const privateLabel = deviceLabels[pubkey]?.trim();
    if (privateLabel) return privateLabel;
    if (pubkey !== session?.appKeyPubkey) return undefined;
    const sessionLabel = session.label?.trim();
    if (sessionLabel) return sessionLabel;
    return currentBrowserDeviceLabel();
  }

  async function refreshDeviceLabels(labelSession: NostrIdentitySession): Promise<void> {
    const profileId = labelSession.profileId;
    const appKeyPubkey = labelSession.appKeyPubkey;
    try {
      const labels = await loadDriveDeviceLabels();
      if (session?.profileId === profileId && session.appKeyPubkey === appKeyPubkey) {
        deviceLabels = labels;
      }
    } catch (labelError) {
      console.warn('[UserSettings] Could not load encrypted Drive device labels:', labelError);
    }
  }

  async function restoreUserSession(): Promise<void> {
    error = '';
    try {
      if (!getCurrentNostrIdentitySession()) {
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

  async function resetInvite(): Promise<void> {
    await createInvite();
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
    rosterProjection: NostrIdentityRosterProjection | null = projection,
  ): PendingRequest[] {
    if (!rosterProjection) return requests;
    return requests.filter((request) => !rosterProjection.active_facets[request.pubkey]);
  }

  async function approveApprovalInput(input = approvalInput): Promise<void> {
    if (approvalBusy) return;
    const request = parseDriveDeviceApprovalRequestInput(input);
    if (!request) {
      error = 'Scan or paste a Drive device approval QR';
      return;
    }
    approvalBusy = true;
    error = '';
    try {
      await approveDriveDeviceApprovalRequest(request);
      approvalInput = '';
      refreshSession();
    } catch (approvalError) {
      error = approvalError instanceof Error ? approvalError.message : 'Could not approve device';
    } finally {
      approvalBusy = false;
    }
  }

  function handleApprovalScan(result: string): void {
    showApprovalScanner = false;
    approvalInput = result;
    void approveApprovalInput(result);
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
    {#if canManage}
      <section class="rounded-lg bg-surface-2 p-4 space-y-3" data-testid="device-approval-section">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-sm font-semibold text-text-1">Approve device</h3>
          <button
            type="button"
            class="btn-ghost flex items-center gap-2 text-sm"
            onclick={() => (showApprovalScanner = true)}
            disabled={approvalBusy}
            data-testid="scan-device-approval"
          >
            <span class="i-lucide-scan-line"></span>
            <span>Scan</span>
          </button>
        </div>
        <div class="flex flex-col gap-2 sm:flex-row">
          <input
            class="min-w-0 flex-1 rounded-lg border border-surface-3 bg-surface-1 px-3 py-2 text-sm text-text-1 outline-none focus:border-accent"
            type="text"
            value={approvalInput}
            placeholder="https://drive.iris.to/approve-device/..."
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            disabled={approvalBusy}
            aria-label="Device approval request"
            data-testid="device-approval-input"
            oninput={(event) => (approvalInput = (event.currentTarget as HTMLInputElement).value)}
          />
          <button
            type="button"
            class="btn-success flex items-center justify-center gap-2 text-sm"
            onclick={() => approveApprovalInput()}
            disabled={approvalBusy || !approvalInput.trim()}
            data-testid="approve-device-request"
          >
            {#if approvalBusy}
              <span class="i-lucide-loader-2 animate-spin"></span>
            {:else}
              <span class="i-lucide-check"></span>
            {/if}
            <span>Approve</span>
          </button>
        </div>
      </section>
    {/if}

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
      onResetInvite={resetInvite}
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

  {#if showApprovalScanner}
    <QRScanner
      onScanSuccess={handleApprovalScan}
      onClose={() => (showApprovalScanner = false)}
    />
  {/if}
</div>
