<script lang="ts">
  /**
   * UsersPage - manage saved accounts
   * Shows list of app accounts, allows Drive user recovery, switching, and removing accounts.
   */
  import { onMount } from 'svelte';
  import IdentityRecoveryPanel from '@iris/svelte-ui/IdentityRecoveryPanel.svelte';
  import type { IdentityRecoveryRequest } from '@iris/svelte-ui';
  import { navigate } from '../utils/navigate';
  import {
    accountsStore,
    getAccountIdentityKey,
    saveActiveAccountToStorage,
    hasNostrExtension,
    type Account,
  } from '../accounts';
  import { createDriveProfile, linkDriveDevice, recoverDriveProfileWithAppKey, restoreSession, waitForNostrExtension } from '../nostr';
  import { parseDeviceLinkInvite } from '../drive/protocol';
  import { driveRootPath, normalizeOwnerNpub } from '../drive/setup';
  import { Avatar, Name } from './User';
  import IdentityName from './User/IdentityName.svelte';
  import { BackButton } from './ui';

  type UsersMode = 'list' | 'existing' | 'no_existing';

  interface Props {
    mode?: UsersMode;
    embedded?: boolean;
    initialDeviceLink?: string;
  }

  let { mode = 'list', embedded = false, initialDeviceLink = '' }: Props = $props();

  // State
  let recoveryError = $state('');
  let recoveryBusy = $state(false);
  let creatingProfile = $state(false);
  let confirmingRemove = $state<string | null>(null); // pubkey of account being removed
  let isExistingMode = $derived(mode === 'existing');
  let isNoExistingMode = $derived(mode === 'no_existing');
  let isSecondaryMode = $derived(isExistingMode || isNoExistingMode);
  let headerTitle = $derived(isNoExistingMode ? 'Create new' : isExistingMode ? 'Sign in' : 'Users');
  let backHref = $derived(isNoExistingMode ? '/users/existing' : '/users');
  let initialRecoveryRequest = $derived<IdentityRecoveryRequest | null>(
    initialDeviceLink.trim()
      ? { method: 'nip46', nip46Connection: initialDeviceLink.trim() }
      : null,
  );

  // Store values
  let accountsState = $derived($accountsStore);
  let accounts = $derived(accountsState.accounts);
  let activeAccountPubkey = $derived(accountsState.activeAccountPubkey);
  let hasExtension = $state(hasNostrExtension());

  // Sort accounts by creation time (oldest first)
  let sortedAccounts = $derived(
    [...accounts].sort((a, b) => a.addedAt - b.addedAt)
  );

  onMount(() => {
    if (hasExtension) return;

    let cancelled = false;

    waitForNostrExtension(5000).then((available) => {
      if (!cancelled) {
        hasExtension = available;
      }
    });

    return () => {
      cancelled = true;
    };
  });

  async function switchToAccount(account: Account) {
    if (account.pubkey === activeAccountPubkey) return;

    // Save as active
    saveActiveAccountToStorage(account.pubkey);
    accountsStore.setActiveAccount(account.pubkey);

    await restoreSession({ autoCreate: false });
  }

  function startRemoveAccount(pubkey: string) {
    confirmingRemove = pubkey;
  }

  function cancelRemoveAccount() {
    confirmingRemove = null;
  }

  function confirmRemoveAccount(pubkey: string) {
    accountsStore.removeAccount(pubkey);
    confirmingRemove = null;
  }

  async function handleGenerateNew() {
    if (creatingProfile) return;
    creatingProfile = true;
    recoveryError = '';
    try {
      const profile = await createDriveProfile();
      navigate(driveRootPath(profile.profileId));
    } catch (error) {
      recoveryError = error instanceof Error ? error.message : 'Profile creation failed';
    } finally {
      creatingProfile = false;
    }
  }

  async function handleRecovery(request: IdentityRecoveryRequest) {
    if (recoveryBusy) return;
    recoveryBusy = true;
    recoveryError = '';
    try {
      const linkInput = request.method === 'nip46' ? request.nip46Connection?.trim() : '';
      if (linkInput) {
        if (parseDeviceLinkInvite(linkInput)) {
          const linked = await linkDriveDevice(linkInput);
          if (!linked) {
            throw new Error('Invalid Drive link');
          }
          navigate('/settings/user');
          return;
        }
        const ownerNpub = normalizeOwnerNpub(linkInput);
        if (ownerNpub) {
          navigate(driveRootPath(ownerNpub));
          return;
        }
      }
      const profile = await recoverDriveProfileWithAppKey({
        recovery: request,
      });
      navigate(driveRootPath(profile.session.profileId));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Recovery failed';
      if (isRecoveryIdentityMiss(message)) {
        navigate('/users/no_existing');
        return;
      }
      recoveryError = message;
    } finally {
      recoveryBusy = false;
    }
  }

  function handleRecoveryMethodChange() {
    recoveryError = '';
  }

  function shouldAutoSubmitRecoveryRequest(request: IdentityRecoveryRequest): boolean {
    const linkInput = request.method === 'nip46' ? request.nip46Connection?.trim() : '';
    if (!linkInput) return false;
    return Boolean(parseDeviceLinkInvite(linkInput) || normalizeOwnerNpub(linkInput));
  }

  function isRecoveryIdentityMiss(message: string): boolean {
    return message.includes('No Drive user found')
      || message.includes('No Drive identity found')
      || message.includes('No identity roster events found');
  }
</script>

<div class={embedded ? 'w-full' : 'flex-1 flex flex-col min-h-0 bg-surface-0 p-6 max-w-2xl mx-auto w-full'}>
  <!-- Header -->
  {#if !embedded || isSecondaryMode}
  <div class="flex items-center gap-4 mb-6">
    {#if isSecondaryMode}
      <button
        type="button"
        class="btn-circle btn-ghost shrink-0"
        aria-label="Back to users"
        title="Back"
        onclick={() => navigate(backHref)}
        disabled={recoveryBusy || creatingProfile}
        data-testid="back-to-profile-actions"
      >
        <span class="i-lucide-arrow-left"></span>
      </button>
      <h1 class="text-xl font-semibold">{headerTitle}</h1>
    {:else}
      <BackButton href="/" />
      <h1 class="text-xl font-semibold">Users</h1>
    {/if}
  </div>
  {/if}

  {#if isExistingMode}
    <div class="identity-recovery-shell bg-surface-1 rounded-lg p-4 space-y-3" data-testid="identity-recovery-section">
      <IdentityRecoveryPanel
        methodLayout="column"
        disabled={recoveryBusy || creatingProfile}
        error={recoveryError}
        submitLabel="Continue"
        nostrAvailable={hasExtension}
        showNip46Relay={false}
        initialRequest={initialRecoveryRequest}
        autoSubmitInitial={Boolean(initialRecoveryRequest)}
        shouldAutoSubmit={shouldAutoSubmitRecoveryRequest}
        onMethodChange={handleRecoveryMethodChange}
        onSubmit={handleRecovery}
      />
    </div>
  {:else if isNoExistingMode}
    <div class="identity-recovery-shell bg-surface-1 rounded-lg p-4 space-y-3" data-testid="identity-recovery-create-screen">
      <IdentityRecoveryPanel
        methodLayout="column"
        disabled={recoveryBusy || creatingProfile}
        showCreateNew={true}
        showNip46Relay={false}
        createNewTitle="No existing Drive user found for that key"
        createNewLabel="Create new"
        createNewBusy={creatingProfile}
        createNewDisabled={recoveryBusy || creatingProfile}
        createNewTestId="create-new-after-recovery-miss"
        onCreateNew={handleGenerateNew}
        onCreateNewBack={() => navigate('/users/existing')}
      />
    </div>
  {:else}
    <!-- Account list -->
    <div class="space-y-3 mb-6">
      {#each sortedAccounts as account (getAccountIdentityKey(account))}
        {@const isActive = account.pubkey === activeAccountPubkey}
        {@const isConfirming = confirmingRemove === account.pubkey}
        <div
          class="rounded-lg p-4 flex items-center gap-3 cursor-pointer transition-colors {isActive ? 'bg-surface-2' : 'bg-surface-1 hover:bg-surface-2'}"
          onclick={() => !isConfirming && switchToAccount(account)}
          role="button"
          tabindex="0"
          onkeypress={(e) => e.key === 'Enter' && !isConfirming && switchToAccount(account)}
          data-testid="account-item"
        >
          <!-- Avatar -->
          <a
            href={account.nostrIdentityId ? `#${driveRootPath(account.nostrIdentityId)}` : `#/${account.npub}/profile`}
            class="shrink-0"
            onclick={(e) => e.stopPropagation()}
          >
            <Avatar pubkey={account.pubkey} size={40} />
          </a>

          <!-- Info -->
          <div class="flex-1 min-w-0">
            <div class="font-medium truncate">
              {#if account.nostrIdentityId}
                <IdentityName profileId={account.nostrIdentityId} appKeyPubkey={account.pubkey} />
              {:else}
                <Name pubkey={account.pubkey} />
              {/if}
            </div>
            {#if account.nostrIdentityId}
              <div class="text-xs text-text-3 truncate">Drive user</div>
            {/if}
          </div>

          <!-- Active indicator or actions -->
          <div class="shrink-0 flex items-center gap-2">
            {#if isActive}
              <span class="i-lucide-check-circle text-success text-lg"></span>
            {/if}

            {#if accounts.length > 1}
              {#if isConfirming}
                <button
                  onclick={(e) => { e.stopPropagation(); confirmRemoveAccount(account.pubkey); }}
                  class="btn-danger text-sm"
                >
                  Remove
                </button>
                <button
                  onclick={(e) => { e.stopPropagation(); cancelRemoveAccount(); }}
                  class="btn-ghost text-sm"
                >
                  Cancel
                </button>
              {:else}
                <button
                  onclick={(e) => { e.stopPropagation(); startRemoveAccount(account.pubkey); }}
                  class="btn-ghost text-danger"
                  title="Remove account"
                >
                  <span class="i-lucide-trash-2"></span>
                </button>
              {/if}
            {/if}
          </div>
        </div>
      {/each}
    </div>

    <!-- Add account section -->
    <div class="space-y-3">
      <button
        onclick={handleGenerateNew}
        class="btn-success w-full justify-center"
        data-testid="generate-new-account"
        disabled={creatingProfile}
      >
        {#if creatingProfile}
          <span class="i-lucide-loader-2 animate-spin"></span>
        {:else}
          <span class="i-lucide-plus"></span>
        {/if}
        Create new
      </button>

      <button
        type="button"
        onclick={() => navigate('/users/existing')}
        class="btn-ghost w-full justify-center border border-surface-3"
        data-testid="add-existing-profile"
        disabled={creatingProfile}
      >
        <span class="i-lucide-key-round"></span>
        Add existing
      </button>
    </div>
  {/if}
</div>

<style>
  .identity-recovery-shell {
    --accent: #28a745;
    --accent-contrast: #fff;
    --control-bg: rgb(var(--surface-2));
    --control-hover: rgb(var(--surface-3));
    --control-border: rgb(var(--surface-3));
    --control-selected-bg: color-mix(in srgb, var(--accent) 18%, rgb(var(--surface-2)));
    --danger-text: #ff4d4f;
    --line: rgb(var(--surface-3));
    --surface-raised: rgb(var(--surface-0));
    --text: rgb(var(--text-1));
    --text-muted: rgb(var(--text-2));
  }

  .identity-recovery-shell :global(.recovery-methods) {
    grid-template-columns: minmax(0, 1fr);
  }
</style>
